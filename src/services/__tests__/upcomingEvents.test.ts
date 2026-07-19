// upcomingEvents.ts is dense day-granularity date arithmetic feeding the Trips UI — the
// exact area with multiple past regressions (multi-day trips vanishing on their final day,
// return dates conflated with live ETA). Pinning TZ to Europe/London (this app's actual
// target market) before any Date use, so day-boundary behavior is deterministic and matches
// production rather than whatever timezone happens to run the test.
process.env.TZ = 'Europe/London';

import { NativeModules } from 'react-native';
import { DatabaseSync } from 'node:sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getUpcomingCalendarEvents } from '../googleCalendar';
import { getBookingsContext } from '../googleBookings';
import type { CalendarEvent, BookingItem, BookingContext } from '../../types';

const mockRawDb = new DatabaseSync(':memory:');

jest.mock('expo-sqlite', () => ({
  __esModule: true,
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: async (sql: string) => { mockRawDb.exec(sql); },
    runAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).run(...params),
    getFirstAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).all(...params),
  })),
}));

jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => require('node:crypto').randomUUID(),
  digestStringAsync: async (_algo: any, input: string) => `digest:${input}`,
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('../googleCalendar', () => ({ getUpcomingCalendarEvents: jest.fn() }));
jest.mock('../googleBookings', () => ({ getBookingsContext: jest.fn() }));

import { getDatabase, upsertBookings as seedBookings } from '../database';
import { loadUpcomingEvents, formatTripDateRange, UPCOMING_EMPTY } from '../upcomingEvents';

const NOW = new Date('2026-06-15T11:00:00Z'); // 2026-06-15T12:00 BST — safely midday, no boundary ambiguity

