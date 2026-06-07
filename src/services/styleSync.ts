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
    await rebuildCachedProfile();
  } catch (_) {}
}

async function drainQueue(): Promise<void> {
  const json: string = await NativeModules.ContextReplySettings.drainStyleQueue();
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

async function rebuildCachedProfile(): Promise<void> {
  const [edits, contacts] = await Promise.all([
    getRecentStyleEdits(20),
    getAllContacts(),
  ]);

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

  if (sections.length === 0) return;
  NativeModules.ContextReplySettings.cacheStyleProfile(sections.join('\n\n'));
}
