import type { AvailabilityData, CalendarEvent } from '../types';
import { getAccessToken } from './googleAuth';

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

// Fetches calendar data in one of two modes depending on the message:
//   event-lookup  — keyword found → q=keyword, 14d back + 90d forward, maxResults 10
//   availability  — no keyword    → no q,       0d back  + 7d  forward, maxResults 50
export async function getCalendarData(message: string): Promise<AvailabilityData> {
  const accessToken = await getAccessToken();
  const keyword = extractEventKeyword(message);

  const now = new Date();
  const windowStart = new Date(now);
  const windowEnd = new Date(now);

  if (keyword) {
    windowStart.setDate(now.getDate() - 14);
    windowEnd.setDate(now.getDate() + 90);
  } else {
    windowStart.setHours(0, 0, 0, 0);
    windowEnd.setDate(now.getDate() + 7);
  }

  const params = new URLSearchParams({
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: keyword ? '10' : '50',
  });
  if (keyword) params.set('q', keyword);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
      {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (res.status === 401) {
      throw new Error(
        'Calendar access token is invalid. Please sign out and sign in again.'
      );
    }
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

    const events: CalendarEvent[] = items.map((item) => {
      const allDay = !item.start?.dateTime;
      return {
        summary: item.summary ?? '(No title)',
        start: item.start?.dateTime ?? item.start?.date ?? '',
        end: item.end?.dateTime ?? item.end?.date ?? '',
        allDay,
      };
    });

    return {
      events,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Calendar request timed out — check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
