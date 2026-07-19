import AsyncStorage from '@react-native-async-storage/async-storage';

export interface FollowUp {
  id: string;
  text: string;
  contactName?: string;
  appName?: string;
  dueAt?: number; // ms timestamp; undefined = someday
  createdAt: number;
  status: 'pending' | 'done';
}

const KEY = 'contxt_follow_ups_v1';

export async function loadFollowUps(): Promise<FollowUp[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FollowUp[]) : [];
  } catch { return []; }
}

async function persist(items: FollowUp[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}

export async function addFollowUp(draft: Omit<FollowUp, 'id' | 'createdAt' | 'status'>): Promise<FollowUp[]> {
  const items = await loadFollowUps();
  // Date.now() alone can collide if two follow-ups are added within the same millisecond
  // (e.g. a fast double-tap) — markDone/deleteFollowUp match by id, so a collision would
  // silently act on both entries at once. The random suffix makes that practically impossible.
  const id = `fu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const item: FollowUp = { ...draft, id, createdAt: Date.now(), status: 'pending' };
  const next = [item, ...items];
  await persist(next);
  return next;
}

export async function markDone(id: string): Promise<FollowUp[]> {
  const items = await loadFollowUps();
  const next = items.map(i => i.id === id ? { ...i, status: 'done' as const } : i);
  await persist(next);
  return next;
}

export async function deleteFollowUp(id: string): Promise<FollowUp[]> {
  const items = await loadFollowUps();
  const next = items.filter(i => i.id !== id);
  await persist(next);
  return next;
}

export function urgency(f: FollowUp): 'overdue' | 'today' | 'soon' | 'later' | 'none' {
  if (!f.dueAt) return 'none';
  const now = Date.now();
  if (f.dueAt < now) return 'overdue';
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  if (f.dueAt <= endOfToday.getTime()) return 'today';
  if (f.dueAt - now < 3 * 86_400_000) return 'soon';
  return 'later';
}

export function formatDueLabel(f: FollowUp): string {
  if (!f.dueAt) return '';
  const now = Date.now();
  const diff = f.dueAt - now;
  if (diff < 0) {
    const h = Math.floor(-diff / 3_600_000);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'now';
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  if (f.dueAt <= endOfToday.getTime()) return `by ${new Date(f.dueAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  const endOfTomorrow = new Date(endOfToday.getTime() + 86_400_000);
  if (f.dueAt <= endOfTomorrow.getTime()) return 'tomorrow';
  return new Date(f.dueAt).toLocaleDateString('en-GB', { weekday: 'short' });
}
