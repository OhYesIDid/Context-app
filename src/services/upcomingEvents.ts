import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BookingType, CalendarEvent, BookingItem } from '../types';
import { getUpcomingCalendarEvents } from './googleCalendar';
import { getBookingsContext } from './googleBookings';
import { getCachedBookings, getLastBookingsSyncAt, pruneBookingsNotIn, upsertBookings } from './database';

export const BOOKING_ICONS: Record<BookingType, string> = {
  flight:      '✈️',
  hotel:       '🏨',
  train:       '🚂',
  bus:         '🚌',
  delivery:    '📦',
  restaurant:  '🍽️',
  event:       '🎟️',
  other:       '📋',
};

const PLATFORM_ICONS: Record<string, string> = {
  whatsapp:  '💬',
  telegram:  '📨',
  instagram: '📸',
  sms:       '💬',
  email:     '📧',
  messenger: '💭',
  signal:    '🔒',
  google:    '🔍',
  phone:     '📱',
};

export { PLATFORM_ICONS };

export interface UpcomingCalendarItem {
  kind: 'calendar';
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  date: Date;
  isToday: boolean;
  isTomorrow: boolean;
}

export interface UpcomingBookingItem {
  kind: 'booking';
  id: string;
  bookingType: BookingType;
  icon: string;
  title: string;
  subtitle: string;
  date: Date;
  isToday: boolean;
  isTomorrow: boolean;
  /** True when `date` is a resolved future travel date (parsed from the email), not just the confirmation's received date. */
  isUpcomingTravel: boolean;
  /** End of the resolved date range (e.g. a return-flight date), if the email mentioned one. Falls back to `date` when grouping into a trip. */
  travelDateEnd?: Date;
  /** Best-effort destination name, e.g. parsed from a flight confirmation's route mention. */
  destination?: string;
  /** Gmail message ID — used to link back to the source email. */
  gmailId: string;
}

export type UpcomingItem = UpcomingCalendarItem | UpcomingBookingItem;

export interface Trip {
  id: string;
  /** Best-effort destination name; falls back to a generic "Trip" label when nothing parsed. */
  destination: string;
  startDate: Date;
  endDate: Date;
  items: UpcomingBookingItem[];
  isToday: boolean;
  isTomorrow: boolean;
}

export interface UpcomingData {
  calendarItems: UpcomingCalendarItem[];
  bookingItems: UpcomingBookingItem[];
  trips: Trip[];
  fetchedAt: number;
  /** Set when the Gmail booking fetch failed outright (timeout, auth, API error) — surfaced in the UI instead of silently showing an empty list. */
  bookingsError?: string;
}

export const UPCOMING_EMPTY: UpcomingData = { calendarItems: [], bookingItems: [], trips: [], fetchedAt: 0 };

// Bookings within this many days of each other's resolved date range are
// treated as the same trip — a flight lands one day, a hotel check-in email
// might resolve to the same or adjacent day depending on how its text parses.
const TRIP_GROUPING_TOLERANCE_MS = 1.5 * 86400000;

/**
 * Groups upcoming-travel booking items into trips by overlapping (or
 * near-overlapping) date range — not by destination text, since hotel/car
 * rental confirmations format destinations far too inconsistently to match
 * reliably against a flight's route. Date-range clustering is more robust:
 * a flight, hotel, and car rental for the same trip will have overlapping
 * date spans even when nothing in their text obviously matches.
 */
