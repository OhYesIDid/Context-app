import { randomUUID } from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { decryptField, encryptField, hashIdentifier } from './dbCrypto';
import type {
  BookingItem,
  BookingType,
  Contact,
  Memory,
  PlatformIdentity,
  SavedPlace,
  StyleEdit,
} from '../types';

let _db: SQLite.SQLiteDatabase | null = null;
let _encryptDone = false;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('contextreply.db');
  await _migrate(_db);
  if (!_encryptDone) {
    try { await _encryptExistingRows(_db); } catch { /* non-fatal */ }
    try { await _migrateIdentifierIndex(_db); } catch { /* non-fatal */ }
    _encryptDone = true;
  }
  return _db;
}

async function _migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS saved_places (
      id             TEXT PRIMARY KEY NOT NULL,
      name           TEXT NOT NULL,
      address        TEXT NOT NULL,
      lat            REAL NOT NULL,
      lng            REAL NOT NULL,
      place_id       TEXT,
      is_home        INTEGER NOT NULL DEFAULT 0,
      is_work        INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      synced_at      TEXT,
      deleted_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id             TEXT PRIMARY KEY NOT NULL,
      display_name   TEXT NOT NULL,
      relationship   TEXT,
      notes          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      synced_at      TEXT,
      deleted_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS platform_identities (
      id               TEXT PRIMARY KEY NOT NULL,
      contact_id       TEXT NOT NULL,
      platform         TEXT NOT NULL,
      identifier       TEXT NOT NULL,
      identifier_type  TEXT NOT NULL,
      confidence       REAL NOT NULL DEFAULT 1.0,
      user_confirmed   INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id                TEXT PRIMARY KEY NOT NULL,
      contact_id        TEXT,
      type              TEXT NOT NULL,
      content           TEXT NOT NULL,
      entities_json     TEXT,
      location_lat      REAL,
      location_lng      REAL,
      location_name     TEXT,
      relevance_score   REAL NOT NULL DEFAULT 1.0,
      last_confirmed_at TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      synced_at         TEXT,
      deleted_at        TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE TABLE IF NOT EXISTS style_edits (
      id                  TEXT PRIMARY KEY NOT NULL,
      contact_id          TEXT,
      original_suggestion TEXT NOT NULL,
      user_edit           TEXT NOT NULL,
      platform            TEXT,
      intent              TEXT,
      created_at          TEXT NOT NULL,
      synced_at           TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_platform_identities_contact
      ON platform_identities(contact_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_identities_unique
      ON platform_identities(platform, identifier);
    CREATE INDEX IF NOT EXISTS idx_memories_contact
      ON memories(contact_id);
    CREATE INDEX IF NOT EXISTS idx_memories_type
      ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_style_edits_contact
      ON style_edits(contact_id);

    -- Phase 2: populated by background Gmail sync; Phase 1 reads Gmail live instead
    CREATE TABLE IF NOT EXISTS bookings (
      id              TEXT PRIMARY KEY NOT NULL,
      type            TEXT NOT NULL,
      subject         TEXT NOT NULL,
      snippet         TEXT NOT NULL,
      from_address    TEXT NOT NULL,
      email_date      TEXT NOT NULL,
      relevance_from  TEXT,
      relevance_until TEXT,
      raw_fields      TEXT,
      synced_at       TEXT NOT NULL,
      deleted_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_relevance
      ON bookings(relevance_from, relevance_until);
    CREATE INDEX IF NOT EXISTS idx_bookings_type
      ON bookings(type);
  `);
  // Add columns introduced after initial schema — safe to run repeatedly
  try { await db.runAsync('ALTER TABLE contacts ADD COLUMN preferred_tone TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE contacts ADD COLUMN interaction_count INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE style_edits ADD COLUMN tone_selected TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE style_edits ADD COLUMN edit_delta_json TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE style_edits ADD COLUMN subintent TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE style_edits ADD COLUMN dismissal_context_json TEXT'); } catch (_) {}
  // Security: encrypted lat/lng (was REAL plaintext) + HMAC identifier hash
  try { await db.runAsync('ALTER TABLE saved_places ADD COLUMN lat_enc TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE saved_places ADD COLUMN lng_enc TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE memories ADD COLUMN location_lat_enc TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE memories ADD COLUMN location_lng_enc TEXT'); } catch (_) {}
  try { await db.runAsync('ALTER TABLE platform_identities ADD COLUMN identifier_hash TEXT'); } catch (_) {}
}

// Re-encrypts any rows that still have plaintext in sensitive fields.
// Idempotent: rows starting with 'enc1:' are skipped.
async function _encryptExistingRows(db: SQLite.SQLiteDatabase): Promise<void> {
  // style_edits
  const styleRows = await db.getAllAsync<{ id: string; original_suggestion: string; user_edit: string }>(
    "SELECT id, original_suggestion, user_edit FROM style_edits WHERE original_suggestion NOT LIKE 'enc1:%' OR user_edit NOT LIKE 'enc1:%'"
  );
  for (const r of styleRows) {
    await db.runAsync(
      'UPDATE style_edits SET original_suggestion = ?, user_edit = ? WHERE id = ?',
      [await encryptField(r.original_suggestion), await encryptField(r.user_edit), r.id]
    );
  }

  // contacts.notes
  const contactRows = await db.getAllAsync<{ id: string; notes: string }>(
    "SELECT id, notes FROM contacts WHERE notes IS NOT NULL AND notes NOT LIKE 'enc1:%'"
  );
  for (const r of contactRows) {
    await db.runAsync('UPDATE contacts SET notes = ? WHERE id = ?', [await encryptField(r.notes), r.id]);
  }

  // memories
  const memRows = await db.getAllAsync<{ id: string; content: string; entities_json: string | null }>(
    "SELECT id, content, entities_json FROM memories WHERE content NOT LIKE 'enc1:%'"
  );
  for (const r of memRows) {
    await db.runAsync('UPDATE memories SET content = ?, entities_json = ? WHERE id = ?', [
      await encryptField(r.content),
      await encryptField(r.entities_json),
      r.id,
    ]);
  }

  // saved_places.address
  const placeRows = await db.getAllAsync<{ id: string; address: string }>(
    "SELECT id, address FROM saved_places WHERE address NOT LIKE 'enc1:%'"
  );
  for (const r of placeRows) {
    await db.runAsync('UPDATE saved_places SET address = ? WHERE id = ?', [await encryptField(r.address), r.id]);
  }

  // bookings.snippet / subject / from_address
  const bookingRows = await db.getAllAsync<{ id: string; snippet: string; subject: string; from_address: string }>(
    "SELECT id, snippet, subject, from_address FROM bookings WHERE snippet NOT LIKE 'enc1:%' OR subject NOT LIKE 'enc1:%' OR from_address NOT LIKE 'enc1:%'"
  );
  for (const r of bookingRows) {
    await db.runAsync(
      'UPDATE bookings SET snippet = ?, subject = ?, from_address = ? WHERE id = ?',
      [await encryptField(r.snippet), await encryptField(r.subject), await encryptField(r.from_address), r.id]
    );
  }

  // contacts.display_name
  const contactNameRows = await db.getAllAsync<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM contacts WHERE display_name NOT LIKE 'enc1:%'"
  );
  for (const r of contactNameRows) {
    await db.runAsync('UPDATE contacts SET display_name = ? WHERE id = ?',
      [await encryptField(r.display_name), r.id]);
  }

  // memories.location_name
  const memLocRows = await db.getAllAsync<{ id: string; location_name: string }>(
    "SELECT id, location_name FROM memories WHERE location_name IS NOT NULL AND location_name NOT LIKE 'enc1:%'"
  );
  for (const r of memLocRows) {
    await db.runAsync('UPDATE memories SET location_name = ? WHERE id = ?',
      [await encryptField(r.location_name), r.id]);
  }

  // saved_places lat/lng — store encrypted copies in lat_enc/lng_enc TEXT columns
  const placeCoordRows = await db.getAllAsync<{ id: string; lat: number; lng: number }>(
    'SELECT id, lat, lng FROM saved_places WHERE lat_enc IS NULL'
  );
  for (const r of placeCoordRows) {
    await db.runAsync('UPDATE saved_places SET lat_enc = ?, lng_enc = ? WHERE id = ?', [
      await encryptField(String(r.lat)),
      await encryptField(String(r.lng)),
      r.id,
    ]);
  }

  // memories location_lat/lng
  const memCoordRows = await db.getAllAsync<{
    id: string; location_lat: number | null; location_lng: number | null;
  }>('SELECT id, location_lat, location_lng FROM memories WHERE location_lat IS NOT NULL AND location_lat_enc IS NULL');
  for (const r of memCoordRows) {
    await db.runAsync('UPDATE memories SET location_lat_enc = ?, location_lng_enc = ? WHERE id = ?', [
      r.location_lat != null ? await encryptField(String(r.location_lat)) : null,
      r.location_lng != null ? await encryptField(String(r.location_lng)) : null,
      r.id,
    ]);
  }

  // platform_identities.identifier — compute HMAC hash + encrypt value for existing plaintext rows
  const identityRows = await db.getAllAsync<{ id: string; platform: string; identifier: string }>(
    "SELECT id, platform, identifier FROM platform_identities WHERE identifier_hash IS NULL"
  );
  for (const r of identityRows) {
    const plainId = r.identifier.startsWith('enc1:') ? null : r.identifier;
    if (plainId == null) continue; // already encrypted but hash missing — skip (unusual state)
    const hash = await hashIdentifier(r.platform, plainId);
    await db.runAsync(
      'UPDATE platform_identities SET identifier_hash = ?, identifier = ? WHERE id = ?',
      [hash, await encryptField(plainId), r.id]
    );
  }
}

// After _encryptExistingRows has populated identifier_hash for all rows, swap the
// unique index from (platform, identifier) to (platform, identifier_hash) so new
// inserts can upsert by hash without touching the encrypted identifier column.
async function _migrateIdentifierIndex(db: SQLite.SQLiteDatabase): Promise<void> {
  const nullRow = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM platform_identities WHERE identifier_hash IS NULL'
  );
  if (nullRow && nullRow.c > 0) return; // not all rows migrated yet
  await db.execAsync(`
    DROP INDEX IF EXISTS idx_platform_identities_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_identities_unique
      ON platform_identities(platform, identifier_hash)
      WHERE identifier_hash IS NOT NULL;
  `);
}

// ── Saved places ──────────────────────────────────────────────────────────────

export async function upsertSavedPlace(
  place: Omit<SavedPlace, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'deletedAt'> & { id?: string }
): Promise<SavedPlace> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = place.id ?? randomUUID();
  const latEnc = await encryptField(String(place.lat));
  const lngEnc = await encryptField(String(place.lng));
  await db.runAsync(
    `INSERT INTO saved_places (id, name, address, lat, lng, lat_enc, lng_enc, place_id, is_home, is_work, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, address=excluded.address,
       lat=excluded.lat, lng=excluded.lng, lat_enc=excluded.lat_enc, lng_enc=excluded.lng_enc,
       place_id=excluded.place_id, is_home=excluded.is_home, is_work=excluded.is_work,
       updated_at=excluded.updated_at, synced_at=NULL`,
    [id, place.name, await encryptField(place.address), place.lat, place.lng, latEnc, lngEnc,
     place.placeId ?? null, place.isHome ? 1 : 0, place.isWork ? 1 : 0, now, now]
  );
  return { ...place, id, createdAt: now, updatedAt: now };
}

export async function getSavedPlaces(): Promise<SavedPlace[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<SavedPlaceRow>(
    'SELECT * FROM saved_places WHERE deleted_at IS NULL ORDER BY name'
  );
  return Promise.all(rows.map(rowToSavedPlace));
}

export async function getWorkPlace(): Promise<SavedPlace | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<SavedPlaceRow>(
    'SELECT * FROM saved_places WHERE is_work = 1 AND deleted_at IS NULL LIMIT 1'
  );
  return row ? await rowToSavedPlace(row) : null;
}

export async function getHomePlace(): Promise<SavedPlace | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<SavedPlaceRow>(
    'SELECT * FROM saved_places WHERE is_home = 1 AND deleted_at IS NULL LIMIT 1'
  );
  return row ? await rowToSavedPlace(row) : null;
}

type SavedPlaceRow = {
  id: string; name: string; address: string; lat: number; lng: number;
  lat_enc: string | null; lng_enc: string | null;
  place_id: string | null; is_home: number; is_work: number;
  created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
};

async function rowToSavedPlace(row: SavedPlaceRow): Promise<SavedPlace> {
  const lat = row.lat_enc
    ? parseFloat((await decryptField(row.lat_enc)) ?? String(row.lat))
    : row.lat;
  const lng = row.lng_enc
    ? parseFloat((await decryptField(row.lng_enc)) ?? String(row.lng))
    : row.lng;
  return {
    id: row.id, name: row.name, address: (await decryptField(row.address)) ?? row.address,
    lat, lng, placeId: row.place_id ?? undefined,
    isHome: row.is_home === 1, isWork: row.is_work === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
    syncedAt: row.synced_at ?? undefined, deletedAt: row.deleted_at ?? undefined,
  };
}

// ── Style edits ───────────────────────────────────────────────────────────────

export async function recordStyleEdit(
  edit: Omit<StyleEdit, 'id' | 'createdAt' | 'syncedAt'>
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO style_edits
       (id, contact_id, original_suggestion, user_edit, platform, intent,
        tone_selected, edit_delta_json, subintent, dismissal_context_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), edit.contactId ?? null,
     await encryptField(edit.originalSuggestion), await encryptField(edit.userEdit),
     edit.platform ?? null, edit.intent ?? null,
     edit.toneSelected ?? null, edit.editDeltaJson ?? null,
     edit.subintent ?? null, edit.dismissalContextJson ?? null,
     new Date().toISOString()]
  );
}

export async function getRecentStyleEdits(limit: number): Promise<StyleEdit[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; contact_id: string | null; original_suggestion: string; user_edit: string;
    platform: string | null; intent: string | null; tone_selected: string | null;
    edit_delta_json: string | null; subintent: string | null;
    dismissal_context_json: string | null; created_at: string; synced_at: string | null;
  }>('SELECT * FROM style_edits ORDER BY created_at DESC LIMIT ?', [limit]);
  return Promise.all(rows.map(async (r) => ({
    id: r.id,
    contactId: r.contact_id ?? undefined,
    originalSuggestion: (await decryptField(r.original_suggestion)) ?? r.original_suggestion,
    userEdit: (await decryptField(r.user_edit)) ?? r.user_edit,
    platform: (r.platform as StyleEdit['platform']) ?? undefined,
    intent: (r.intent as StyleEdit['intent']) ?? undefined,
    toneSelected: r.tone_selected ?? undefined,
    editDeltaJson: r.edit_delta_json ?? undefined,
    subintent: r.subintent ?? undefined,
    dismissalContextJson: r.dismissal_context_json ?? undefined,
    createdAt: r.created_at,
    syncedAt: r.synced_at ?? undefined,
  })));
}

// ── Contacts ──────────────────────────────────────────────────────────────────

let _contactsCache: Contact[] | null = null;
export function invalidateContactsCache() { _contactsCache = null; }

type ContactRow = {
  id: string; display_name: string; relationship: string | null;
  preferred_tone: string | null; interaction_count: number | null; notes: string | null;
  created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
};

async function rowToContact(r: ContactRow): Promise<Contact> {
  return {
    id: r.id, displayName: (await decryptField(r.display_name)) ?? r.display_name,
    relationship: (r.relationship as Contact['relationship']) ?? undefined,
    preferredTone: (r.preferred_tone as Contact['preferredTone']) ?? undefined,
    interactionCount: r.interaction_count ?? 0,
    notes: (await decryptField(r.notes)) ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
    syncedAt: r.synced_at ?? undefined, deletedAt: r.deleted_at ?? undefined,
  };
}

export async function upsertContact(
  contact: Omit<Contact, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'deletedAt'> & { id?: string }
): Promise<Contact> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = contact.id ?? randomUUID();
  await db.runAsync(
    `INSERT INTO contacts (id, display_name, relationship, preferred_tone, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name, relationship=excluded.relationship,
       preferred_tone=excluded.preferred_tone,
       notes=excluded.notes, updated_at=excluded.updated_at, synced_at=NULL`,
    [id, await encryptField(contact.displayName), contact.relationship ?? null,
     contact.preferredTone ?? null, await encryptField(contact.notes ?? null), now, now]
  );
  invalidateContactsCache();
  return { ...contact, id, createdAt: now, updatedAt: now };
}

export async function getAllContacts(): Promise<Contact[]> {
  if (_contactsCache) return _contactsCache;
  const db = await getDatabase();
  const rows = await db.getAllAsync<ContactRow>(
    'SELECT * FROM contacts WHERE deleted_at IS NULL ORDER BY interaction_count DESC'
  );
  const contacts = await Promise.all(rows.map(rowToContact));
  contacts.sort((a, b) => {
    const bCount = b.interactionCount ?? 0;
    const aCount = a.interactionCount ?? 0;
    if (bCount !== aCount) return bCount - aCount;
    return a.displayName.localeCompare(b.displayName);
  });
  _contactsCache = contacts;
  return contacts;
}

export async function findContactByDisplayName(name: string): Promise<Contact | null> {
  const all = await getAllContacts();
  const target = name.toLowerCase();
  return all.find((c) => c.displayName.toLowerCase() === target) ?? null;
}

export async function findContactIdByIdentifier(identifier: string, platform = ''): Promise<string | null> {
  const db = await getDatabase();
  // Prefer hash-based lookup (post-migration); fall back to plaintext scan for pre-migration rows.
  const hash = await hashIdentifier(platform, identifier);
  const byHash = await db.getFirstAsync<{ contact_id: string }>(
    'SELECT contact_id FROM platform_identities WHERE identifier_hash = ? LIMIT 1',
    [hash]
  );
  if (byHash) return byHash.contact_id;
  const byPlain = await db.getFirstAsync<{ contact_id: string }>(
    'SELECT contact_id FROM platform_identities WHERE identifier = ? LIMIT 1',
    [identifier]
  );
  return byPlain?.contact_id ?? null;
}

// Only contacts with relationship or preferred_tone — typically very few
export async function getContactsWithPreferences(): Promise<Contact[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<ContactRow>(
    `SELECT * FROM contacts WHERE deleted_at IS NULL AND (relationship IS NOT NULL OR preferred_tone IS NOT NULL)`
  );
  return Promise.all(rows.map(rowToContact));
}

// Batch fetch by IDs — no full table scan, decrypts only what's needed
export async function getContactsByIds(ids: string[]): Promise<Contact[]> {
  if (ids.length === 0) return [];
  const db = await getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<ContactRow>(
    `SELECT * FROM contacts WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    ids
  );
  return Promise.all(rows.map(rowToContact));
}

// Migrates all style_edits, platform_identities, and memories from fromId to toId,
// sums interaction counts, then hard-deletes the orphaned from contact.
export async function mergeContact(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const db = await getDatabase();
  await db.runAsync('UPDATE style_edits SET contact_id = ? WHERE contact_id = ?', [toId, fromId]);
  await db.runAsync('UPDATE memories SET contact_id = ? WHERE contact_id = ?', [toId, fromId]);
  // platform_identities unique index is on (platform, identifier_hash) — use INSERT OR IGNORE to
  // avoid conflicts when both contacts somehow share an identity, then delete the rest.
  await db.runAsync(
    `INSERT OR IGNORE INTO platform_identities
       (id, contact_id, platform, identifier, identifier_hash, identifier_type, confidence, user_confirmed, created_at, updated_at)
     SELECT id, ?, platform, identifier, identifier_hash, identifier_type, confidence, user_confirmed, created_at, updated_at
     FROM platform_identities WHERE contact_id = ?`,
    [toId, fromId]
  );
  await db.runAsync('DELETE FROM platform_identities WHERE contact_id = ?', [fromId]);
  await db.runAsync(
    `UPDATE contacts SET
       interaction_count = interaction_count + (
         SELECT COALESCE(interaction_count, 0) FROM contacts WHERE id = ?
       ),
       updated_at = ?
     WHERE id = ?`,
    [fromId, new Date().toISOString(), toId]
  );
  await db.runAsync('DELETE FROM contacts WHERE id = ?', [fromId]);
  invalidateContactsCache();
}

// Creates a contact + provisional platform_identity if one doesn't already exist
// for this (platform, senderName) pair. Called when a bubble fires (option 3).
export async function ensureContactForConversation(
  senderName: string,
  platform: string,
): Promise<string> {
  const db = await getDatabase();
  const hash = await hashIdentifier(platform, senderName);
  const existing = await db.getFirstAsync<{ contact_id: string }>(
    'SELECT contact_id FROM platform_identities WHERE platform = ? AND (identifier_hash = ? OR identifier = ?) LIMIT 1',
    [platform, hash, senderName]
  );
  if (existing) return existing.contact_id;
  const now = new Date().toISOString();
  const contactId = randomUUID();
  await db.runAsync(
    'INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [contactId, await encryptField(senderName), now, now]
  );
  await db.runAsync(
    `INSERT OR IGNORE INTO platform_identities
       (id, contact_id, platform, identifier, identifier_hash, identifier_type, confidence, user_confirmed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), contactId, platform, await encryptField(senderName), hash,
     'display_name', 0.5, 0, now, now]
  );
  invalidateContactsCache();
  return contactId;
}

export async function incrementContactInteraction(contactId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE contacts SET interaction_count = interaction_count + 1, updated_at = ? WHERE id = ?',
    [new Date().toISOString(), contactId]
  );
  invalidateContactsCache();
}

export async function updateContactPreferences(
  id: string,
  relationship: Contact['relationship'] | undefined,
  preferredTone: Contact['preferredTone'] | undefined,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE contacts SET relationship = ?, preferred_tone = ?, updated_at = ?, synced_at = NULL WHERE id = ?`,
    [relationship ?? null, preferredTone ?? null, new Date().toISOString(), id]
  );
  invalidateContactsCache();
}

export async function upsertPlatformIdentity(
  identity: Omit<PlatformIdentity, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<PlatformIdentity> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = identity.id ?? randomUUID();
  const hash = await hashIdentifier(identity.platform, identity.identifier);
  const encId = await encryptField(identity.identifier);
  // INSERT OR IGNORE then UPDATE — avoids relying on a specific conflict-column clause
  // since the unique index may be on either (platform, identifier) or (platform, identifier_hash)
  // depending on which migration stage we're in.
  await db.runAsync(
    `INSERT OR IGNORE INTO platform_identities
       (id, contact_id, platform, identifier, identifier_hash, identifier_type, confidence, user_confirmed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, identity.contactId, identity.platform, encId, hash, identity.identifierType,
     identity.confidence, identity.userConfirmed ? 1 : 0, now, now]
  );
  await db.runAsync(
    `UPDATE platform_identities SET
       contact_id=?, confidence=MAX(confidence, ?), user_confirmed=MAX(user_confirmed, ?), updated_at=?
     WHERE platform=? AND identifier_hash=?`,
    [identity.contactId, identity.confidence, identity.userConfirmed ? 1 : 0, now,
     identity.platform, hash]
  );
  return { ...identity, id, createdAt: now, updatedAt: now };
}

export async function getConfirmedPlatformIdentities(): Promise<PlatformIdentity[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; contact_id: string; platform: string; identifier: string;
    identifier_type: string; confidence: number; user_confirmed: number;
    created_at: string; updated_at: string;
  }>('SELECT * FROM platform_identities WHERE user_confirmed = 1');
  return Promise.all(rows.map(async (r) => ({
    id: r.id,
    contactId: r.contact_id,
    platform: r.platform as PlatformIdentity['platform'],
    identifier: (await decryptField(r.identifier)) ?? r.identifier,
    identifierType: r.identifier_type as PlatformIdentity['identifierType'],
    confidence: r.confidence,
    userConfirmed: r.user_confirmed === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
}

// ── Memories ──────────────────────────────────────────────────────────────────

export async function insertMemory(
  memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'deletedAt'>
): Promise<Memory> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();
  const locLatEnc = memory.locationLat != null ? await encryptField(String(memory.locationLat)) : null;
  const locLngEnc = memory.locationLng != null ? await encryptField(String(memory.locationLng)) : null;
  await db.runAsync(
    `INSERT INTO memories
       (id, contact_id, type, content, entities_json, location_lat, location_lng, location_name,
        location_lat_enc, location_lng_enc, relevance_score, last_confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, memory.contactId ?? null, memory.type,
     await encryptField(memory.content),
     await encryptField(memory.entitiesJson ?? null),
     memory.locationLat ?? null,
     memory.locationLng ?? null, await encryptField(memory.locationName ?? null),
     locLatEnc, locLngEnc,
     memory.relevanceScore, memory.lastConfirmedAt ?? null, now, now]
  );
  return { ...memory, id, createdAt: now, updatedAt: now };
}

// ── Contact detail queries ────────────────────────────────────────────────────

export async function getContactById(id: string): Promise<Contact | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ContactRow>('SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? await rowToContact(row) : null;
}

export async function getPlatformIdentitiesByContact(contactId: string): Promise<PlatformIdentity[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; contact_id: string; platform: string; identifier: string;
    identifier_type: string; confidence: number; user_confirmed: number;
    created_at: string; updated_at: string;
  }>('SELECT * FROM platform_identities WHERE contact_id = ? ORDER BY confidence DESC, user_confirmed DESC', [contactId]);
  return Promise.all(rows.map(async r => ({
    id: r.id,
    contactId: r.contact_id,
    platform: r.platform as PlatformIdentity['platform'],
    identifier: (await decryptField(r.identifier)) ?? r.identifier,
    identifierType: r.identifier_type as PlatformIdentity['identifierType'],
    confidence: r.confidence,
    userConfirmed: r.user_confirmed === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
}

export async function getSemanticMemoriesByContact(contactId: string, limit = 20): Promise<Memory[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; contact_id: string | null; type: string; content: string;
    relevance_score: number; created_at: string; updated_at: string;
    last_confirmed_at: string | null;
  }>(
    `SELECT id, contact_id, type, content, relevance_score, created_at, updated_at, last_confirmed_at
     FROM memories WHERE contact_id = ? AND type = 'semantic' AND deleted_at IS NULL
     ORDER BY relevance_score DESC, created_at DESC LIMIT ?`,
    [contactId, limit]
  );
  return Promise.all(rows.map(async r => ({
    id: r.id,
    contactId: r.contact_id ?? undefined,
    type: r.type as Memory['type'],
    content: (await decryptField(r.content)) ?? r.content,
    relevanceScore: r.relevance_score,
    lastConfirmedAt: r.last_confirmed_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
}

// ── D1 sync (stub — implemented when cloud backup is enabled) ─────────────────

export async function getPendingSyncItems(): Promise<{
  saved_places: SavedPlace[];
  style_edits: StyleEdit[];
}> {
  const db = await getDatabase();
  const places = await db.getAllAsync<SavedPlaceRow>('SELECT * FROM saved_places WHERE synced_at IS NULL');
  const edits = await db.getAllAsync<{
    id: string; contact_id: string | null; original_suggestion: string; user_edit: string;
    platform: string | null; intent: string | null; created_at: string; synced_at: string | null;
  }>('SELECT * FROM style_edits WHERE synced_at IS NULL');
  return {
    saved_places: await Promise.all(places.map(rowToSavedPlace)),
    style_edits: await Promise.all(edits.map(async (r) => ({
      id: r.id, contactId: r.contact_id ?? undefined,
      originalSuggestion: (await decryptField(r.original_suggestion)) ?? r.original_suggestion,
      userEdit: (await decryptField(r.user_edit)) ?? r.user_edit,
      platform: (r.platform as StyleEdit['platform']) ?? undefined,
      intent: (r.intent as StyleEdit['intent']) ?? undefined,
      createdAt: r.created_at, syncedAt: r.synced_at ?? undefined,
    }))),
  };
}

const SYNCED_TABLES = new Set(['saved_places', 'style_edits'] as const);

export async function markSynced(table: 'saved_places' | 'style_edits', ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!SYNCED_TABLES.has(table)) throw new Error(`markSynced: invalid table "${table}"`);
  const db = await getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE ${table} SET synced_at = ? WHERE id IN (${placeholders})`,
    [now, ...ids]
  );
}

// ── Bookings cache (Phase 2 — local sync instead of a live Gmail fetch on every load) ──

interface BookingRow {
  id: string;
  type: string;
  subject: string;
  snippet: string;
  from_address: string;
  email_date: string;
  raw_fields: string | null;
}

export async function upsertBookings(items: BookingItem[]): Promise<void> {
  if (items.length === 0) return;
  const db = await getDatabase();
  const now = new Date().toISOString();
  for (const item of items) {
    // travelDate/travelDateEnd/destination live in raw_fields, not the
    // relevance_from/relevance_until columns — those are reserved for a
    // separate, not-yet-built feature (surfacing a booking only during its
    // active window), a different concept from the resolved travel dates.
    const rawFields = JSON.stringify({
      travelDate: item.travelDate,
      travelDateEnd: item.travelDateEnd,
      destination: item.destination,
    });
    await db.runAsync(
      `INSERT INTO bookings (id, type, subject, snippet, from_address, email_date, raw_fields, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type, subject=excluded.subject, snippet=excluded.snippet,
         from_address=excluded.from_address, email_date=excluded.email_date,
         raw_fields=excluded.raw_fields, synced_at=excluded.synced_at`,
      [
        item.id,
        item.type,
        await encryptField(item.subject),
        await encryptField(item.snippet),
        await encryptField(item.from),
        item.date,
        rawFields,
        now,
      ]
    );
  }
}

export async function getCachedBookings(): Promise<BookingItem[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<BookingRow>('SELECT * FROM bookings WHERE deleted_at IS NULL');
  return Promise.all(rows.map(async (r) => {
    const raw = r.raw_fields ? JSON.parse(r.raw_fields) as { travelDate?: string; travelDateEnd?: string; destination?: string } : {};
    return {
      id: r.id,
      type: r.type as BookingType,
      subject: (await decryptField(r.subject)) ?? r.subject,
      snippet: (await decryptField(r.snippet)) ?? r.snippet,
      from: (await decryptField(r.from_address)) ?? r.from_address,
      date: r.email_date,
      travelDate: raw.travelDate,
      travelDateEnd: raw.travelDateEnd,
      destination: raw.destination,
    };
  }));
}

export async function getLastBookingsSyncAt(): Promise<Date | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ max_synced: string | null }>(
    'SELECT MAX(synced_at) as max_synced FROM bookings'
  );
  return row?.max_synced ? new Date(row.max_synced) : null;
}

// upsertBookings only ever adds/updates — a row that was cached under an
// older, buggier classification (e.g. a stray false positive) would
// otherwise sit there forever, since a later fetch simply never returns it
// again to overwrite it. Only call this after a FULL backfill, not an
// incremental sync — an incremental fetch only covers a narrow recent
// window, so anything outside it would look "not present" and get wrongly
// deleted.
export async function pruneBookingsNotIn(currentIds: string[]): Promise<void> {
  const db = await getDatabase();
  if (currentIds.length === 0) {
    await db.runAsync('DELETE FROM bookings');
    return;
  }
  const placeholders = currentIds.map(() => '?').join(',');
  await db.runAsync(`DELETE FROM bookings WHERE id NOT IN (${placeholders})`, currentIds);
}
