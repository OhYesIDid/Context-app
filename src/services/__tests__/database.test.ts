// Backs the `expo-sqlite` mock with Node's built-in SQLite engine so these tests run
// real SQL (schema, ON CONFLICT upserts, unique indexes, foreign keys) instead of just
// asserting on call args — the highest-value coverage for a data layer that's never
// been tested before. expo-crypto's native-dependent bits fall back to their
// documented no-native-module behavior (dbCrypto.ts's own plaintext/digest fallbacks),
// so encryption itself isn't exercised here — only database.ts's own logic.
import { DatabaseSync } from 'node:sqlite';

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

import {
  getDatabase,
  upsertSavedPlace,
  getSavedPlaces,
  getHomePlace,
  getWorkPlace,
  upsertContact,
  getAllContacts,
  invalidateContactsCache,
  findContactByDisplayName,
  findContactIdByIdentifier,
  getContactsWithPreferences,
  getContactsByIds,
  mergeContact,
  ensureContactForConversation,
  incrementContactInteraction,
  upsertPlatformIdentity,
  getConfirmedPlatformIdentities,
  insertMemory,
  getSemanticMemoriesByContact,
  recordStyleEdit,
  getRecentStyleEdits,
  markSynced,
  getPendingSyncItems,
  upsertBookings,
  getCachedBookings,
  getLastBookingsSyncAt,
  pruneBookingsNotIn,
} from '../database';

// database.ts's connection + contacts cache are module-level singletons — clear the
// tables (not re-open the connection) between tests so each test starts from a clean
// slate without paying the schema-bootstrap cost 30+ times.
beforeEach(async () => {
  await getDatabase();
  // children before parents — foreign_keys=ON rejects deleting a referenced contact row
  for (const table of ['platform_identities', 'memories', 'style_edits', 'contacts', 'saved_places', 'bookings']) {
    mockRawDb.exec(`DELETE FROM ${table}`);
  }
  invalidateContactsCache();
});

describe('getDatabase', () => {
  it('bootstraps the schema and stamps PRAGMA user_version', async () => {
    const db = await getDatabase();
    const { user_version } = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))!;
    expect(user_version).toBeGreaterThanOrEqual(1);
  });

  it('reuses the same connection on repeated calls', async () => {
    const a = await getDatabase();
    const b = await getDatabase();
    expect(a).toBe(b);
  });
});

describe('saved places', () => {
  const place = { name: 'Home', address: '1 Test St', lat: 51.5, lng: -0.1, isHome: true, isWork: false };

  it('inserts then re-upserts the same place by id without duplicating rows', async () => {
    const created = await upsertSavedPlace(place);
    await upsertSavedPlace({ ...place, id: created.id, name: 'Home (renamed)' });

    const all = await getSavedPlaces();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Home (renamed)');
  });

  it('finds the home and work places by flag', async () => {
    await upsertSavedPlace(place);
    await upsertSavedPlace({ name: 'Office', address: '2 Work Rd', lat: 51.6, lng: -0.2, isHome: false, isWork: true });

    expect((await getHomePlace())?.name).toBe('Home');
    expect((await getWorkPlace())?.name).toBe('Office');
  });

  it('round-trips lat/lng through the encrypted-copy columns', async () => {
    const created = await upsertSavedPlace(place);
    const [fetched] = await getSavedPlaces();
    expect(fetched.id).toBe(created.id);
    expect(fetched.lat).toBeCloseTo(51.5);
    expect(fetched.lng).toBeCloseTo(-0.1);
  });
});