function groupIntoTrips(items: UpcomingBookingItem[], todayMs: number): Trip[] {
  const sorted = [...items].sort((a, b) => a.date.getTime() - b.date.getTime());
  const clusters: UpcomingBookingItem[][] = [];

  for (const item of sorted) {
    const itemEnd = (item.travelDateEnd ?? item.date).getTime();
    const cluster = clusters.find(c => {
      const clusterEnd = Math.max(...c.map(i => (i.travelDateEnd ?? i.date).getTime()));
      const clusterStart = Math.min(...c.map(i => i.date.getTime()));
      return item.date.getTime() <= clusterEnd + TRIP_GROUPING_TOLERANCE_MS
        && clusterStart <= itemEnd + TRIP_GROUPING_TOLERANCE_MS;
    });
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }

  return clusters.map((clusterItems, idx) => {
    const startDate = new Date(Math.min(...clusterItems.map(i => i.date.getTime())));
    const endDate = new Date(Math.max(...clusterItems.map(i => (i.travelDateEnd ?? i.date).getTime())));
    // Prefer a flight's destination (route text is the most reliable source), then any other item's.
    const destination = clusterItems.find(i => i.bookingType === 'flight' && i.destination)?.destination
      ?? clusterItems.find(i => i.destination)?.destination
      ?? null;
    const startMs = dayStart(startDate);
    return {
      id: `trip_${startDate.getTime()}_${idx}`,
      destination: destination ?? 'Trip',
      startDate,
      endDate,
      items: clusterItems.sort((a, b) => a.date.getTime() - b.date.getTime()),
      isToday: startMs === todayMs,
      isTomorrow: startMs === todayMs + 86400000,
    };
  }).sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatEventSubtitle(event: CalendarEvent): string {
  const start = new Date(event.start);
  const now = new Date();
  const todayMs = dayStart(now);
  const eventMs = dayStart(start);
  const timeStr = event.allDay
    ? 'all day'
    : start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  if (eventMs === todayMs) return `Today · ${timeStr}`;
  if (eventMs === todayMs + 86400000) return `Tomorrow · ${timeStr}`;
  const dateStr = start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${dateStr} · ${timeStr}`;
}

function formatBookingSubtitle(item: BookingItem): string {
  const date = new Date(item.date);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (diffDays === 0) return 'Confirmed today';
  if (diffDays === 1) return 'Confirmed yesterday';
  if (diffDays < 7) return `Confirmed ${diffDays}d ago`;
  return `Confirmed ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

function formatTravelSubtitle(date: Date): string {
  const now = new Date();
  const todayMs = dayStart(now);
  const eventMs = dayStart(date);
  if (eventMs === todayMs) return 'Today';
  if (eventMs === todayMs + 86400000) return 'Tomorrow';
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTripDateRange(start: Date, end: Date): string {
  const startStr = start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (dayStart(start) === dayStart(end)) return startStr;
  const endStr = end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${startStr} – ${endStr}`;
}

export { formatTripDateRange };

// Re-hitting Gmail on every tab open / app-foreground was the root cause of
// bookings getting crowded out by inbox volume in the first place (see
// googleBookings.ts) — this caps how often a real fetch happens at all.
// Between syncs, bookings are served straight from the local cache: no
// network call, no data usage, no latency.
const BOOKINGS_SYNC_INTERVAL_MS = 20 * 60 * 1000;

// Bump this whenever getBookingsContext's query or classifyBooking's rules
// change. Without it, a fix can ship but never actually run for up to
// BOOKINGS_SYNC_INTERVAL_MS on a device that already synced recently under
// the old (buggy) logic — exactly what happened going from v51 to v52,
// where v51's forced-debug sync had just reset the timer.
const BOOKINGS_SYNC_LOGIC_VERSION = '5';
const BOOKINGS_SYNC_LOGIC_VERSION_KEY = 'bookings_sync_logic_version';

async function syncBookings(googleAuthed: boolean): Promise<{ items: BookingItem[]; error?: string }> {
  if (!googleAuthed) return { items: [] };

  const cached = await getCachedBookings();
  const lastSyncAt = await getLastBookingsSyncAt();
  const syncedLogicVersion = await AsyncStorage.getItem(BOOKINGS_SYNC_LOGIC_VERSION_KEY);
  const isDue = !lastSyncAt
    || Date.now() - lastSyncAt.getTime() > BOOKINGS_SYNC_INTERVAL_MS
    || syncedLogicVersion !== BOOKINGS_SYNC_LOGIC_VERSION;
  if (!isDue) return { items: cached };

  try {
    // A logic-version mismatch needs a full rescan (old cached rows may
    // have been classified/dated under the old rules), same as a
    // never-synced device — not just a gap-covering incremental one.
    const isFullSync = !lastSyncAt || syncedLogicVersion !== BOOKINGS_SYNC_LOGIC_VERSION;
    const context = isFullSync
      ? await getBookingsContext(30)
      : await getBookingsContext(30, lastSyncAt, 30);
    await upsertBookings(context.items);
    // Only a full sync can safely prune — an incremental sync only covers a
    // narrow recent window, so older cached rows outside it would look
    // "missing" and get wrongly deleted.
    if (isFullSync) await pruneBookingsNotIn(context.items.map((b) => b.id));
    await AsyncStorage.setItem(BOOKINGS_SYNC_LOGIC_VERSION_KEY, BOOKINGS_SYNC_LOGIC_VERSION);
    return { items: await getCachedBookings() };
  } catch (err) {
    // Network/auth failure — degrade to whatever's cached rather than
    // losing everything, but still surface the error.
    return { items: cached, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function loadUpcomingEvents(googleAuthed: boolean): Promise<UpcomingData> {
  const [calResult, bookResult] = await Promise.allSettled([
    googleAuthed
      ? getUpcomingCalendarEvents(30)
      : Promise.resolve([] as CalendarEvent[]),
    syncBookings(googleAuthed),
  ]);

  const events = calResult.status === 'fulfilled' ? calResult.value : [];
  const bookings = bookResult.status === 'fulfilled' ? bookResult.value.items : [];
  const bookingsError = bookResult.status === 'fulfilled'
    ? bookResult.value.error
    : (bookResult.reason instanceof Error ? bookResult.reason.message : String(bookResult.reason));
  const now = new Date();
  const todayMs = dayStart(now);

  const calendarItems: UpcomingCalendarItem[] = events
    .filter(e => new Date(e.start).getTime() >= todayMs)
    .map(e => {
      const date = new Date(e.start);
      const eventMs = dayStart(date);
      return {
        kind: 'calendar' as const,
        id: `cal_${e.start}_${e.summary}`,
        icon: '📅',
        title: e.summary,
        subtitle: formatEventSubtitle(e),
        date,
        isToday: eventMs === todayMs,
        isTomorrow: eventMs === todayMs + 86400000,
      };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 12);

  const allBookingItems: UpcomingBookingItem[] = bookings
    .map(b => {
      const travelMs = b.travelDate ? new Date(b.travelDate).getTime() : NaN;
      const isUpcomingTravel = !Number.isNaN(travelMs) && travelMs >= todayMs;
      const date = isUpcomingTravel ? new Date(travelMs) : new Date(b.date);
      const eventMs = dayStart(date);
      return {
        kind: 'booking' as const,
        id: b.id,
        gmailId: b.id,
        bookingType: b.type,
        icon: BOOKING_ICONS[b.type] ?? '📋',
        title: b.subject.length > 60 ? b.subject.slice(0, 57) + '…' : b.subject,
        subtitle: isUpcomingTravel ? formatTravelSubtitle(date) : formatBookingSubtitle(b),
        date,
        isToday: isUpcomingTravel && eventMs === todayMs,
        isTomorrow: isUpcomingTravel && eventMs === todayMs + 86400000,
        isUpcomingTravel,
        travelDateEnd: b.travelDateEnd ? new Date(b.travelDateEnd) : undefined,
        destination: b.destination,
      };
    })
    // Upcoming travel first (soonest first), then recent confirmations (most recent first).
    .sort((a, b) => {
      if (a.isUpcomingTravel !== b.isUpcomingTravel) return a.isUpcomingTravel ? -1 : 1;
      return a.isUpcomingTravel ? a.date.getTime() - b.date.getTime() : b.date.getTime() - a.date.getTime();
    });

  const trips = groupIntoTrips(allBookingItems.filter(b => b.isUpcomingTravel), todayMs);
  const bookingItems = allBookingItems.slice(0, 8);

  return { calendarItems, bookingItems, trips, fetchedAt: Date.now(), bookingsError };
}
