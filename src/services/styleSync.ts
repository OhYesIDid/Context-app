import { NativeModules } from 'react-native';
import { getAllContacts, getConfirmedPlatformIdentities, getRecentStyleEdits, incrementContactInteraction, recordStyleEdit, upsertPlatformIdentity } from './database';
import type { Intent, Platform, StyleEdit } from '../types';

// Maps Android package names → Platform type used in SQLite
const PACKAGE_TO_PLATFORM: Record<string, Platform> = {
  'com.whatsapp':                     'whatsapp',
  'com.whatsapp.w4b':                 'whatsapp',
  'org.telegram.messenger':           'telegram',
  'com.instagram.android':            'instagram',
  'com.facebook.orca':                'messenger',
  'org.thoughtcrime.securesms':       'signal',
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

// Drain the Kotlin-side SharedPrefs queue into SQLite, then rebuild and
// cache the style profile string so the background worker can use it.
export async function syncStyleProfile(): Promise<void> {
  try {
    await restoreConfirmedIdentitiesFromDb();
    await drainConfirmedIdentities();
    await drainQueue();
    await drainCorrections();
    await rebuildCachedProfile();
  } catch (_) {}
}

// On reinstall SharedPrefs is wiped. If it's empty but SQLite has confirmed
// identities, write them back so the background service works immediately.
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

// Reads confirmed_identities from SharedPrefs and upserts each into SQLite
// platform_identities so confirmations survive a reinstall.
async function drainConfirmedIdentities(): Promise<void> {
  const json: string = await NativeModules.ProTxtSettings.getConfirmedIdentities();
  const confirmed: Record<string, string> = JSON.parse(json);
  const entries = Object.entries(confirmed);
  if (entries.length === 0) return;
  const contacts = await getAllContacts();
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  for (const [convKey, contactId] of entries) {
    const colonIdx = convKey.indexOf(':');
    if (colonIdx < 0) continue;
    const packageName = convKey.slice(0, colonIdx);
    const senderName = convKey.slice(colonIdx + 1);
    if (!senderName || senderName.startsWith('group:') || senderName.startsWith('id:')) continue;
    const platform = (PACKAGE_TO_PLATFORM[packageName] ?? packageName) as Platform;
    // Resolve SQLite contact ID — direct UUID or device contact looked up by name
    let sqliteContactId: string | null = null;
    if (!contactId.startsWith('device:')) {
      sqliteContactId = contactById.has(contactId) ? contactId : null;
    } else {
      const match = contacts.find((c) => c.displayName.toLowerCase() === senderName.toLowerCase());
      sqliteContactId = match?.id ?? null;
    }
    if (!sqliteContactId) continue;
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
    const editDelta = item.edit.length > 0 ? computeEditDelta(item.original, item.edit) : undefined;
    await recordStyleEdit({
      originalSuggestion: item.original,
      userEdit: item.edit,
      platform: item.platform as Platform,
      intent: item.intent as Intent | undefined,
      toneSelected: item.tone_selected,
      editDeltaJson: editDelta ? JSON.stringify(editDelta) : undefined,
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

// Infer a preferred tone from relationship when none is explicitly set
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
  const [edits, contacts, correctionsJson] = await Promise.all([
    getRecentStyleEdits(60),
    getAllContacts(),
    AsyncStorage.getItem('intent_corrections').catch(() => null),
  ]);
  const corrections: IntentCorrection[] = correctionsJson ? JSON.parse(correctionsJson) : [];

  const now = Date.now();
  const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
  const recencyScore = (e: StyleEdit) => Math.exp(-(now - new Date(e.createdAt).getTime()) / HALF_LIFE_MS);
  const normalize = (s: string) => s.toLowerCase().replace(/[.,!?\s]+$/, '').trim();

  const meaningful = edits
    .filter((e) => e.userEdit.length > 0 && normalize(e.userEdit) !== normalize(e.originalSuggestion))
    .sort((a, b) => recencyScore(b) - recencyScore(a));

  // Dismissal filtering: exclude dismissals that were followed by a send for the same
  // contact within 2 minutes — those are timing dismissals (user was busy), not style signal.
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
      if (!e.contactId) return true; // no contact info — keep as signal
      const dismissTs = new Date(e.createdAt).getTime();
      const sends = sendTsByContact.get(e.contactId) ?? [];
      // Drop if user sent something for this contact within 2 minutes of the dismissal
      return !sends.some((ts) => ts > dismissTs && ts - dismissTs < 2 * 60_000);
    })
    .sort((a, b) => recencyScore(b) - recencyScore(a))
    .slice(0, 3);

  const sections: string[] = [];

  // ── General style examples ────────────────────────────────────────────────
  const topExamples = meaningful.slice(0, 6);
  if (topExamples.length > 0) {
    const lines = topExamples.map((e) => `• "${e.originalSuggestion}" → "${e.userEdit}"`).join('\n');
    sections.push(`User's writing style (suggestion → what they actually sent):\n${lines}`);
  }

  // ── Word-level patterns (aggregated from edit deltas) ─────────────────────
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

  // ── Style by tone ─────────────────────────────────────────────────────────
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

  // ── Style by intent ───────────────────────────────────────────────────────
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
  if (contactStyleLines.length > 0) sections.push(`Style with specific contacts:\n${contactStyleLines.join('\n')}`);

  // ── Rejected suggestions ──────────────────────────────────────────────────
  if (dismissed.length >= 2) {
    const lines = dismissed.map((e) => `• "${e.originalSuggestion}"`).join('\n');
    sections.push(`Suggestions the user has rejected (avoid similar phrasing):\n${lines}`);
  }

  // ── Contact preferences (explicit + inferred) ─────────────────────────────
  const withPrefs = contacts.filter((c) => c.relationship || c.preferredTone);
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

  // ── Intent corrections ────────────────────────────────────────────────────
  const recent = corrections.slice(-10);
  if (recent.length > 0) {
    const lines = recent.map((c) => `• "${c.message.slice(0, 80)}" — missed: ${c.from.join('+')} should be ${c.to.join('+')}`).join('\n');
    sections.push(`Intent corrections (user flagged missing context):\n${lines}`);
  }

  // ── Write caches to Kotlin ─────────────────────────────────────────────────
  // Tone map: explicit preferred_tone first, then infer from relationship for pre-selecting the bubble tab
  const toneMap: Record<string, string> = {};
  for (const c of contacts) {
    const tone = c.preferredTone ?? inferredTone(c.relationship);
    if (tone) toneMap[c.displayName.toLowerCase()] = tone;
  }
  NativeModules.ProTxtSettings.cacheContactTones(JSON.stringify(toneMap));

  const contactList = contacts.map((c) => ({
    id: c.id,
    display_name: c.displayName,
    preferred_tone: c.preferredTone ?? inferredTone(c.relationship) ?? null,
    interaction_count: c.interactionCount ?? 0,
  }));
  NativeModules.ProTxtSettings.cacheContactList(JSON.stringify(contactList));

  if (sections.length === 0) return;
  NativeModules.ProTxtSettings.cacheStyleProfile(sections.join('\n\n'));
}