describe('contacts', () => {
  it('upserts by id and invalidates the read cache', async () => {
    const created = await upsertContact({ displayName: 'Alice' });
    await upsertContact({ id: created.id, displayName: 'Alice Renamed' });

    const all = await getAllContacts();
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe('Alice Renamed');
  });

  it('caches getAllContacts until the cache is invalidated', async () => {
    await upsertContact({ displayName: 'Alice' });
    const first = await getAllContacts();
    const second = await getAllContacts();
    expect(second).toBe(first); // same array reference — served from cache

    await incrementContactInteraction(first[0].id);
    const third = await getAllContacts();
    expect(third).not.toBe(first); // cache invalidated by the mutation
  });

  it('sorts by interaction count desc, then display name asc', async () => {
    const a = await upsertContact({ displayName: 'Zed' });
    const b = await upsertContact({ displayName: 'Amy' });
    await incrementContactInteraction(a.id);
    await incrementContactInteraction(a.id);
    await incrementContactInteraction(b.id);
    await incrementContactInteraction(b.id);

    const all = await getAllContacts();
    // tied interaction count (2 each) — falls back to displayName order
    expect(all.map((c) => c.displayName)).toEqual(['Amy', 'Zed']);
  });

  it('finds a contact by display name case-insensitively', async () => {
    await upsertContact({ displayName: 'Bob Smith' });
    expect((await findContactByDisplayName('bob smith'))?.displayName).toBe('Bob Smith');
    expect(await findContactByDisplayName('nobody')).toBeNull();
  });

  it('filters to contacts with a relationship or preferred tone', async () => {
    await upsertContact({ displayName: 'Plain' });
    await upsertContact({ displayName: 'Friend', relationship: 'friend' });

    const withPrefs = await getContactsWithPreferences();
    expect(withPrefs.map((c) => c.displayName)).toEqual(['Friend']);
  });

  it('batch-fetches by id and short-circuits on an empty list', async () => {
    const a = await upsertContact({ displayName: 'A' });
    const b = await upsertContact({ displayName: 'B' });

    const fetched = await getContactsByIds([a.id, b.id]);
    expect(fetched.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(await getContactsByIds([])).toEqual([]);
  });
});

describe('platform identity resolution', () => {
  it('resolves a contact by hashed identifier after upsertPlatformIdentity', async () => {
    const contact = await upsertContact({ displayName: 'Carl' });
    await upsertPlatformIdentity({
      contactId: contact.id, platform: 'whatsapp', identifier: '+447000000000',
      identifierType: 'phone', confidence: 0.9, userConfirmed: true,
    });

    const found = await findContactIdByIdentifier('+447000000000', 'whatsapp');
    expect(found).toBe(contact.id);
  });

  it('falls back to a plaintext identifier match for pre-migration rows with no hash', async () => {
    const contact = await upsertContact({ displayName: 'Dana' });
    // Simulate a row written before the identifier_hash migration existed.
    await mockRawDb.prepare(
      `INSERT INTO platform_identities (id, contact_id, platform, identifier, identifier_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('legacy-1', contact.id, 'telegram', '@dana', 'username', 'now', 'now');

    expect(await findContactIdByIdentifier('@dana', 'telegram')).toBe(contact.id);
  });

  it('never downgrades confidence or unconfirms on a lower-confidence re-upsert', async () => {
    const contact = await upsertContact({ displayName: 'Eve' });
    const identity = {
      contactId: contact.id, platform: 'whatsapp' as const, identifier: '+449', identifierType: 'phone' as const,
    };
    await upsertPlatformIdentity({ ...identity, confidence: 0.9, userConfirmed: true });
    await upsertPlatformIdentity({ ...identity, confidence: 0.3, userConfirmed: false });

    const [confirmed] = await getConfirmedPlatformIdentities();
    expect(confirmed.confidence).toBe(0.9);
    expect(confirmed.userConfirmed).toBe(true);
  });
});

describe('mergeContact', () => {
  it('moves style edits, memories, and identities onto the target and sums interaction counts', async () => {
    const from = await upsertContact({ displayName: 'Old Alias' });
    const to = await upsertContact({ displayName: 'Real Contact' });
    await incrementContactInteraction(from.id);
    await incrementContactInteraction(to.id);
    await incrementContactInteraction(to.id);
    await recordStyleEdit({ originalSuggestion: 'a', userEdit: 'b', contactId: from.id });
    await insertMemory({ contactId: from.id, type: 'semantic', content: 'likes coffee', relevanceScore: 1 });
    await upsertPlatformIdentity({
      contactId: from.id, platform: 'whatsapp', identifier: '+441',
      identifierType: 'phone', confidence: 0.8, userConfirmed: true,
    });

    await mergeContact(from.id, to.id);

    expect(await findContactByDisplayName('Old Alias')).toBeNull();
    const merged = (await getAllContacts()).find((c) => c.id === to.id)!;
    expect(merged.interactionCount).toBe(3);
    expect(await findContactIdByIdentifier('+441', 'whatsapp')).toBe(to.id);
    const memories = await getSemanticMemoriesByContact(to.id);
    expect(memories.map((m) => m.content)).toContain('likes coffee');
  });

  it('is a no-op when merging a contact into itself', async () => {
    const c = await upsertContact({ displayName: 'Solo' });
    await expect(mergeContact(c.id, c.id)).resolves.toBeUndefined();
    expect(await findContactByDisplayName('Solo')).not.toBeNull();
  });

  it('does not conflict when both contacts already share the same platform identity', async () => {
    const from = await upsertContact({ displayName: 'Dup A' });
    const to = await upsertContact({ displayName: 'Dup B' });
    const shared = { platform: 'whatsapp' as const, identifier: '+442', identifierType: 'phone' as const, confidence: 0.5, userConfirmed: false };
    await upsertPlatformIdentity({ ...shared, contactId: from.id });
    await upsertPlatformIdentity({ ...shared, contactId: to.id });

    await expect(mergeContact(from.id, to.id)).resolves.toBeUndefined();
    expect(await findContactIdByIdentifier('+442', 'whatsapp')).toBe(to.id);
  });
});

describe('ensureContactForConversation', () => {
  it('creates a contact + identity once, then returns the same id for the same sender', async () => {
    const first = await ensureContactForConversation('Frank', 'whatsapp');
    const second = await ensureContactForConversation('Frank', 'whatsapp');
    expect(second).toBe(first);
    expect(await getAllContacts()).toHaveLength(1);
  });

  it('treats the same display name on different platforms as different conversations', async () => {
    const a = await ensureContactForConversation('Grace', 'whatsapp');
    const b = await ensureContactForConversation('Grace', 'telegram');
    expect(a).not.toBe(b);
  });
});

describe('style edits', () => {
  it('records and retrieves edits most-recent first', async () => {
    // Both calls land in the same test tick — pin the clock and advance it explicitly so
    // created_at values can't tie (a real risk with plain Date.now(), and it's flaky under load).
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }).setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await recordStyleEdit({ originalSuggestion: 'first', userEdit: 'first edited' });
    jest.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    await recordStyleEdit({ originalSuggestion: 'second', userEdit: 'second edited' });
    jest.useRealTimers();

    const recent = await getRecentStyleEdits(10);
    expect(recent.map((e) => e.originalSuggestion)).toEqual(['second', 'first']);
  });
});

describe('markSynced', () => {
  it('rejects any table not on the whitelist', async () => {
    await expect(markSynced('contacts' as any, ['x'])).rejects.toThrow(/invalid table/);
  });

  it('stamps synced_at only for the given ids on a whitelisted table', async () => {
    const place = await upsertSavedPlace({ name: 'P', address: 'A', lat: 1, lng: 1, isHome: false, isWork: false });
    await markSynced('saved_places', [place.id]);

    const pending = await getPendingSyncItems();
    expect(pending.saved_places).toEqual([]);
  });

  it('does nothing for an empty id list', async () => {
    await expect(markSynced('saved_places', [])).resolves.toBeUndefined();
  });
});

describe('bookings cache', () => {
  const booking = { id: 'b1', type: 'flight' as const, subject: 'Flight confirmation', snippet: 'BA123', from: 'ba@example.com', date: '2026-01-01T00:00:00Z', travelDate: '2026-02-01T00:00:00Z', destination: 'Lisbon' };

  it('upserts and reads back travel fields packed into raw_fields', async () => {
    await upsertBookings([booking]);
    const [cached] = await getCachedBookings();
    expect(cached).toMatchObject({ id: 'b1', destination: 'Lisbon', travelDate: booking.travelDate });
  });

  it('updates in place on a repeat upsert instead of duplicating', async () => {
    await upsertBookings([booking]);
    await upsertBookings([{ ...booking, destination: 'Porto' }]);

    const cached = await getCachedBookings();
    expect(cached).toHaveLength(1);
    expect(cached[0].destination).toBe('Porto');
  });

  it('tracks the most recent sync time, or null when empty', async () => {
    expect(await getLastBookingsSyncAt()).toBeNull();
    await upsertBookings([booking]);
    expect(await getLastBookingsSyncAt()).toBeInstanceOf(Date);
  });

  it('prunes rows missing from a full backfill, or clears everything for an empty backfill', async () => {
    await upsertBookings([booking, { ...booking, id: 'b2' }]);
    await pruneBookingsNotIn(['b1']);
    expect((await getCachedBookings()).map((b) => b.id)).toEqual(['b1']);

    await pruneBookingsNotIn([]);
    expect(await getCachedBookings()).toEqual([]);
  });
});
