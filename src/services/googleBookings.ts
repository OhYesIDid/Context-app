import type { BookingContext, BookingItem, BookingType } from '../types';
import { getAccessToken, invalidateToken } from './googleAuth';

// 25s (was 15s): the full-body fallback fetch adds a second, larger sequential
// round-trip for any message where subject/snippet don't confidently resolve a
// date — the whole getBookingsContext call shares this one timeout budget.
const REQUEST_TIMEOUT_MS = 25_000;

function classifyBooking(subject: string, from: string): BookingType {
  // A reply/forward carries quoted history from the original thread, which
  // confuses date extraction, and isn't itself a fresh confirmation.
  if (/^\s*(re|fwd?)\s*:/i.test(subject)) return 'other';

  const s = (subject + ' ' + from).toLowerCase();

  // A cancelled booking isn't upcoming travel regardless of type.
  if (/cancell?ed/.test(s)) return 'other';

  if (/flight|airline|airways|boarding pass|easyjet|ryanair|ba\.com|lufthansa|heathrow|gatwick/.test(s)) return 'flight';

  // Airbnb host-side notifications (about someone else's stay at the user's
  // own listed room) share every keyword a genuine hotel confirmation has
  // ("airbnb", "reservation") — exclude the host-facing phrasing Airbnb
  // actually sends before falling through to the generic hotel match, so a
  // guest booking the user's spare room doesn't get treated as the user's
  // own upcoming trip.
  if (/reservation reminder|guests? (?:are|is) waiting|we sent a payout|write a review for|has written you a review|refer a host|enquiry for|new (?:reservation|booking) request|you have a new (?:reservation|booking)/.test(s)) return 'other';

  if (/hotel|inn|resort|airbnb|booking\.com|hotels\.com|marriott|hilton|check.?in|accommodation/.test(s)) return 'hotel';
  if (/train|rail|eurostar|tfl|gwr|avanti|lner|crosscountry|c2c|southeastern/.test(s)) return 'train';
  if (/delivery|dispatch|shipped|tracking|out for delivery|amazon|ups|fedex|evri|hermes|royal mail|dpd/.test(s)) return 'delivery';
  if (/restaurant|reservation|opentable|resy|sevenrooms/.test(s)) return 'restaurant';
  // Named ticketing vendors only — bare words like "ticket"/"event"/"concert"
  // match any promotional email that mentions them (a venue's marketing
  // blast, a "big event this weekend" newsletter), not just real bookings.
  if (/eventbrite|ticketmaster|seetickets|see tickets|ticketek|dice\.fm|songkick|gigantic\.com|skiddle|wegottickets|fatsoma|axs\.com/.test(s)) return 'event';
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
  new RegExp(`\\b(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?,?\\s*(\\d{4})?`, 'gi'),
  // (?!\d) after the day group stops a bare "Month YYYY" mention (no day
  // present) from being misparsed as day=<first 2 digits of the year> — e.g.
  // "August 2026" would otherwise match as day 20, year undefined.
  new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, 'gi'),
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
];

// Excludes "online check-in" / "check-in available" phrasing — airline
// confirmation emails routinely mention when the *online check-in window*
// opens (usually the day before departure), which is not the travel date
// and was corrupting extraction whenever an email had both a real "check-in"
// mention (hotel) or "Departing"/"Arrival" label AND this airline-specific
// self-service phrasing.
const TRAVEL_KEYWORDS = /depart(?:ure|ing)?|(?<!online )check[- ]?in(?!\s+available)|arriv(?:al|ing)|outbound|boarding|travel date|flight date|date of travel|estimated delivery/gi;

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

// HTML emails routinely put far more markup between a label like "Departing"
// and its actual value than a hand-typed test string would — measured against
// a real flight confirmation, tag-stripped distances landed at 69-166 chars
// for genuinely related keyword/date pairs (vs. 300-900 for unrelated
// instructional text mentioning "check-in" elsewhere in the email).
const KEYWORD_WINDOW = 180;

function nearestKeywordDates(scoped: string, reference: Date): Date[] {
  const dates: Date[] = [];
  for (const m of scoped.matchAll(TRAVEL_KEYWORDS)) {
    const start = m.index ?? 0;
    dates.push(...findDatesInText(scoped.slice(start, start + KEYWORD_WINDOW), reference));
  }
  return dates;
}

function pickBestDate(candidates: Date[], reference: Date): string | null {
  if (candidates.length === 0) return null;
  const past = new Date(reference); past.setDate(past.getDate() - 1);
  const future = new Date(reference); future.setDate(future.getDate() + 730);
  const inRange = candidates.filter((d) => d >= past && d <= future).sort((a, b) => a.getTime() - b.getTime());
  const best = inRange[0] ?? [...candidates].sort((a, b) => a.getTime() - b.getTime())[0];
  return best ? best.toISOString() : null;
}

/**
 * High-confidence only: a date sitting right next to a travel keyword
 * ("departing", "check-in", ...). Used on cheap subject/snippet text, where a
 * blind whole-text scan is too likely to latch onto an unrelated date (a
 * payment deadline, an order number that looks like a date, etc.) and wrongly
 * skip the more thorough full-body fetch.
 */
export function extractConfidentTravelDate(text: string, reference: Date = new Date()): string | null {
  return pickBestDate(nearestKeywordDates(text.slice(0, 20_000), reference), reference);
}

