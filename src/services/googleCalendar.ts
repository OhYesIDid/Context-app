import type { AvailabilityData, CalendarEvent } from '../types';
import { getAccessToken, invalidateToken } from './googleAuth';

const CALENDAR_ID = process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ID ?? 'primary';
const REQUEST_TIMEOUT_MS = 15_000;

// Extracts a specific event name from lookup-style messages.
// Returns null for availability queries ("are you free Friday?").
function extractEventKeyword(message: string): string | null {
  const patterns = [
    /when (?:is|are)(?: my| the| our)? (.+?)(?:\?|$)/i,
    /what (?:day|time|date) (?:is|are)(?: my| the| our)? (.+?)(?:\?|$)/i,
    /what (?:is|are) the (?:day|time|date) (?:of|for)(?: my| the| our)? (.+?)(?:\?|$)/i,
    /remind me (?:about|of)(?: my| the)? (.+?)(?:\?|$)/i,
  ];
  for (const re of patterns) {
    const match = re.exec(message);
    const kw = match?.[1]?.trim();
    if (kw && kw.length > 1 && kw.length < 50) return kw;
  }
  return null;
}

// Strips possessives and stopwords to get the most distinctive search term.
// "Irina's bday" → "Irina",  "the dentist appointment" → "dentist"
function extractSearchTerm(keyword: string): string {
  const stopwords = new Set(['my', 'the', 'a', 'an', 'our', 'your', 'his', 'her', 'their', 'its']);
  const words = keyword.split(/\s+/);
  const word = words.find(w => !stopwords.has(w.toLowerCase().replace(/'s$/i, ''))) ?? words[0];
  return word.replace(/'s$/i, '');
}

async function fetchEvents(
  accessToken: string,
  windowStart: Date,
  windowEnd: Date,
  maxResults: number,
  q?: string,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });
  if (q) params.set('q', q);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
      { signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (res.status === 401) { invalidateToken(); throw new Error('Calendar access token expired. Please sign out and sign in again.'); }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Google Calendar error: ${err?.error?.message ?? res.statusText}`);
    }
    const data = await res.json();
    const items = (data.items ?? []) as Array<{
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
    return items.map((item) => ({
      summary: item.summary ?? '(No title)',
      start: item.start?.dateTime ?? item.start?.date ?? '',
      end: item.end?.dateTime ?? item.end?.date ?? '',
      allDay: !item.start?.dateTime,
    }));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError')
      throw new Error('Calendar request timed out — check your connection and try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches calendar data in one of two modes:
//   event-lookup  — keyword found → q=<name>, 14d back + 90d forward
//                   if 0 results  → fallback: no q, same range, maxResults 30
//   availability  — no keyword    → no q, today + 7d, maxResults 50
export async function getCalendarData(message: string): Promise<AvailabilityData> {
  const accessToken = await getAccessToken();
  const keyword = extractEventKeyword(message);

  const now = new Date();
  const windowStart = new Date(now);
  const windowEnd = new Date(now);

  if (keyword) {
    windowStart.setDate(now.getDate() - 14);
    windowEnd.setDate(now.getDate() + 90);
    const searchTerm = extractSearchTerm(keyword);
    let events = await fetchEvents(accessToken, windowStart, windowEnd, 10, searchTerm);
    if (events.length === 0) {
      events = await fetchEvents(accessToken, windowStart, windowEnd, 30);
    }
    return { events, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
  } else {
    windowStart.setHours(0, 0, 0, 0);
    windowEnd.setDate(now.getDate() + 7);
    const events = await fetchEvents(accessToken, windowStart, windowEnd, 50);
    return { events, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
  }
}
