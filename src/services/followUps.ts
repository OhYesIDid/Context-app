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

// Converts the model's ISO 8601 local datetime (or null/invalid) into a ms timestamp for
// FollowUp.dueAt. Was previously discarded entirely at every addFollowUp() call site, so an
// AI-created follow-up always lost its extracted deadline and sorted as urgency 'none'
// regardless of what was actually said (e.g. "by tomorrow").
export function parseDueAt(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export async function loadFollowUps(): Promise<FollowUp[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FollowUp[]) : [];
  } catch { return []; }
}

async function persist(items: FollowUp[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
}

// Task-phrasing filler words to strip before comparing two follow-ups' text — the AI can
// re-propose the "same" real-world task worded differently across messages in a conversation
// ("Call the dentist" vs "Remind me to call the dentist about the appointment"), and each
// wording gets its own id (computeActionId hashes convKey+task on the native side), so exact-id
// dedup alone doesn't catch it. Deliberately a plain word list, not a stemmer — this only needs
// to strip the connective phrasing the model tends to add/drop, not handle every inflection.
const TASK_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'about', 'on', 'with', 'of', 'up',
  'remind', 'me', 'follow', 'need', 'should', 'please', 'just',
  'him', 'her', 'them', 'it', 'that', 'this',
]);

function normalizeTaskWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TASK_FILLER_WORDS.has(w));
  return new Set(words);
}

// Containment score (overlap ÷ smaller set), not Jaccard (overlap ÷ union) — deliberately
// lenient toward one wording being a strict superset of the other's content words, which is
// exactly the shape re-proposed-with-more-detail follow-ups take. Returns 0 if either side
// has no content words left after stripping filler (e.g. two single-filler-word inputs), so
// that case falls through to "not a duplicate" rather than a spurious match.
export function taskTextSimilarity(a: string, b: string): number {
  const wa = normalizeTaskWords(a);
  const wb = normalizeTaskWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.min(wa.size, wb.size);
}

// 0.7 was picked to catch "Call the dentist" / "Remind me to call the dentist about the
// appointment" (full containment of the shorter phrasing's content words) while still telling
// apart same-verb-different-object tasks like "Call the dentist" / "Call the vet" (0.5).
const DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

function sameContact(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

export async function addFollowUp(draft: Omit<FollowUp, 'id' | 'createdAt' | 'status'>): Promise<FollowUp[]> {
  const items = await loadFollowUps();

  // Merge into an existing PENDING (not yet done) follow-up for the same contact with
  // near-identical wording, instead of appending a second entry for what's really the same
  // task re-confirmed under different phrasing. A 'done' match is left alone — a task someone
  // already finished being proposed again later is either a fresh recurrence or worth a
  // second look, not something to silently swallow.
  const dupe = items.find((i) =>
    i.status === 'pending'
    && sameContact(i.contactName, draft.contactName)
    && taskTextSimilarity(i.text, draft.text) >= DUPLICATE_SIMILARITY_THRESHOLD
  );
  if (dupe) {
    if (draft.dueAt != null && (dupe.dueAt == null || draft.dueAt < dupe.dueAt)) {
      const next = items.map((i) => (i.id === dupe.id ? { ...i, dueAt: draft.dueAt } : i));
      await persist(next);
      return next;
    }
    return items;
  }

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
