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
  /** True while a real Gmail sync (not just a cache read) is in flight — lets the UI show a subtle "Updating…" hint instead of looking frozen during a full resync. */
  isSyncing?: boolean;
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
// v8 (2026-07-17): also the fix for rows displaying as "enc1:...." — a
// device-side AES key mismatch left some cached subject/snippet/from_address
// fields undecryptable. Forcing a full resync re-fetches from Gmail and
// re-encrypts under the current key, self-healing without touching the DB
// directly. See dbCrypto.ts's decryptField for the accompanying fix that
// stops a future occurrence of this from leaking ciphertext into the UI.
const BOOKINGS_SYNC_LOGIC_VERSION = '8';
const BOOKINGS_SYNC_LOGIC_VERSION_KEY = 'bookings_sync_logic_version';

async function isBookingsSyncDue(): Promise<boolean> {
  const lastSyncAt = await getLastBookingsSyncAt();
  const syncedLogicVersion = await AsyncStorage.getItem(BOOKINGS_SYNC_LOGIC_VERSION_KEY);
  return !lastSyncAt
    || Date.now() - lastSyncAt.getTime() > BOOKINGS_SYNC_INTERVAL_MS
    || syncedLogicVersion !== BOOKINGS_SYNC_LOGIC_VERSION;
}

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
    // Full sync looks back further than the confirmation-email-received
    // window would suggest is needed: a flight booked 6+ weeks ahead of
    // travel has a confirmation older than 30 days well before the trip
    // itself happens. 90 days covers most advance bookings; this only runs
    // on a full resync (first install or a logic-version bump), not on
    // every load, so the wider window is a one-time cost, not a per-load one.
    const context = isFullSync
      ? await getBookingsContext(90)
      : await getBookingsContext(30, lastSyncAt, 30);
    await upsertBookings(context.items);
    // Only a full sync can safely prune — an incremental sync only covers a
    // narrow recent window, so older cached rows outside it would look
    // "missing" and get wrongly deleted.
    //
    // Even a full sync's own rescan window (newer_than:30d) is a "how far
    // back to look for new candidates" control, not a "how long is this
    // booking still valid" one — a flight booked 6 weeks before departure
    // has a confirmation email older than 30 days well before the trip
    // itself is over. Without this, any booking made far enough ahead of
    // travel would silently vanish from the cache the next time a full
    // resync runs (which happens on every logic-version bump, not just
    // first install), even though the trip is still upcoming. Preserve any
    // cached row whose resolved travel window hasn't ended yet, regardless
    // of whether this scan's date window happened to re-find its email.
    if (isFullSync) {
      const now = Date.now();
      const stillUpcomingIds = cached
        .filter((b) => {
          const end = b.travelDateEnd ?? b.travelDate;
          return end != null && new Date(end).getTime() >= now;
        })
        .map((b) => b.id);
      const keepIds = [...new Set([...context.items.map((b) => b.id), ...stillUpcomingIds])];
      await pruneBookingsNotIn(keepIds);
    }
    await AsyncStorage.setItem(BOOKINGS_SYNC_LOGIC_VERSION_KEY, BOOKINGS_SYNC_LOGIC_VERSION);
    return { items: await getCachedBookings() };
  } catch (err) {
    // Network/auth failure — degrade to whatever's cached rather than
    // losing everything, but still surface the error.
    return { items: cached, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildUpcomingData(events: CalendarEvent[], bookings: BookingItem[], bookingsError: string | undefined, isSyncing: boolean): UpcomingData {
  const todayMs = dayStart(new Date());

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

  return { calendarItems, bookingItems, trips, fetchedAt: Date.now(), bookingsError, isSyncing };
}

/**
 * @param onUpdate Fired twice when a real Gmail sync is due: immediately with
 *   whatever's already cached (feels instant for the common case), then again
 *   once the fresh sync resolves. Fired once, synchronously with the final
 *   result, when no sync is due — cached data and fresh data are the same
 *   thing in that case, so there's nothing to show early. Callers that only
 *   care about the final result can ignore it and use the returned Promise.
 */
export async function loadUpcomingEvents(googleAuthed: boolean, onUpdate?: (data: UpcomingData) => void): Promise<UpcomingData> {
  if (!googleAuthed) {
    const empty = buildUpcomingData([], [], undefined, false);
    onUpdate?.(empty);
    return empty;
  }

  const [events, cachedBookings, syncDue] = await Promise.all([
    getUpcomingCalendarEvents(30).catch(() => [] as CalendarEvent[]),
    getCachedBookings().catch(() => [] as BookingItem[]),
    isBookingsSyncDue().catch(() => false),
  ]);

  if (!syncDue) {
    const data = buildUpcomingData(events, cachedBookings, undefined, false);
    onUpdate?.(data);
    return data;
  }

  // A real sync is about to run (first launch, interval elapsed, or a logic
  // version bump) — paint cached bookings immediately rather than blocking
  // the whole screen on the Gmail fetch + classification round trip below.
  onUpdate?.(buildUpcomingData(events, cachedBookings, undefined, true));

  const bookResult = await syncBookings(googleAuthed);
  const finalData = buildUpcomingData(events, bookResult.items, bookResult.error, false);
  onUpdate?.(finalData);
  return finalData;
}