/** Extracts the most likely travel/event date from free text — falls back to a blind scan of the whole body if no keyword-adjacent date is found. */
export function extractTravelDate(text: string, reference: Date = new Date()): string | null {
  const scoped = text.slice(0, 20_000);
  const nearKeywords = nearestKeywordDates(scoped, reference);
  const candidates = nearKeywords.length > 0 ? nearKeywords : findDatesInText(scoped, reference);
  return pickBestDate(candidates, reference);
}

/**
 * Same candidate selection as extractTravelDate, but keeps both ends of the
 * range instead of just the earliest — a round-trip flight confirmation
 * mentions both the outbound and return dates in one email, and we want the
 * trip's full span, not just its start.
 */
export function extractTravelDateRange(text: string, reference: Date = new Date()): { start: string; end: string } | null {
  const scoped = text.slice(0, 20_000);
  const nearKeywords = nearestKeywordDates(scoped, reference);
  const candidates = nearKeywords.length > 0 ? nearKeywords : findDatesInText(scoped, reference);
  if (candidates.length === 0) return null;

  const past = new Date(reference); past.setDate(past.getDate() - 1);
  const future = new Date(reference); future.setDate(future.getDate() + 730);
  const inRange = candidates.filter((d) => d >= past && d <= future).sort((a, b) => a.getTime() - b.getTime());
  const pool = inRange.length > 0 ? inRange : [...candidates].sort((a, b) => a.getTime() - b.getTime());
  if (pool.length === 0) return null;
  return { start: pool[0].toISOString(), end: pool[pool.length - 1].toISOString() };
}

// Matches "London - Bilbao", "London to Bilbao" style route mentions — common
// in flight confirmations, rare enough elsewhere (requires two capitalised
// words either side) to be a reasonably safe heuristic. Takes the second city
// as the destination, assuming outbound-first phrasing.
const ROUTE_PATTERN = /\b[A-Z][a-zA-Z]{2,}(?:\s[A-Z][a-zA-Z]{2,})?\s*(?:-|to)\s*([A-Z][a-zA-Z]{2,}(?:\s[A-Z][a-zA-Z]{2,})?)\b/;

/** Best-effort destination city/place, e.g. from a flight confirmation's route mention. Returns null if nothing route-shaped is found. */
export function extractDestination(text: string): string | null {
  const m = text.slice(0, 20_000).match(ROUTE_PATTERN);
  return m ? m[1] : null;
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

  // category:purchases is back — real booking confirmations (Trip.com,
  // airline receipts) often land there rather than category:travel, which
  // is Gmail's own (imperfect) classification, not something we control.
  // -category:promotions cuts marketing/spam off at the source instead —
  // the bare keyword search tried previously ("ticket", "event", "concert")
  // matched any promotional email mentioning those words, which is exactly
  // the spam this excludes; the type allowlist below does the rest.
  const query = `(category:travel OR category:purchases) -category:promotions newer_than:${lookbackDays}d`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=15`,
      { signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (listRes.status === 401) { invalidateToken(); throw new Error('Gmail access token expired. Please sign out and sign in again.'); }
    if (listRes.status === 403) {
      // Don't keep reusing a token that's missing the gmail.readonly scope —
      // force a fresh fetch on the next attempt instead of reusing this one
      // for up to the full 45-minute cache TTL.
      invalidateToken();
      throw new Error('Gmail access not granted. Please sign out and sign in again to allow booking lookups.');
    }
    if (!listRes.ok) {
      throw new Error(`Gmail API error ${listRes.status}`);
    }

    const listData = await listRes.json() as { messages?: { id: string }[] };
    const messages = listData.messages ?? [];
    const now = new Date();

    // Only travel/event bookings belong in the Upcoming tab — a delivery or
    // restaurant confirmation slipping through the query above (Gmail's
    // categorization is approximate) shouldn't consume a full-body fetch or
    // show up as a "booking", and definitely shouldn't be eligible for trip
    // grouping (a stray date inside one can otherwise corrupt a real trip's
    // date range).
    const RELEVANT_TYPES: BookingType[] = ['flight', 'hotel', 'train', 'event'];

    const items: (BookingItem | null)[] = await Promise.all(
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

        const type = classifyBooking(subject, from);
        if (!RELEVANT_TYPES.includes(type)) return null;

        // Cheap first pass: subject + snippet often already contain the date
        // (airlines routinely put it in the subject line). Require a keyword
        // right next to the date here — a blind scan of a short snippet is
        // too likely to grab an unrelated date (a payment deadline, etc.)
        // and wrongly skip the more thorough full-body fetch below.
        const cheapText = `${subject} ${snippet}`;
        let text = cheapText;
        let travelDate = extractConfidentTravelDate(cheapText, now) ?? undefined;
        if (!travelDate) {
          try {
            const fullRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const full = await fullRes.json() as { payload?: GmailPart };
            const bodyText = extractBodyText(full.payload);
            travelDate = extractTravelDate(bodyText, now) ?? undefined;
            if (bodyText) text = bodyText;
          } catch {
            // Best-effort — fall back to no travel date rather than failing the whole booking.
          }
        }

        // Reuses whichever text resolved the date above — a round-trip
        // confirmation mentions both legs in the same email, so the range's
        // end often differs from travelDate; the destination is a bonus
        // label for grouping multiple bookings into one trip, not guaranteed.
        const range = extractTravelDateRange(text, now);
        const destination = extractDestination(text) ?? undefined;

        return {
          id,
          type,
          subject,
          snippet,
          from,
          date: parseEmailDate(get('Date')),
          travelDate,
          travelDateEnd: range?.end,
          destination,
        };
      })
    );

    return { items: items.filter((item): item is BookingItem => item !== null), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Bookings request timed out — check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
