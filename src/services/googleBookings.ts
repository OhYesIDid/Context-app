import { NativeModules } from 'react-native';
import type { BookingContext, BookingItem, BookingType } from '../types';
import { getAccessToken, invalidateToken } from './googleAuth';

// 35s (was 25s): paginating through up to MAX_MESSAGES results (see below)
// adds a handful of sequential list-page round-trips on top of the
// full-body fallback fetches — the whole getBookingsContext call shares
// this one timeout budget.
const REQUEST_TIMEOUT_MS = 35_000;

const WORKER_URL = process.env.EXPO_PUBLIC_WORKER_URL;

function parseEmailDate(raw: string): string {
  try {
    return new Date(raw).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ── Booking classification ──────────────────────────────────────────────────
// Regex/keyword classification and date extraction used to live here. It hit
// a structural ceiling: every fix uncovered a differently-shaped bug (Gmail
// category labels that don't mean what they say, round-trip label pairs that
// vary by vendor, an airline's "online check-in" text sitting right next to
// the real date, a bare abbreviation colliding with an unrelated word inside
// a sender address). Interpreting free-form vendor text is exactly what an
// LLM is suited for and regex isn't — this delegates that step to Claude via
// a dedicated worker endpoint, while the Gmail search filter below (category
// + vendor keywords) still does all the volume control before any of this
// runs, same as before.

interface ClassifyCandidate {
  id: string;
  subject: string;
  from: string;
  text: string;
}

interface ClassifiedBooking {
  id: string;
  type: BookingType | null;
  confident: boolean;
  travelDate?: string;
  travelDateEnd?: string;
  destination?: string;
}

async function classifyBookingsBatch(candidates: ClassifyCandidate[]): Promise<ClassifiedBooking[]> {
  if (candidates.length === 0) return [];
  if (!WORKER_URL) throw new Error('EXPO_PUBLIC_WORKER_URL is not set — booking classification requires the worker.');

  const rawBody = JSON.stringify({ candidates });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // The worker requires HMAC-SHA256 signing (same as the native reply-
  // suggestion path) — signed natively so WORKER_SECRET never needs to be
  // duplicated into the JS bundle.
  const signature: string = await NativeModules.ProTxtSettings.signWorkerRequest(timestamp, rawBody);

  const res = await fetch(`${WORKER_URL}/classify-bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': timestamp,
      ...(signature ? { 'X-Signature': signature } : {}),
    },
    body: rawBody,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Booking classification failed (${res.status})`);
  }
  const data = await res.json() as { results?: ClassifiedBooking[] };
  return data.results ?? [];
}

// ── Gmail body extraction ──────────────────────────────────────────────────
// MIME parsing only — nothing here interprets what the email means, just
// decodes the raw content so classifyBookingsBatch has readable text to work
// with when a cheap subject/snippet pass isn't confident enough.

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

function formatGmailDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * @param lookbackDays Used for a full scan (sinceDate omitted) — ignored otherwise.
 * @param sinceDate When given, does an incremental scan instead ("after:" the day
 *   before this date, overlapping by a day since Gmail's after: is date-only and
 *   duplicates are harmless — upserts are keyed by message id).
 * @param maxMessages Safety cap on how many candidate messages to page through
 *   and classify. A full scan needs headroom against a busy inbox's daily purchase
 *   volume; an incremental scan only ever needs to cover a day or two, so it can
 *   stay small.
 */
export async function getBookingsContext(lookbackDays = 30, sinceDate?: Date, maxMessages = 150): Promise<BookingContext> {
  const accessToken = await getAccessToken();

  const windowEnd = new Date();
  const windowStart = sinceDate ?? new Date();
  if (!sinceDate) windowStart.setDate(windowStart.getDate() - lookbackDays);

  // category:purchases is back — real booking confirmations (Trip.com,
  // airline receipts) often land there rather than category:travel, which
  // is Gmail's own (imperfect) classification, not something we control.
  // -category:promotions cuts marketing/spam off at the source instead —
  // the bare keyword search tried previously ("ticket", "event", "concert")
  // matched any promotional email mentioning those words, which is exactly
  // the spam this excludes; classification below does the rest.
  //
  // Confirmed live: a real Trip.com "Payment Successful"/"Flight Booking
  // Confirmed" pair was tagged category:updates by Gmail — neither travel
  // nor purchases — and so never got fetched at all, regardless of any
  // fetch-cap or pagination fix. category:updates alone is enormous (tens
  // of thousands of messages: bank alerts, shipping notices, etc.), so it's
  // scoped to known travel-vendor keywords rather than included wholesale.
  const UPDATES_VENDOR_TERMS = '"trip.com" OR eurostar OR easyjet OR ryanair OR lufthansa OR marriott OR hilton OR "booking.com" OR hotels.com OR "e-ticket" OR eventbrite OR ticketmaster OR "national express" OR "bus station" OR megabus OR flixbus';
  const dateFilter = sinceDate
    ? (() => { const d = new Date(sinceDate); d.setDate(d.getDate() - 1); return `after:${formatGmailDate(d)}`; })()
    : `newer_than:${lookbackDays}d`;
  const query = `(category:travel OR category:purchases OR (category:updates (${UPDATES_VENDOR_TERMS}))) -category:promotions ${dateFilter}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
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

    const listData = await listRes.json() as { messages?: { id: string }[]; nextPageToken?: string };
    const messageIds = (listData.messages ?? []).map((m) => m.id);

    // A single page of "recent purchases/travel" isn't enough for a busy
    // inbox — dozens of unrelated receipts (deliveries, subscriptions, food
    // orders) routinely outnumber genuine bookings from just a few days
    // ago, pushing them past any single-page cutoff. Page through further
    // results (bounded by maxMessages) instead of raising that cutoff
    // indefinitely. Subsequent-page failures are swallowed — better to work
    // with whatever was already fetched than fail the whole lookup over a
    // pagination hiccup.
    let pageToken = listData.nextPageToken;
    while (pageToken && messageIds.length < maxMessages) {
      try {
        const pageRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50&pageToken=${pageToken}`,
          { signal: controller.signal, headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!pageRes.ok) break;
        const pageData = await pageRes.json() as { messages?: { id: string }[]; nextPageToken?: string };
        messageIds.push(...(pageData.messages ?? []).map((m) => m.id));
        pageToken = pageData.nextPageToken;
      } catch {
        break;
      }
    }

    // Fetch metadata (subject/from/snippet/date) for every candidate — cheap,
    // and needed regardless of how classification happens.
    const metas = await Promise.all(
      messageIds.slice(0, maxMessages).map(async (id) => {
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
        return { id, subject: get('Subject'), from: get('From'), snippet: msg.snippet ?? '', date: get('Date') };
      })
    );

    // Tier 1: one batched call with cheap subject+snippet text for every
    // candidate. Most resolve here — no full-body Gmail fetch needed.
    const tier1 = await classifyBookingsBatch(
      metas.map((m) => ({ id: m.id, subject: m.subject, from: m.from, text: m.snippet }))
    );
    const tier1ById = new Map(tier1.map((r) => [r.id, r]));

    // Tier 2: only for candidates the model flagged as a real booking type
    // but not confident enough on the snippet alone — fetch the full body
    // and retry just that subset in a second, smaller batched call.
    const needsFullBody = metas.filter((m) => {
      const r = tier1ById.get(m.id);
      return r && r.type !== null && !r.confident;
    });

    let tier2ById = new Map<string, ClassifiedBooking>();
    if (needsFullBody.length > 0) {
      const withBodies = await Promise.all(
        needsFullBody.map(async (m) => {
          try {
            const fullRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const full = await fullRes.json() as { payload?: GmailPart };
            return { id: m.id, subject: m.subject, from: m.from, text: extractBodyText(full.payload) };
          } catch {
            return { id: m.id, subject: m.subject, from: m.from, text: '' };
          }
        })
      );
      const tier2 = await classifyBookingsBatch(withBodies.filter((c) => c.text.length > 0));
      tier2ById = new Map(tier2.map((r) => [r.id, r]));
    }

    const mapped: (BookingItem | null)[] = metas.map((m) => {
      const resolved = tier2ById.get(m.id) ?? tier1ById.get(m.id);
      if (!resolved || resolved.type === null) return null;
      return {
        id: m.id,
        type: resolved.type,
        subject: m.subject,
        snippet: m.snippet,
        from: m.from,
        date: parseEmailDate(m.date),
        travelDate: resolved.travelDate,
        travelDateEnd: resolved.travelDateEnd,
        destination: resolved.destination,
      };
    });
    const items = mapped.filter((item): item is BookingItem => item !== null);

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
