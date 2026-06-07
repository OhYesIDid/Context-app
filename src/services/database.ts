import { randomUUID } from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import type {
  Contact,
  Memory,
  PlatformIdentity,
  SavedPlace,
  StyleEdit,
} from '../types';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('contextreply.db');
  await _migrate(_db);
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
    CREATE INDEX IF NOT EXISTS idx_memories_contact
      ON memories(contact_id);
    CREATE INDEX IF NOT EXISTS idx_memories_type
      ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_style_edits_contact
      ON style_edits(contact_id);
  `);
}

// ── Saved places ──────────────────────────────────────────────────────────────

export async function upsertSavedPlace(
  place: Omit<SavedPlace, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'deletedAt'> & { id?: string }
): Promise<SavedPlace> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = place.id ?? randomUUID();
  await db.runAsync(
    `INSERT INTO saved_places (id, name, address, lat, lng, place_id, is_home, is_work, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, address=excluded.address,
       lat=excluded.lat, lng=excluded.lng, place_id=excluded.place_id,
       is_home=excluded.is_home, is_work=excluded.is_work,
       updated_at=excluded.updated_at, synced_at=NULL`,
    [id, place.name, place.address, place.lat, place.lng, place.placeId ?? null,
     place.isHome ? 1 : 0, place.isWork ? 1 : 0, now, now]
  );
  return { ...place, id, createdAt: now, updatedAt: now };
}

export async function getSavedPlaces(): Promise<SavedPlace[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; name: string; address: string; lat: number; lng: number;
    place_id: string | null; is_home: number; is_work: number;
    created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
  }>('SELECT * FROM saved_places WHERE deleted_at IS NULL ORDER BY name');
  return rows.map(rowToSavedPlace);
}

export async function getWorkPlace(): Promise<SavedPlace | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{
    id: string; name: string; address: string; lat: number; lng: number;
    place_id: string | null; is_home: number; is_work: number;
    created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
  }>('SELECT * FROM saved_places WHERE is_work = 1 AND deleted_at IS NULL LIMIT 1');
  return row ? rowToSavedPlace(row) : null;
}

export async function getHomePlace(): Promise<SavedPlace | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{
    id: string; name: string; address: string; lat: number; lng: number;
    place_id: string | null; is_home: number; is_work: number;
    created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
  }>('SELECT * FROM saved_places WHERE is_home = 1 AND deleted_at IS NULL LIMIT 1');
  return row ? rowToSavedPlace(row) : null;
}

function rowToSavedPlace(row: {
  id: string; name: string; address: string; lat: number; lng: number;
  place_id: string | null; is_home: number; is_work: number;
  created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
}): SavedPlace {
  return {
    id: row.id, name: row.name, address: row.address,
    lat: row.lat, lng: row.lng, placeId: row.place_id ?? undefined,
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
    `INSERT INTO style_edits (id, contact_id, original_suggestion, user_edit, platform, intent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), edit.contactId ?? null, edit.originalSuggestion, edit.userEdit,
     edit.platform ?? null, edit.intent ?? null, new Date().toISOString()]
  );
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export async function upsertContact(
  contact: Omit<Contact, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'deletedAt'> & { id?: string }
): Promise<Contact> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = contact.id ?? randomUUID();
  await db.runAsync(
    `INSERT INTO contacts (id, display_name, relationship, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name, relationship=excluded.relationship,
       notes=excluded.notes, updated_at=excluded.updated_at, synced_at=NULL`,
    [id, contact.displayName, contact.relationship ?? null, contact.notes ?? null, now, now]
  );
  return { ...contact, id, createdAt: now, updatedAt: now };
}

export async function upsertPlatformIdentity(
  identity: Omit<PlatformIdentity, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): Promise<PlatformIdentity> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = identity.id ?? randomUUID();
  await db.runAsync(
    `INSERT INTO platform_identities
       (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       confidence=excluded.confidence, user_confirmed=excluded.user_confirmed,
       updated_at=excluded.updated_at`,
    [id, identity.contactId, identity.platform, identity.identifier, identity.identifierType,
     identity.confidence, identity.userConfirmed ? 1 : 0, now, now]
  );
  return { ...identity, id, createdAt: now, updatedAt: now };
}

// ── Memories ──────────────────────────────────────────────────────────────────

export async function insertMemory(
  memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'syncedAt' | 'deletedAt'>
): Promise<Memory> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.runAsync(
    `INSERT INTO memories
       (id, contact_id, type, content, entities_json, location_lat, location_lng, location_name,
        relevance_score, last_confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, memory.contactId ?? null, memory.type, memory.content,
     memory.entitiesJson ?? null, memory.locationLat ?? null,
     memory.locationLng ?? null, memory.locationName ?? null,
     memory.relevanceScore, memory.lastConfirmedAt ?? null, now, now]
  );
  return { ...memory, id, createdAt: now, updatedAt: now };
}

// ── D1 sync (stub — implemented when cloud backup is enabled) ─────────────────

export async function getPendingSyncItems(): Promise<{
  saved_places: SavedPlace[];
  style_edits: StyleEdit[];
}> {
  const db = await getDatabase();
  const places = await db.getAllAsync<{
    id: string; name: string; address: string; lat: number; lng: number;
    place_id: string | null; is_home: number; is_work: number;
    created_at: string; updated_at: string; synced_at: string | null; deleted_at: string | null;
  }>('SELECT * FROM saved_places WHERE synced_at IS NULL');
  const edits = await db.getAllAsync<{
    id: string; contact_id: string | null; original_suggestion: string; user_edit: string;
    platform: string | null; intent: string | null; created_at: string; synced_at: string | null;
  }>('SELECT * FROM style_edits WHERE synced_at IS NULL');
  return {
    saved_places: places.map(rowToSavedPlace),
    style_edits: edits.map((r) => ({
      id: r.id, contactId: r.contact_id ?? undefined,
      originalSuggestion: r.original_suggestion, userEdit: r.user_edit,
      platform: (r.platform as StyleEdit['platform']) ?? undefined,
      intent: (r.intent as StyleEdit['intent']) ?? undefined,
      createdAt: r.created_at, syncedAt: r.synced_at ?? undefined,
    })),
  };
}

export async function markSynced(table: 'saved_places' | 'style_edits', ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE ${table} SET synced_at = ? WHERE id IN (${placeholders})`,
    [now, ...ids]
  );
}
