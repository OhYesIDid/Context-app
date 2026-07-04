import type { BookingType, CalendarEvent, BookingItem } from '../types';
import { getUpcomingCalendarEvents } from './googleCalendar';
import { getBookingsContext } from './googleBookings';

export const BOOKING_ICONS: Record<BookingType, string> = {
  flight:      '✈️',
  hotel:       '🏨',
  train:       '🚂',
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
}

export type UpcomingItem = UpcomingCalendarItem | UpcomingBookingItem;

export interface UpcomingData {
  calendarItems: UpcomingCalendarItem[];
  bookingItems: UpcomingBookingItem[];
  fetchedAt: number;
  /** Set when the Gmail booking fetch failed outright (timeout, auth, API error) — surfaced in the UI instead of silently showing an empty list. */
  bookingsError?: string;
}

export const UPCOMING_EMPTY: UpcomingData = { calendarItems: [], bookingItems: [], fetchedAt: 0 };

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

export async function loadUpcomingEvents(googleAuthed: boolean, gmailConnected: boolean): Promise<UpcomingData> {
  console.error(`DBGUPCOMING call googleAuthed=${googleAuthed} gmailConnected=${gmailConnected}`); // TEMP-DEBUG
  const [calResult, bookResult] = await Promise.allSettled([
    googleAuthed
      ? getUpcomingCalendarEvents(30)
      : Promise.resolve([] as CalendarEvent[]),
    gmailConnected
      ? getBookingsContext(30)
      : Promise.resolve({ items: [] as BookingItem[], windowStart: '', windowEnd: '' }),
  ]);

  const events = calResult.status === 'fulfilled' ? calResult.value : [];
  const bookings = bookResult.status === 'fulfilled' ? bookResult.value.items : [];
  const bookingsError = bookResult.status === 'rejected'
    ? (bookResult.reason instanceof Error ? bookResult.reason.message : String(bookResult.reason))
    : undefined;
  console.error(`DBGUPCOMING result calStatus=${calResult.status} bookStatus=${bookResult.status} bookingsCount=${bookings.length} bookingsError=${bookingsError} eventsCount=${events.length}`); // TEMP-DEBUG
  if (bookResult.status === 'fulfilled') {
    console.error(`DBGUPCOMING bookings=${JSON.stringify(bookings.map(b => ({ subject: b.subject, date: b.date, travelDate: b.travelDate })))}`); // TEMP-DEBUG
  }
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

  const bookingItems: UpcomingBookingItem[] = bookings
    .map(b => {
      const travelMs = b.travelDate ? new Date(b.travelDate).getTime() : NaN;
      const isUpcomingTravel = !Number.isNaN(travelMs) && travelMs >= todayMs;
      const date = isUpcomingTravel ? new Date(travelMs) : new Date(b.date);
      const eventMs = dayStart(date);
      return {
        kind: 'booking' as const,
        id: b.id,
        bookingType: b.type,
        icon: BOOKING_ICONS[b.type] ?? '📋',
        title: b.subject.length > 60 ? b.subject.slice(0, 57) + '…' : b.subject,
        subtitle: isUpcomingTravel ? formatTravelSubtitle(date) : formatBookingSubtitle(b),
        date,
        isToday: isUpcomingTravel && eventMs === todayMs,
        isTomorrow: isUpcomingTravel && eventMs === todayMs + 86400000,
        isUpcomingTravel,
      };
    })
    // Upcoming travel first (soonest first), then recent confirmations (most recent first).
    .sort((a, b) => {
      if (a.isUpcomingTravel !== b.isUpcomingTravel) return a.isUpcomingTravel ? -1 : 1;
      return a.isUpcomingTravel ? a.date.getTime() - b.date.getTime() : b.date.getTime() - a.date.getTime();
    })
    .slice(0, 8);

  return { calendarItems, bookingItems, fetchedAt: Date.now(), bookingsError };
}
