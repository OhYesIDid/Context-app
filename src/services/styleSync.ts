import { NativeModules } from 'react-native';
import { getRecentStyleEdits, recordStyleEdit } from './database';
import type { Intent, Platform } from '../types';

interface QueueItem {
  original: string;
  edit: string;
  platform: string;
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
    if (!item.original || !item.edit) continue;
    await recordStyleEdit({
      originalSuggestion: item.original,
      userEdit: item.edit,
      platform: item.platform as Platform,
      intent: item.intent as Intent | undefined,
    });
  }
}

async function rebuildCachedProfile(): Promise<void> {
  const edits = await getRecentStyleEdits(20);

  // Only include edits where the user meaningfully changed the suggestion
  const normalize = (s: string) => s.toLowerCase().replace(/[.,!?\s]+$/, '').trim();
  const meaningful = edits.filter(
    (e) => e.userEdit.length > 0 && normalize(e.userEdit) !== normalize(e.originalSuggestion)
  );
  if (meaningful.length === 0) return;

  const examples = meaningful
    .slice(0, 10)
    .map((e) => `• "${e.originalSuggestion}" → "${e.userEdit}"`)
    .join('\n');

  const profile = `User's writing style (suggestion → what they actually sent):\n${examples}`;
  NativeModules.ContextReplySettings.cacheStyleProfile(profile);
}
