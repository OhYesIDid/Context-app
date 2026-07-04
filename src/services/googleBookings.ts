import type { BookingContext, BookingItem, BookingType } from '../types';
import { getAccessToken, invalidateToken } from './googleAuth';

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

// ── Travel date extraction ─────────────────────────────────────────────────
// Best-effort: airline/hotel/train confirmations phrase dates wildly
// differently, so this is a heuristic, not a guarantee. Keyword-adjacent
// matches are trusted over bare full-text scans.

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_ALT = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

const DATE_PATTERNS = [
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?,?\\s*(\\d{4})?`, 'gi'),
  new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, 'gi'),
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
];

const TRAVEL_KEYWORDS = /depart(?:ure|ing)?|check[- ]?in|arriv(?:al|ing)|outbound|boarding|travel date|flight date|date of travel|estimated delivery/gi;

function buildDate(year: number | undefined, month: number, day: number, reference: Date): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  if (year) return new Date(year, month, day, 12, 0, 0);
  // No year in the text — assume this year, but roll to next year if that's
  // more than a few days in the past (email is dated relative to "now").
  const guess = new Date(reference.getFullYear(), month, day, 12, 0, 0);
  const graceCutoff = new Date(reference);
  graceCutoff.setDate(graceCutoff.getDate() - 3);
  return guess < graceCutoff ? new Date(reference.getFullYear() + 1, month, day, 12, 0, 0) : guess;
}

function findDatesInText(text: string, reference: Date): Date[] {
  const dates: Date[] = [];

  for (const m of text.matchAll(DATE_PATTERNS[0])) {
    const day = parseInt(m[1], 10);
    const month = MONTH_INDEX[m[2].toLowerCase().slice(0, 3)];
    const d = buildDate(m[3] ? parseInt(m[3], 10) : undefined, month, day, reference);
    if (d) dates.push(d);
  }
  for (const m of text.matchAll(DATE_PATTERNS[1])) {
    const month = MONTH_INDEX[m[1].toLowerCase().slice(0, 3)];
    const day = parseInt(m[2], 10);
    const d = buildDate(m[3] ? parseInt(m[3], 10) : undefined, month, day, reference);
    if (d) dates.push(d);
  }
  for (const m of text.matchAll(DATE_PATTERNS[2])) {
    const d = buildDate(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), reference);
    if (d) dates.push(d);
  }
  return dates;
}

/** Extracts the most likely travel/event date from free text (subject, snippet, or full body). */
export function extractTravelDate(text: string, reference: Date = new Date()): string | null {
  const scoped = text.slice(0, 20_000);

  const nearKeywords: Date[] = [];
  for (const m of scoped.matchAll(TRAVEL_KEYWORDS)) {
    const start = m.index ?? 0;
    nearKeywords.push(...findDatesInText(scoped.slice(start, start + 60), reference));
  }

  const candidates = nearKeywords.length > 0 ? nearKeywords : findDatesInText(scoped, reference);
  if (candidates.length === 0) return null;

  const past = new Date(reference); past.setDate(past.getDate() - 1);
  const future = new Date(reference); future.setDate(future.getDate() + 730);
  const inRange = candidates.filter((d) => d >= past && d <= future).sort((a, b) => a.getTime() - b.getTime());

  const best = inRange[0] ?? [...candidates].sort((a, b) => a.getTime() - b.getTime())[0];
  return best ? best.toISOString() : null;
}

// ── Gmail body extraction ──────────────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function base64UrlDecode(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const char of base64) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
}

function findPartData(part: GmailPart, mime: string): string | null {
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPartData(child, mime);
      if (found) return found;
    }
  }
  return null;
}

function extractBodyText(payload: GmailPart | undefined): string {
  if (!payload) return '';
  const plain = findPartData(payload, 'text/plain');
  if (plain) return base64UrlDecode(plain);
  const html = findPartData(payload, 'text/html');
  if (html) return stripHtml(base64UrlDecode(html));
  if (payload.body?.data) return base64UrlDecode(payload.body.data);
  return '';
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

    if (listRes.status === 401) { invalidateToken(); throw new Error('Gmail access token expired. Please sign out and sign in again.'); }
    if (listRes.status === 403) {
      throw new Error('Gmail access not granted. Please sign out and sign in again to allow booking lookups.');
    }
    if (!listRes.ok) {
      throw new Error(`Gmail API error ${listRes.status}`);
    }

    const listData = await listRes.json() as { messages?: { id: string }[] };
    const messages = listData.messages ?? [];
    const now = new Date();

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
        const snippet = msg.snippet ?? '';

        // Cheap first pass: subject + snippet often already contain the date
        // (airlines routinely put it in the subject line). Only pay for a
        // full-body fetch when that comes up empty.
        let travelDate = extractTravelDate(`${subject} ${snippet}`, now) ?? undefined;
        if (!travelDate) {
          try {
            const fullRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const full = await fullRes.json() as { payload?: GmailPart };
            const bodyText = extractBodyText(full.payload);
            travelDate = extractTravelDate(bodyText, now) ?? undefined;
          } catch {
            // Best-effort — fall back to no travel date rather than failing the whole booking.
          }
        }

        return {
          id,
          type: classifyBooking(subject, from),
          subject,
          snippet,
          from,
          date: parseEmailDate(get('Date')),
          travelDate,
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
