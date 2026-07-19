// styleSync.ts glues the Kotlin-side native bridge (NativeModules.ProTxtSettings) to the
// real SQLite data layer. Rather than mocking database.ts (which would just re-assert this
// file's own call sequence), we back expo-sqlite with node:sqlite so contact/identity/style-edit
// logic runs against a real engine — the same approach as database.test.ts — and mock only the
// native bridge (stateful, mimicking real "drain empties the queue" / read-after-write semantics)
// and AsyncStorage (official mock).
import { DatabaseSync } from 'node:sqlite';
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockRawDb = new DatabaseSync(':memory:');

jest.mock('expo-sqlite', () => ({
  __esModule: true,
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: async (sql: string) => { mockRawDb.exec(sql); },
    runAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).run(...params),
    getFirstAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).all(...params),
  })),
}));

jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => require('node:crypto').randomUUID(),
  digestStringAsync: async (_algo: any, input: string) => `digest:${input}`,
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import {
  getDatabase, invalidateContactsCache, upsertContact, ensureContactForConversation,
  findContactIdByIdentifier, upsertPlatformIdentity, recordStyleEdit, getAllContacts,
} from '../database';
import { syncStyleProfile, refreshContactListCache } from '../styleSync';

interface NativeState {
  confirmedIdentities: Record<string, string>;
  styleQueue: any[];
  intentCorrections: any[];
  pendingContacts: any[];
}
let nativeState: NativeState;

beforeEach(async () => {
  await getDatabase();
  for (const table of ['platform_identities', 'memories', 'style_edits', 'contacts', 'saved_places', 'bookings']) {
    mockRawDb.exec(`DELETE FROM ${table}`);
  }
  invalidateContactsCache();
  await AsyncStorage.clear();

  nativeState = { confirmedIdentities: {}, styleQueue: [], intentCorrections: [], pendingContacts: [] };
  NativeModules.ProTxtSettings = {
    getConfirmedIdentities: jest.fn(async () => JSON.stringify(nativeState.confirmedIdentities)),
    restoreConfirmedIdentities: jest.fn(async (json: string) => { nativeState.confirmedIdentities = JSON.parse(json); }),
    drainStyleQueue: jest.fn(async () => { const q = nativeState.styleQueue; nativeState.styleQueue = []; return JSON.stringify(q); }),
    drainIntentCorrections: jest.fn(async () => { const c = nativeState.intentCorrections; nativeState.intentCorrections = []; return JSON.stringify(c); }),
    drainPendingContacts: jest.fn(async () => { const p = nativeState.pendingContacts; nativeState.pendingContacts = []; return JSON.stringify(p); }),
    cacheContactList: jest.fn(),
    cacheContactTones: jest.fn(),
    cacheStyleProfile: jest.fn(),
  };
});

describe('syncStyleProfile — short circuit', () => {
  it('does nothing when every native queue is empty and the DB has no confirmed identities', async () => {
    await syncStyleProfile();

    expect(NativeModules.ProTxtSettings.restoreConfirmedIdentities).not.toHaveBeenCalled();
    expect(NativeModules.ProTxtSettings.cacheStyleProfile).not.toHaveBeenCalled();
    expect(NativeModules.ProTxtSettings.cacheContactTones).not.toHaveBeenCalled();
  });

  it('never throws even if a native call rejects', async () => {
    (NativeModules.ProTxtSettings.drainStyleQueue as jest.Mock).mockRejectedValue(new Error('bridge unavailable'));
    await expect(syncStyleProfile()).resolves.toBeUndefined();
  });
});

describe('syncStyleProfile — restoring confirmed identities after reinstall', () => {
  it('pushes DB-confirmed identities back to native when native storage is empty', async () => {
    const contact = await upsertContact({ displayName: 'Fiona' });
    await upsertPlatformIdentity({
      contactId: contact.id, platform: 'whatsapp', identifier: '+440',
      identifierType: 'phone', confidence: 1, userConfirmed: true,
    });

    await syncStyleProfile();

    expect(NativeModules.ProTxtSettings.restoreConfirmedIdentities).toHaveBeenCalledWith(
      JSON.stringify({ 'whatsapp:+440': contact.id })
    );
  });

  it('does not restore when native already has confirmed identities', async () => {
    nativeState.confirmedIdentities = { 'com.whatsapp:Someone': 'already-there' };
    const contact = await upsertContact({ displayName: 'Fiona' });
    await upsertPlatformIdentity({
      contactId: contact.id, platform: 'whatsapp', identifier: '+440',
      identifierType: 'phone', confidence: 1, userConfirmed: true,
    });

    await syncStyleProfile();

    expect(NativeModules.ProTxtSettings.restoreConfirmedIdentities).not.toHaveBeenCalled();
  });
});

describe('syncStyleProfile — draining pending contacts', () => {
  it('creates a contact for each pending conversation', async () => {
    nativeState.pendingContacts = [{ convKey: 'com.whatsapp:George', senderName: 'George', platform: 'whatsapp' }];

    await syncStyleProfile();

    const all = await getAllContacts();
    expect(all.map((c) => c.displayName)).toContain('George');
  });
});

