import type { AvailabilityData, CalendarEvent } from '../types';
import { getAccessToken } from './googleAuth';

const CALENDAR_ID = process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ID ?? 'primary';

const REQUEST_TIMEOUT_MS = 15_000;

// Fetch all events for the next 7 days from midnight today
export async function getAvailabilityData(): Promise<AvailabilityData> {
  const accessToken = await getAccessToken();

  const windowStart = new Date();
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 7);

  const params = new URLSearchParams({
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

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