function booking(overrides: Partial<BookingItem> & Pick<BookingItem, 'id'>): BookingItem {
  return {
    type: 'flight', subject: 'Booking confirmation', snippet: 'snippet', from: 'noreply@example.com',
    date: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(async () => {
  await getDatabase();
  for (const table of ['platform_identities', 'memories', 'style_edits', 'contacts', 'saved_places', 'bookings']) {
    mockRawDb.exec(`DELETE FROM ${table}`);
  }
  await AsyncStorage.clear();
  jest.useFakeTimers().setSystemTime(NOW);
  NativeModules.ProTxtSettings = { syncUpcomingBookings: jest.fn() };
  (getUpcomingCalendarEvents as jest.Mock).mockResolvedValue([]);
  (getBookingsContext as jest.Mock).mockResolvedValue({ items: [], windowStart: '', windowEnd: '' } as BookingContext);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('loadUpcomingEvents — not authenticated', () => {
  it('returns empty data immediately without touching Calendar or Gmail', async () => {
    const onUpdate = jest.fn();
    const result = await loadUpcomingEvents(false, onUpdate);

    expect(result).toEqual(expect.objectContaining({ calendarItems: [], bookingItems: [], trips: [] }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(getUpcomingCalendarEvents).not.toHaveBeenCalled();
    expect(getBookingsContext).not.toHaveBeenCalled();
  });
});

describe('loadUpcomingEvents — sync gating', () => {
  it('serves from cache and fires onUpdate once when no sync is due', async () => {
    await seedBookings([booking({ id: 'b1', destination: 'Paris', travelDate: '2026-07-01' })]);
    await AsyncStorage.setItem('bookings_sync_logic_version', '9');
    // A cache with no prior "last synced" would count as due, so give it one via a real sync first.
    await loadUpcomingEvents(true);
    jest.clearAllMocks();
    (getUpcomingCalendarEvents as jest.Mock).mockResolvedValue([]);

    const onUpdate = jest.fn();
    const result = await loadUpcomingEvents(true, onUpdate);

    expect(getBookingsContext).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(result.bookingItems.some((b) => b.destination === 'Paris')).toBe(true);
  });

  it('runs a full sync and fires onUpdate twice (cached, then final) on first-ever load', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [booking({ id: 'b1', destination: 'Rome', travelDate: '2026-07-01' })],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    const onUpdate = jest.fn();
    const result = await loadUpcomingEvents(true, onUpdate);

    expect(getBookingsContext).toHaveBeenCalledWith(90);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[0][0].isSyncing).toBe(true);
    expect(result.bookingItems.some((b) => b.destination === 'Rome')).toBe(true);
    expect(await AsyncStorage.getItem('bookings_sync_logic_version')).toBe('9');
  });

  it('forces a full resync when the stored logic version is stale, even if recently synced', async () => {
    await seedBookings([booking({ id: 'b1' })]);
    await AsyncStorage.setItem('bookings_sync_logic_version', '1'); // stale

    await loadUpcomingEvents(true);

    expect(getBookingsContext).toHaveBeenCalledWith(90);
  });

  it('degrades to cached bookings and surfaces the error when the Gmail sync fails', async () => {
    await seedBookings([booking({ id: 'b1', destination: 'Berlin' })]);
    (getBookingsContext as jest.Mock).mockRejectedValue(new Error('Gmail auth expired'));

    const result = await loadUpcomingEvents(true);

    expect(result.bookingsError).toBe('Gmail auth expired');
    expect(result.bookingItems.some((b) => b.destination === 'Berlin')).toBe(true);
  });
});

describe('loadUpcomingEvents — multi-day trip visibility (regression coverage)', () => {
  it('keeps a multi-day trip marked upcoming through its final day', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [booking({
        id: 'trip1', destination: 'Brighton',
        travelDate: '2026-06-14', travelDateEnd: '2026-06-15', // started yesterday, ends today
      })],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    const result = await loadUpcomingEvents(true);

    const item = result.bookingItems.find((b) => b.destination === 'Brighton')!;
    expect(item.isUpcomingTravel).toBe(true);
    // isToday on the raw item reflects only its start date (yesterday) — the "spans the
    // whole window" behavior lives on the grouped Trip instead, covered separately below.
    expect(item.isToday).toBe(false);
  });

  it('drops a multi-day trip out of upcoming once its final day has fully passed', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [booking({
        id: 'trip2', destination: 'Leeds',
        travelDate: '2026-06-12', travelDateEnd: '2026-06-14', // ended yesterday
      })],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    const result = await loadUpcomingEvents(true);

    const item = result.bookingItems.find((b) => b.destination === 'Leeds')!;
    expect(item.isUpcomingTravel).toBe(false);
  });

  it('preserves a cached booking that is still upcoming even if a full resync no longer returns it', async () => {
    await seedBookings([booking({ id: 'stale-fetch', destination: 'Tokyo', travelDate: '2026-08-01', travelDateEnd: '2026-08-10' })]);
    // The fresh Gmail fetch this time comes back empty (e.g. the confirmation email fell outside the 90-day window).
    (getBookingsContext as jest.Mock).mockResolvedValue({ items: [], windowStart: '', windowEnd: '' } as BookingContext);

    const result = await loadUpcomingEvents(true);

    expect(result.bookingItems.some((b) => b.destination === 'Tokyo')).toBe(true);
  });

  it('prunes a cached booking whose window has fully ended and is absent from a full resync', async () => {
    await seedBookings([booking({ id: 'long-gone', destination: 'Oslo', travelDate: '2026-01-01', travelDateEnd: '2026-01-03' })]);
    (getBookingsContext as jest.Mock).mockResolvedValue({ items: [], windowStart: '', windowEnd: '' } as BookingContext);

    const result = await loadUpcomingEvents(true);

    expect(result.bookingItems.some((b) => b.destination === 'Oslo')).toBe(false);
  });
});

describe('loadUpcomingEvents — trip grouping', () => {
  it('clusters overlapping bookings into a single trip, preferring the flight\'s destination', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [
        booking({ id: 'flight1', type: 'flight', destination: 'Lisbon', travelDate: '2026-07-10', travelDateEnd: '2026-07-10' }),
        booking({ id: 'hotel1', type: 'hotel', destination: 'Lisbon hotel district', travelDate: '2026-07-10', travelDateEnd: '2026-07-13' }),
      ],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    const result = await loadUpcomingEvents(true);

    expect(result.trips).toHaveLength(1);
    expect(result.trips[0].destination).toBe('Lisbon');
    expect(result.trips[0].items).toHaveLength(2);
  });

  it('marks a multi-day trip as "today" on its last day, not just its start day', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [booking({ id: 'trip3', destination: 'Edinburgh', travelDate: '2026-06-13', travelDateEnd: '2026-06-15' })],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    const result = await loadUpcomingEvents(true);

    expect(result.trips[0].isToday).toBe(true);
  });

  it('keeps non-overlapping bookings as separate trips', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [
        booking({ id: 'a', destination: 'Paris', travelDate: '2026-07-01', travelDateEnd: '2026-07-01' }),
        booking({ id: 'b', destination: 'Milan', travelDate: '2026-09-01', travelDateEnd: '2026-09-01' }),
      ],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    const result = await loadUpcomingEvents(true);

    expect(result.trips).toHaveLength(2);
  });
});

