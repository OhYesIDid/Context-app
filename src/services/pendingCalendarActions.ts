import { NativeModules } from 'react-native';

const { ProTxtSettings } = NativeModules;

export interface PendingCalendarAction {
  id: string;
  title: string;
  datetime: string | null;
  durationMinutes: number;
  contactName: string | null;
  convKey: string;
  createdAt: number;
}

export async function loadPendingCalendarActions(): Promise<PendingCalendarAction[]> {
  try {
    const json: string = await ProTxtSettings.getPendingCalendarActions();
    return JSON.parse(json) as PendingCalendarAction[];
  } catch {
    return [];
  }
}

export function clearPendingCalendarAction(id: string): void {
  try {
    ProTxtSettings.clearPendingCalendarAction(id);
  } catch {}
}

// Formats the Google Calendar template URL's `dates=` param as START/END
// (yyyyMMddTHHmmssZ/yyyyMMddTHHmmssZ). A bare start with no end and no `/`
// isn't recognized by Google's template parser, which then silently drops the
// date and defaults the new event to "now" instead of the intended time.
export function toGoogleCalendarDateRange(action: PendingCalendarAction): string | null {
  if (!action.datetime) return null;
  const start = new Date(action.datetime);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + action.durationMinutes * 60_000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return `${fmt(start)}/${fmt(end)}`;
}

export function formatCalendarLabel(action: PendingCalendarAction): string {
  if (!action.datetime) return action.title;
  try {
    const dt = new Date(action.datetime);
    const now = new Date();
    const isToday = dt.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = dt.toDateString() === tomorrow.toDateString();
    const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today at ${time}`;
    if (isTomorrow) return `Tomorrow at ${time}`;
    return dt.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' }) + ` at ${time}`;
  } catch {
    return action.title;
  }
}
