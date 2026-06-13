import { NativeModules } from 'react-native';
import { getAllContacts, getRecentStyleEdits, incrementContactInteraction, recordStyleEdit } from './database';
import type { Intent, Platform, StyleEdit } from '../types';

interface QueueItem {
  original: string;
  edit: string;
  platform: string;
  contact?: string;
  intent?: string;
  ts: number;
}

// Drain the Kotlin-side SharedPrefs queue into SQLite, then rebuild and
// cache the style profile string so the background worker can use it.
export async function syncStyleProfile(): Promise<void> {
  try {
    await drainQueue();
    await drainCorrections();
    await rebuildCachedProfile();
  } catch (_) {}
}

async function drainQueue(): Promise<void> {
  const json: string = await NativeModules.ProTxtSettings.drainStyleQueue();
  const items: QueueItem[] = JSON.parse(json);
  if (items.length === 0) return;
  // Load contacts once so we can match edit → contactId for per-contact style learning
  const contacts = await getAllContacts();
  for (const item of items) {
    if (!item.original) continue;
    const matched = item.contact
      ? contacts.find((c) => c.displayName.toLowerCase() === item.contact!.toLowerCase())
      : undefined;
    await recordStyleEdit({
      originalSuggestion: item.original,
      userEdit: item.edit,
      platform: item.platform as Platform,
      intent: item.intent as Intent | undefined,
      contactId: matched?.id,
    });
    if (item.contact) await incrementContactInteraction(item.contact);
  }
}

interface IntentCorrection {
  ts: number;
  from: string[];
  to: string[];
  message: string;
}

async function drainCorrections(): Promise<void> {
  const json: string = await NativeModules.ProTxtSettings.drainIntentCorrections();
  const corrections: IntentCorrection[] = JSON.parse(json);
  if (corrections.length === 0) return;
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  const existing = await AsyncStorage.getItem('intent_corrections').catch(() => null);
  const prev: IntentCorrection[] = existing ? JSON.parse(existing) : [];
  const merged = [...prev, ...corrections].slice(-50);
  await AsyncStorage.setItem('intent_corrections', JSON.stringify(merged));
}

async function rebuildCachedProfile(): Promise<void> {
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  const [edits, contacts, correctionsJson] = await Promise.all([
    getRecentStyleEdits(60),
    getAllContacts(),
    AsyncStorage.getItem('intent_corrections').catch(() => null),
  ]);
  const corrections: IntentCorrection[] = correctionsJson ? JSON.parse(correctionsJson) : [];

  const now = Date.now();
  const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  const recencyScore = (e: StyleEdit) => Math.exp(-(now - new Date(e.createdAt).getTime()) / HALF_LIFE_MS);

  const normalize = (s: string) => s.toLowerCase().replace(/[.,!?\s]+$/, '').trim();

  // Split into meaningful edits and dismissals, sorted most-recent first
  const meaningful = edits
    .filter((e) => e.userEdit.length > 0 && normalize(e.userEdit) !== normalize(e.originalSuggestion))
    .sort((a, b) => recencyScore(b) - recencyScore(a));

  const dismissed = edits
    .filter((e) => e.userEdit.length === 0)
    .sort((a, b) => recencyScore(b) - recencyScore(a))
    .slice(0, 5);

  const sections: string[] = [];

  // ── General style examples (top 6 by recency-weighted score) ─────────────
  const topExamples = meaningful.slice(0, 6);
  if (topExamples.length > 0) {
    const lines = topExamples.map((e) => `• "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    sections.push(`User's writing style (suggestion → what they actually sent):\n${lines}`);
  }

  // ── Per-intent examples ───────────────────────────────────────────────────
  const INTENT_LABEL: Record<string, string> = {
    eta: 'ETA / location messages',
    availability: 'availability / calendar messages',
    other: 'general messages',
  };
  const intentGroups: Record<string, StyleEdit[]> = {};
  for (const e of meaningful) {
    const intent = e.intent ?? 'other';
    (intentGroups[intent] ??= []).push(e);
  }
  const intentLines: string[] = [];
  for (const [intent, group] of Object.entries(intentGroups)) {
    if (group.length < 2) continue;
    const label = INTENT_LABEL[intent] ?? intent;
    const examples = group.slice(0, 3).map((e) => `  • "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    intentLines.push(`${label}:\n${examples}`);
  }
  if (intentLines.length > 0) {
    sections.push(`Style by message type:\n${intentLines.join('\n')}`);
  }

  // ── Contact-specific examples ─────────────────────────────────────────────
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const contactGroups: Record<string, StyleEdit[]> = {};
  for (const e of meaningful) {
    if (!e.contactId) continue;
    (contactGroups[e.contactId] ??= []).push(e);
  }
  const contactStyleLines: string[] = [];
  for (const [contactId, group] of Object.entries(contactGroups)) {
    if (group.length < 2) continue;
    const contact = contactById[contactId];
    if (!contact) continue;
    const examples = group.slice(0, 2).map((e) => `  • "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    contactStyleLines.push(`With ${contact.displayName}:\n${examples}`);
  }
  if (contactStyleLines.length > 0) {
    sections.push(`Style with specific contacts:\n${contactStyleLines.join('\n')}`);
  }

  // ── Dismissed suggestions ─────────────────────────────────────────────────
  if (dismissed.length >= 2) {
    const lines = dismissed.map((e) => `• "${e.originalSuggestion}"`).join('\n');
    sections.push(`Suggestions the user has rejected (avoid similar phrasing):\n${lines}`);
  }

  // ── Per-contact preferences ───────────────────────────────────────────────
  const withPrefs = contacts.filter((c) => c.relationship || c.preferredTone);
  if (withPrefs.length > 0) {
    const lines = withPrefs.map((c) => {
      const parts: string[] = [];
      if (c.relationship) parts.push(c.relationship);
      if (c.preferredTone) parts.push(`prefer ${c.preferredTone} tone`);
      return `• ${c.displayName} — ${parts.join(', ')}`;
    }).join('\n');
    sections.push(`Contact preferences:\n${lines}`);
  }

  // ── Intent corrections ────────────────────────────────────────────────────
  const recent = corrections.slice(-10);
  if (recent.length > 0) {
    const lines = recent.map((c) => `• "${c.message.slice(0, 80)}" — missed: ${c.from.join('+')} should be ${c.to.join('+')}`).join('\n');
    sections.push(`Intent corrections (user flagged missing context):\n${lines}`);
  }

  // Write per-contact tone map so BgService can pre-select the right bubble tab
  const toneMap: Record<string, string> = {};
  for (const c of contacts) {
    if (c.preferredTone) toneMap[c.displayName.toLowerCase()] = c.preferredTone;
  }
  NativeModules.ProTxtSettings.cacheContactTones(JSON.stringify(toneMap));

  if (sections.length === 0) return;
  NativeModules.ProTxtSettings.cacheStyleProfile(sections.join('\n\n'));
}