describe('loadUpcomingEvents — calendar and list shaping', () => {
  it('filters out past calendar events and sorts the rest ascending', async () => {
    const events: CalendarEvent[] = [
      { summary: 'Past meeting', start: '2026-06-10T09:00:00Z', end: '2026-06-10T10:00:00Z', allDay: false },
      { summary: 'Later today', start: '2026-06-15T15:00:00Z', end: '2026-06-15T16:00:00Z', allDay: false },
      { summary: 'Tomorrow', start: '2026-06-16T09:00:00Z', end: '2026-06-16T10:00:00Z', allDay: false },
    ];
    (getUpcomingCalendarEvents as jest.Mock).mockResolvedValue(events);

    const result = await loadUpcomingEvents(true);

    expect(result.calendarItems.map((c) => c.title)).toEqual(['Later today', 'Tomorrow']);
    expect(result.calendarItems[0].isToday).toBe(true);
    expect(result.calendarItems[1].isTomorrow).toBe(true);
  });

  it('caps booking items at 8, upcoming travel first (soonest), then recent confirmations (newest first)', async () => {
    const upcoming = Array.from({ length: 5 }, (_, i) =>
      booking({ id: `up${i}`, destination: `Dest${i}`, travelDate: `2026-07-${10 + i}`, travelDateEnd: `2026-07-${10 + i}` }));
    const confirmations = Array.from({ length: 5 }, (_, i) =>
      booking({ id: `conf${i}`, date: `2026-06-0${i + 1}T00:00:00Z` }));
    (getBookingsContext as jest.Mock).mockResolvedValue({ items: [...confirmations, ...upcoming], windowStart: '', windowEnd: '' } as BookingContext);

    const result = await loadUpcomingEvents(true);

    expect(result.bookingItems).toHaveLength(8);
    expect(result.bookingItems.slice(0, 5).every((b) => b.isUpcomingTravel)).toBe(true);
    expect(result.bookingItems[0].destination).toBe('Dest0'); // soonest upcoming first
  });
});

describe('formatTripDateRange', () => {
  it('collapses to a single date when start and end are the same day', () => {
    const d = new Date('2026-07-10T12:00:00Z');
    expect(formatTripDateRange(d, d)).toBe(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
  });

  it('shows a range when start and end differ', () => {
    const start = new Date('2026-07-10T12:00:00Z');
    const end = new Date('2026-07-13T12:00:00Z');
    expect(formatTripDateRange(start, end)).toBe(
      `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    );
  });
});

describe('native booking cache sync', () => {
  it('pushes only imminent/underway bookings to the native bridge', async () => {
    (getBookingsContext as jest.Mock).mockResolvedValue({
      items: [
        booking({ id: 'soon', destination: 'Brighton', travelDate: '2026-06-16', travelDateEnd: '2026-06-16' }), // within 48h
        booking({ id: 'far', destination: 'Sydney', travelDate: '2026-12-01', travelDateEnd: '2026-12-05' }),   // months away
      ],
      windowStart: '', windowEnd: '',
    } as BookingContext);

    await loadUpcomingEvents(true);

    const [payload] = (NativeModules.ProTxtSettings.syncUpcomingBookings as jest.Mock).mock.calls.at(-1)!;
    const cached = JSON.parse(payload);
    expect(cached.map((b: any) => b.destination)).toEqual(['Brighton']);
  });
});
