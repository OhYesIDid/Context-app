import { NativeModules } from 'react-native';
import {
  ensureContactForConversation,
  findContactIdByIdentifier,
  getAllContacts,
  getConfirmedPlatformIdentities,
  getContactsByIds,
  getContactsWithPreferences,
  getDatabase,
  getRecentStyleEdits,
  incrementContactInteraction,
  mergeContact,
  recordStyleEdit,
  upsertPlatformIdentity,
} from './database';
import type { Intent, Platform, StyleEdit } from '../types';

const PACKAGE_TO_PLATFORM: Record<string, Platform> = {
  'com.whatsapp':                      'whatsapp',
  'com.whatsapp.w4b':                  'whatsapp',
  'org.telegram.messenger':            'telegram',
  'com.instagram.android':             'instagram',
  'com.facebook.orca':                 'messenger',
  'org.thoughtcrime.securesms':        'signal',
  'com.google.android.apps.messaging': 'sms',
};

interface QueueItem {
  original: string;
  edit: string;
  platform: string;
  contact?: string;
  intent?: string;
  tone_selected?: string;
  ts: number;
}

interface PendingContact {
  convKey: string;
  senderName: string;
  platform: string;
}

interface IntentCorrection {
  ts: number;
  from: string[];
  to: string[];
  message: string;
}

// Drain the Kotlin-side SharedPrefs queues into SQLite, then rebuild and
// cache the style profile string so the background worker can use it.
// On a typical startup with empty queues this returns immediately — no
// contact decryption, no DB work.
export async function syncStyleProfile(): Promise<void> {
  try {
    // Restore confirmed identities to SharedPrefs if it was wiped (reinstall).
    // Fast: reads SharedPrefs + at most one small SQLite query.
    await restoreConfirmedIdentitiesFromDb();

    // Drain all Kotlin queues in parallel — pure SharedPrefs reads, no DB yet.
    const [confirmedJson, queueJson, correctionsJson, pendingJson] = await Promise.all([
      NativeModules.ProTxtSettings.getConfirmedIdentities(),
      NativeModules.ProTxtSettings.drainStyleQueue(),
      NativeModules.ProTxtSettings.drainIntentCorrections(),
      NativeModules.ProTxtSettings.drainPendingContacts(),
    ]);

    const confirmed: Record<string, string> = JSON.parse(confirmedJson);
    const queue: QueueItem[] = JSON.parse(queueJson);
    const corrections: IntentCorrection[] = JSON.parse(correctionsJson);
    const pending: PendingContact[] = JSON.parse(pendingJson);

    // Nothing pending — cached profile in SharedPrefs is still valid, stop here.
    if (
      Object.keys(confirmed).length === 0 &&
      queue.length === 0 &&
      corrections.length === 0 &&
      pending.length === 0
    ) return;

    // Process only non-empty queues, each using targeted SQL (no getAllContacts).
    if (Object.keys(confirmed).length > 0) await drainConfirmedIdentities(confirmed);
    if (pending.length > 0) await drainPendingContacts(pending);
    if (queue.length > 0) await drainQueue(queue);
    if (corrections.length > 0) await drainCorrections(corrections);

    await rebuildCachedProfile();
  } catch (_) {}
}

// Rebuild and push the full contact list to Kotlin for fuzzy name matching.
// Call after contact imports or when a contact preference changes — not on
// every startup.
export async function refreshContactListCache(): Promise<void> {
  const contacts = await getAllContacts();
  const contactList = contacts.map((c) => ({
    id: c.id,
    display_name: c.displayName,
    preferred_tone: c.preferredTone ?? inferredTone(c.relationship) ?? null,
    interaction_count: c.interactionCount ?? 0,
  }));
  NativeModules.ProTxtSettings.cacheContactList(JSON.stringify(contactList));
}

async function restoreConfirmedIdentitiesFromDb(): Promise<void> {
  const existing: string = await NativeModules.ProTxtSettings.getConfirmedIdentities();
  if (Object.keys(JSON.parse(existing)).length > 0) return;
  const identities = await getConfirmedPlatformIdentities();
  if (identities.length === 0) return;
  const map: Record<string, string> = {};
  for (const identity of identities) {
    map[`${identity.platform}:${identity.identifier}`] = identity.contactId;
  }
  NativeModules.ProTxtSettings.restoreConfirmedIdentities(JSON.stringify(map));
}

