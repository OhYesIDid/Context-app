import type { BookingContext, BookingItem, BookingType } from '../types';
import { getAccessToken } from './googleAuth';

const REQUEST_TIMEOUT_MS = 15_000;

function classifyBooking(subject: string, from: string): BookingType {
  const s = (subject + ' ' + from).toLowerCase();
  if (/flight|airline|airways|boarding pass|easyjet|ryanair|ba\.com|lufthansa|heathrow|gatwick/.test(s)) return 'flight';
  if (/hotel|inn|resort|airbnb|booking\.com|hotels\.com|marriott|hilton|check.?in|accommodation/.test(s)) return 'hotel';
  if (/train|rail|eurostar|tfl|gwr|avanti|lner|crosscountry|c2c|southeastern/.test(s)) return 'train';
  if (/delivery|dispatch|shipped|tracking|out for delivery|amazon|ups|fedex|evri|hermes|royal mail|dpd/.test(s)) return 'delivery';
  if (/restaurant|reservation|opentable|resy|sevenrooms/.test(s)) return 'restaurant';
  if (/ticket|event|concert|theatre|theater|cinema|eventbrite/.test(s)) return 'event';
  return 'other';
}

function parseEmailDate(raw: string): string {
  try {
    return new Date(raw).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export async function getBookingsContext(lookbackDays = 30): Promise<BookingContext> {
  const accessToken = await getAccessToken();

  const windowEnd = new Date();
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - lookbackDays);

  const query = `(category:travel OR category:purchases) newer_than:${lookbackDays}d`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=15`,
      { signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (listRes.status === 401 || listRes.status === 403) {
      throw new Error('Gmail access not granted. Please sign out and sign in again to allow booking lookups.');
    }
    if (!listRes.ok) {
      throw new Error(`Gmail API error ${listRes.status}`);
    }

    const listData = await listRes.json() as { messages?: { id: string }[] };
    const messages = listData.messages ?? [];

    const items: BookingItem[] = await Promise.all(
      messages.slice(0, 10).map(async ({ id }) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
          `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const msg = await msgRes.json() as {
          snippet?: string;
          payload?: { headers?: { name: string; value: string }[] };
        };
        const headers = msg.payload?.headers ?? [];
        const get = (name: string) => headers.find((h) => h.name === name)?.value ?? '';
        const subject = get('Subject');
        const from = get('From');
        return {
          id,
          type: classifyBooking(subject, from),
          subject,
          snippet: msg.snippet ?? '',
          from,
          date: parseEmailDate(get('Date')),
        };
      })
    );

    return { items, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Bookings request timed out — check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
