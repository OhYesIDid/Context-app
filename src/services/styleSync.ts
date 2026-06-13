import { NativeModules } from 'react-native';
import { getAllContacts, getRecentStyleEdits, incrementContactInteraction, recordStyleEdit } from './database';
import type { Intent, Platform } from '../types';

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
  for (const item of items) {
    if (!item.original) continue;
    await recordStyleEdit({
      originalSuggestion: item.original,
      userEdit: item.edit,
      platform: item.platform as Platform,
      intent: item.intent as Intent | undefined,
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
  // Append to AsyncStorage so rebuildCachedProfile can include them in the style profile
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  const existing = await AsyncStorage.getItem('intent_corrections').catch(() => null);
  const prev: IntentCorrection[] = existing ? JSON.parse(existing) : [];
  const merged = [...prev, ...corrections].slice(-50);
  await AsyncStorage.setItem('intent_corrections', JSON.stringify(merged));
}

async function rebuildCachedProfile(): Promise<void> {
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  const [edits, contacts, correctionsJson] = await Promise.all([
    getRecentStyleEdits(20),
    getAllContacts(),
    AsyncStorage.getItem('intent_corrections').catch(() => null),
  ]);
  const corrections: IntentCorrection[] = correctionsJson ? JSON.parse(correctionsJson) : [];

  const sections: string[] = [];

  // Style examples — exclude dismissed (empty edit) and trivial no-ops
  const normalize = (s: string) => s.toLowerCase().replace(/[.,!?\s]+$/, '').trim();
  const meaningful = edits.filter(
    (e) => e.userEdit.length > 0 && normalize(e.userEdit) !== normalize(e.originalSuggestion)
  );
  if (meaningful.length > 0) {
    const examples = meaningful
      .slice(0, 10)
      .map((e) => `• "${e.originalSuggestion}" → "${e.userEdit}"`)
      .join('\n');
    sections.push(`User's writing style (suggestion → what they actually sent):\n${examples}`);
  }

  // Per-contact preferences — only include contacts with at least one pref set
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

  // Intent corrections — tell the worker which contexts were missed so it can compensate
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