async function drainConfirmedIdentities(confirmed: Record<string, string>): Promise<void> {
  for (const [convKey, contactId] of Object.entries(confirmed)) {
    const colonIdx = convKey.indexOf(':');
    if (colonIdx < 0) continue;
    const packageName = convKey.slice(0, colonIdx);
    const senderName = convKey.slice(colonIdx + 1);
    if (!senderName || senderName.startsWith('group:') || senderName.startsWith('id:')) continue;
    const platform = (PACKAGE_TO_PLATFORM[packageName] ?? packageName) as Platform;

    let sqliteContactId: string | null = null;
    if (!contactId.startsWith('device:')) {
      // Direct UUID — check existence without loading all contacts
      const db = await getDatabase();
      const row = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL', [contactId]
      );
      sqliteContactId = row?.id ?? null;
    } else {
      // Device contact — look up by identifier first (fast), fall back to cache
      sqliteContactId = await findContactIdByIdentifier(senderName);
      if (!sqliteContactId) {
        // Legacy imported contact without display_name identity — use cache (rare)
        const contacts = await getAllContacts();
        const match = contacts.find((c) => c.displayName.toLowerCase() === senderName.toLowerCase());
        sqliteContactId = match?.id ?? null;
      }
    }
    if (!sqliteContactId) continue;

    // Merge any auto-created contact with the same identifier into the confirmed one
    const autoId = await findContactIdByIdentifier(senderName);
    if (autoId && autoId !== sqliteContactId) {
      await mergeContact(autoId, sqliteContactId);
    }

    await upsertPlatformIdentity({
      contactId: sqliteContactId,
      platform,
      identifier: senderName,
      identifierType: 'display_name',
      confidence: 1.0,
      userConfirmed: true,
    });
  }
}

async function drainPendingContacts(pending: PendingContact[]): Promise<void> {
  for (const item of pending) {
    if (!item.senderName || !item.platform) continue;
    await ensureContactForConversation(item.senderName, item.platform);
  }
}

async function drainQueue(items: QueueItem[]): Promise<void> {
  for (const item of items) {
    if (!item.original) continue;
    const isSend = item.edit.length > 0;

    let contactId: string | undefined;
    if (item.contact) {
      // Plaintext lookup via platform_identities — no decryption
      const id = await findContactIdByIdentifier(item.contact);
      if (id) {
        contactId = id;
      } else if (isSend) {
        // Auto-create on first send — ensureContactForConversation creates both
        // contact + platform_identity so future lookups work without all-contacts load
        contactId = await ensureContactForConversation(item.contact, item.platform);
      }
    }

    const editDelta = isSend ? computeEditDelta(item.original, item.edit) : undefined;
    await recordStyleEdit({
      originalSuggestion: item.original,
      userEdit: item.edit,
      platform: item.platform as Platform,
      intent: item.intent as Intent | undefined,
      toneSelected: item.tone_selected,
      editDeltaJson: editDelta ? JSON.stringify(editDelta) : undefined,
      contactId,
    });
    if (contactId) {
      await incrementContactInteraction(contactId);
    }
  }
}

async function drainCorrections(corrections: IntentCorrection[]): Promise<void> {
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  const existing = await AsyncStorage.getItem('intent_corrections').catch(() => null);
  const prev: IntentCorrection[] = existing ? JSON.parse(existing) : [];
  const merged = [...prev, ...corrections].slice(-50);
  await AsyncStorage.setItem('intent_corrections', JSON.stringify(merged));
}

// ── Edit delta ────────────────────────────────────────────────────────────────

interface EditDelta {
  wordsRemoved: string[];
  wordsAdded: string[];
  characterDelta: number;
  shortened: boolean;
}

