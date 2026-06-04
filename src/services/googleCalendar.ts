import type { AvailabilityData } from '../types';

const ACCESS_TOKEN = process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ACCESS_TOKEN;
const CALENDAR_ID = process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_ID ?? 'primary';

const REQUEST_TIMEOUT_MS = 15_000;

// Check free/busy for the next 7 days from midnight today
export async function getAvailabilityData(): Promise<AvailabilityData> {
  if (!ACCESS_TOKEN) {
    throw new Error(
      'Google Calendar access token missing. Add EXPO_PUBLIC_GOOGLE_CALENDAR_ACCESS_TOKEN to your .env file. ' +
        'Generate one at https://developers.google.com/oauthplayground'
    );
  }

  const windowStart = new Date();
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 7);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        items: [{ id: CALENDAR_ID }],
      }),
    });

    if (res.status === 401) {
      throw new Error(
        'Calendar access token expired (tokens last ~1 hour). Re-generate it at https://developers.google.com/oauthplayground'
      );
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`Google Calendar error: ${err?.error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    const busySlots = (data.calendars?.[CALENDAR_ID]?.busy ?? []) as Array<{
      start: string;
      end: string;
    }>;

    return {
      busySlots,
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

/** Human-readable summary for the context block sent to Claude */
export function formatAvailability(data: AvailabilityData): string {
  if (data.busySlots.length === 0) {
    return 'User has no calendar events in the next 7 days — completely free.';
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const lines = data.busySlots
    .slice(0, 10)
    .map((s) => `  • ${fmt(s.start)} → ${new Date(s.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`)
    .join('\n');

  return `User's busy slots in the next 7 days (${data.busySlots.length} total):\n${lines}`;
}
