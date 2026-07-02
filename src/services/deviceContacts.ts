import * as Contacts from 'expo-contacts';
import { randomUUID } from 'expo-crypto';
import { getAllContacts, getDatabase, invalidateContactsCache } from './database';
import { encryptField } from './dbCrypto';

const PROGRESS_EVERY = 10;

export async function importDeviceContacts(
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== 'granted') throw new Error('Contacts permission denied');

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Name, Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers],
  });

  const filtered = data.filter((c) => c.name);
  const total = filtered.length;
  onProgress?.(0, total);

  // Snapshot existing contacts once to avoid O(n²) re-queries
  const existing = await getAllContacts();
  const byName = new Map(existing.map((c) => [c.displayName.toLowerCase(), c]));

  const db = await getDatabase();
  const now = new Date().toISOString();
  let count = 0;

  for (const c of filtered) {
    const name = c.name!;
    const prev = byName.get(name.toLowerCase());
    const id = prev?.id ?? randomUUID();

    const encName = await encryptField(name);
    await db.runAsync(
      `INSERT INTO contacts (id, display_name, relationship, preferred_tone, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name, updated_at=excluded.updated_at, synced_at=NULL`,
      [id, encName, prev?.relationship ?? null, prev?.preferredTone ?? null, now, now],
    );
    byName.set(name.toLowerCase(), { ...prev, id, displayName: name } as never);

    for (const entry of c.emails ?? []) {
      if (entry.email) {
        await db.runAsync(
          `INSERT OR IGNORE INTO platform_identities
             (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
           VALUES (?, ?, 'google', ?, 'email', 0.9, 0, ?, ?)`,
          [randomUUID(), id, entry.email.toLowerCase(), now, now],
        );
      }
    }

    for (const entry of c.phoneNumbers ?? []) {
      if (entry.number) {
        await db.runAsync(
          `INSERT OR IGNORE INTO platform_identities
             (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
           VALUES (?, ?, 'phone', ?, 'phone', 0.9, 0, ?, ?)`,
          [randomUUID(), id, entry.number.replace(/\s/g, ''), now, now],
        );
      }
    }

    // display_name identity enables plaintext name lookup without decrypting all contacts
    await db.runAsync(
      `INSERT OR IGNORE INTO platform_identities
         (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
       VALUES (?, ?, 'device', ?, 'display_name', 0.9, 0, ?, ?)`,
      [randomUUID(), id, name, now, now],
    );

    count++;
    if (count % PROGRESS_EVERY === 0 || count === total) {
      onProgress?.(count, total);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  invalidateContactsCache();
  return count;
}