function computeEditDelta(original: string, edited: string): EditDelta {
  const tokenize = (s: string) => s.toLowerCase().match(/\b\w+\b/g) ?? [];
  const origWords = new Set(tokenize(original));
  const editWords = new Set(tokenize(edited));
  return {
    wordsRemoved: [...origWords].filter((w) => !editWords.has(w)),
    wordsAdded: [...editWords].filter((w) => !origWords.has(w)),
    characterDelta: edited.length - original.length,
    shortened: edited.length < original.length * 0.7,
  };
}

function inferredTone(relationship: string | undefined): string | undefined {
  switch (relationship) {
    case 'colleague': return 'formal';
    case 'partner':
    case 'friend':
    case 'family': return 'casual';
    case 'flatmate': return 'brief';
    default: return undefined;
  }
}

async function rebuildCachedProfile(): Promise<void> {
  const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
  const [edits, correctionsJson] = await Promise.all([
    getRecentStyleEdits(60),
    AsyncStorage.getItem('intent_corrections').catch(() => null),
  ]);
  const corrections: IntentCorrection[] = correctionsJson ? JSON.parse(correctionsJson) : [];

  // Fetch only the contacts we actually need — no full table scan
  const contactIds = [...new Set(edits.map((e) => e.contactId).filter((id): id is string => !!id))];
  const [editContacts, prefContacts] = await Promise.all([
    getContactsByIds(contactIds),
    getContactsWithPreferences(),
  ]);
  const contactById = Object.fromEntries(
    [...editContacts, ...prefContacts].map((c) => [c.id, c])
  );

  const now = Date.now();
  const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
  const recencyScore = (e: StyleEdit) => Math.exp(-(now - new Date(e.createdAt).getTime()) / HALF_LIFE_MS);
  const normalize = (s: string) => s.toLowerCase().replace(/[.,!?\s]+$/, '').trim();

  const meaningful = edits
    .filter((e) => e.userEdit.length > 0 && normalize(e.userEdit) !== normalize(e.originalSuggestion))
    .sort((a, b) => recencyScore(b) - recencyScore(a));

  const sendTsByContact = new Map<string, number[]>();
  for (const e of meaningful) {
    if (!e.contactId) continue;
    (sendTsByContact.get(e.contactId) ?? sendTsByContact.set(e.contactId, []).get(e.contactId)!).push(
      new Date(e.createdAt).getTime()
    );
  }
  const dismissed = edits
    .filter((e) => {
      if (e.userEdit.length !== 0) return false;
      if (!e.contactId) return true;
      const dismissTs = new Date(e.createdAt).getTime();
      const sends = sendTsByContact.get(e.contactId) ?? [];
      return !sends.some((ts) => ts > dismissTs && ts - dismissTs < 2 * 60_000);
    })
    .sort((a, b) => recencyScore(b) - recencyScore(a))
    .slice(0, 3);

  const sections: string[] = [];

  const topExamples = meaningful.slice(0, 6);
  if (topExamples.length > 0) {
    const lines = topExamples.map((e) => `• "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    sections.push(`User's writing style (suggestion → what they actually sent):\n${lines}`);
  }

  const wordRemovedCount = new Map<string, number>();
  const wordAddedCount = new Map<string, number>();
  let shortenCount = 0;
  for (const e of meaningful) {
    const delta: EditDelta = e.editDeltaJson
      ? JSON.parse(e.editDeltaJson)
      : computeEditDelta(e.originalSuggestion, e.userEdit);
    for (const w of delta.wordsRemoved) wordRemovedCount.set(w, (wordRemovedCount.get(w) ?? 0) + 1);
    for (const w of delta.wordsAdded) wordAddedCount.set(w, (wordAddedCount.get(w) ?? 0) + 1);
    if (delta.shortened) shortenCount++;
  }
  const alwaysRemoves = [...wordRemovedCount.entries()].filter(([, n]) => n >= 2).map(([w]) => w);
  const alwaysAdds = [...wordAddedCount.entries()].filter(([, n]) => n >= 2).map(([w]) => w);
  const patternLines: string[] = [];
  if (alwaysRemoves.length > 0) patternLines.push(`• Always removes: ${alwaysRemoves.join(', ')}`);
  if (alwaysAdds.length > 0) patternLines.push(`• Always adds: ${alwaysAdds.join(', ')}`);
  if (meaningful.length >= 3 && shortenCount / meaningful.length > 0.6)
    patternLines.push(`• Consistently shortens suggestions (shortened ${shortenCount}/${meaningful.length} times)`);
  if (patternLines.length > 0) sections.push(`Word-level patterns:\n${patternLines.join('\n')}`);

  const toneGroups: Record<string, StyleEdit[]> = {};
  for (const e of meaningful) {
    const tone = e.toneSelected ?? 'casual';
    (toneGroups[tone] ??= []).push(e);
  }
  const toneLines: string[] = [];
  for (const [tone, group] of Object.entries(toneGroups)) {
    if (group.length < 2) continue;
    const examples = group.slice(0, 3).map((e) => `  • "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    toneLines.push(`${tone.charAt(0).toUpperCase() + tone.slice(1)}:\n${examples}`);
  }
  if (toneLines.length > 0) sections.push(`Style by tone:\n${toneLines.join('\n')}`);

  const INTENT_LABEL: Record<string, string> = {
    eta: 'ETA / location',
    availability: 'availability / scheduling',
    other: 'general',
  };
  const intentGroups: Record<string, StyleEdit[]> = {};
  for (const e of meaningful) {
    const intent = e.intent ?? 'other';
    (intentGroups[intent] ??= []).push(e);
  }
  const intentLines: string[] = [];
  for (const [intent, group] of Object.entries(intentGroups)) {
    if (group.length < 2) continue;
    const examples = group.slice(0, 3).map((e) => `  • "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    intentLines.push(`${INTENT_LABEL[intent] ?? intent}:\n${examples}`);
  }
  if (intentLines.length > 0) sections.push(`Style by message type:\n${intentLines.join('\n')}`);

  const contactGroups: Record<string, StyleEdit[]> = {};
  for (const e of meaningful) {
    if (!e.contactId) continue;
    (contactGroups[e.contactId] ??= []).push(e);
  }
  const contactStyleLines: string[] = [];
  for (const [id, group] of Object.entries(contactGroups)) {
    if (group.length < 2) continue;
    const contact = contactById[id];
    if (!contact) continue;
    const examples = group.slice(0, 2).map((e) => `  • "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    contactStyleLines.push(`With ${contact.displayName}:\n${examples}`);
  }
  if (contactStyleLines.length > 0) sections.push(`Style with specific contacts:\n${contactStyleLines.join('\n')}`);

  if (dismissed.length >= 2) {
    const lines = dismissed.map((e) => `• "${e.originalSuggestion}"`).join('\n');
    sections.push(`Suggestions the user has rejected (avoid similar phrasing):\n${lines}`);
  }

  const withPrefs = prefContacts;
  if (withPrefs.length > 0) {
    const lines = withPrefs.map((c) => {
      const parts: string[] = [];
      if (c.relationship) parts.push(c.relationship);
      const tone = c.preferredTone ?? inferredTone(c.relationship);
      if (tone) parts.push(`prefer ${tone} tone`);
      return `• ${c.displayName} — ${parts.join(', ')}`;
    }).join('\n');
    sections.push(`Contact preferences:\n${lines}`);
  }

  const recent = corrections.slice(-10);
  if (recent.length > 0) {
    const lines = recent.map((c) => `• "${c.message.slice(0, 80)}" — missed: ${c.from.join('+')} should be ${c.to.join('+')}`).join('\n');
    sections.push(`Intent corrections (user flagged missing context):\n${lines}`);
  }

  // Tone map: only contacts with preferences (tiny subset)
  const toneMap: Record<string, string> = {};
  for (const c of prefContacts) {
    const tone = c.preferredTone ?? inferredTone(c.relationship);
    if (tone) toneMap[c.displayName.toLowerCase()] = tone;
  }
  NativeModules.ProTxtSettings.cacheContactTones(JSON.stringify(toneMap));

  if (sections.length === 0) return;
  NativeModules.ProTxtSettings.cacheStyleProfile(sections.join('\n\n'));
}