describe('syncStyleProfile — draining the style-edit queue', () => {
  it('auto-creates the contact and increments interaction count on a real send', async () => {
    nativeState.styleQueue = [{ original: 'On my way', edit: 'Omw!', platform: 'whatsapp', contact: 'Hank', ts: Date.now() }];

    await syncStyleProfile();

    const contact = (await getAllContacts()).find((c) => c.displayName === 'Hank');
    expect(contact).toBeDefined();
    expect(contact!.interactionCount).toBe(1);
  });

  it('records a dismissal without creating a contact or incrementing anything', async () => {
    nativeState.styleQueue = [{ original: 'On my way', edit: '', platform: 'whatsapp', contact: 'Ivy', ts: Date.now() }];

    await syncStyleProfile();

    expect((await getAllContacts()).some((c) => c.displayName === 'Ivy')).toBe(false);
  });
});

describe('syncStyleProfile — draining intent corrections', () => {
  it('appends new corrections and caps the stored history at 50', async () => {
    const existing = Array.from({ length: 48 }, (_, i) => ({ ts: i, from: ['other'], to: ['eta'], message: `old ${i}` }));
    await AsyncStorage.setItem('intent_corrections', JSON.stringify(existing));
    nativeState.intentCorrections = Array.from({ length: 5 }, (_, i) => ({ ts: 100 + i, from: ['other'], to: ['eta'], message: `new ${i}` }));

    await syncStyleProfile();

    const stored = JSON.parse((await AsyncStorage.getItem('intent_corrections'))!);
    expect(stored).toHaveLength(50);
    expect(stored[49].message).toBe('new 4');
  });
});

describe('syncStyleProfile — confirmed-identity resolution', () => {
  it('merges an auto-created duplicate contact into the confirmed one, by direct UUID', async () => {
    const autoCreated = await ensureContactForConversation('Dave', 'whatsapp'); // e.g. created from a bubble, low confidence
    const confirmedContact = await upsertContact({ displayName: 'David Real' });
    nativeState.confirmedIdentities = { 'com.whatsapp:Dave': confirmedContact.id };

    await syncStyleProfile();

    const all = await getAllContacts();
    expect(all.find((c) => c.id === autoCreated)).toBeUndefined(); // merged away
    expect(await findContactIdByIdentifier('Dave', 'whatsapp')).toBe(confirmedContact.id);
  });

  it('resolves a device-imported contact ("device:" id) by falling back to a display-name match', async () => {
    const contact = await upsertContact({ displayName: 'Eve' }); // legacy import, no platform identity yet
    nativeState.confirmedIdentities = { 'org.telegram.messenger:Eve': 'device:some-contact-uri' };

    await syncStyleProfile();

    expect(await findContactIdByIdentifier('Eve', 'telegram')).toBe(contact.id);
  });

  it('skips group and anonymous-id conversation keys without crashing', async () => {
    nativeState.confirmedIdentities = {
      'com.whatsapp:group:123': 'some-id',
      'com.whatsapp:id:456': 'some-id',
      'no-colon-at-all': 'some-id',
    };

    await expect(syncStyleProfile()).resolves.toBeUndefined();
    expect(await getAllContacts()).toEqual([]);
  });
});

describe('syncStyleProfile — rebuilding the cached style profile', () => {
  it('caches a style profile and tone map once there are meaningful edits', async () => {
    const contact = await upsertContact({ displayName: 'Jan', relationship: 'friend' });
    await recordStyleEdit({ originalSuggestion: 'Sure, sounds good!', userEdit: 'yep sounds good', contactId: contact.id, toneSelected: 'casual' });
    // Any non-empty queue is enough to get past the early-return gate.
    nativeState.pendingContacts = [{ convKey: 'x', senderName: 'Unrelated', platform: 'whatsapp' }];

    await syncStyleProfile();

    expect(NativeModules.ProTxtSettings.cacheStyleProfile).toHaveBeenCalledTimes(1);
    const profile = (NativeModules.ProTxtSettings.cacheStyleProfile as jest.Mock).mock.calls[0][0] as string;
    expect(profile).toContain('"Sure, sounds good!" → "yep sounds good"');

    const tones = JSON.parse((NativeModules.ProTxtSettings.cacheContactTones as jest.Mock).mock.calls[0][0]);
    expect(tones.jan).toBe('casual'); // inferred from relationship: friend -> casual
  });

  it('does not cache a profile when no edit is meaningfully different from its suggestion', async () => {
    await recordStyleEdit({ originalSuggestion: 'Sounds good', userEdit: 'sounds good.' }); // punctuation/case only
    nativeState.pendingContacts = [{ convKey: 'x', senderName: 'Unrelated', platform: 'whatsapp' }];

    await syncStyleProfile();

    expect(NativeModules.ProTxtSettings.cacheStyleProfile).not.toHaveBeenCalled();
  });
});

describe('refreshContactListCache', () => {
  it('pushes the contact list to native, inferring a tone from relationship when none is set', async () => {
    await upsertContact({ displayName: 'Kim', relationship: 'colleague' });

    await refreshContactListCache();

    const [json] = (NativeModules.ProTxtSettings.cacheContactList as jest.Mock).mock.calls[0];
    const list = JSON.parse(json);
    expect(list).toEqual([
      expect.objectContaining({ display_name: 'Kim', preferred_tone: 'formal', interaction_count: 0 }),
    ]);
  });
});
