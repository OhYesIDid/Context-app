import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { randomUUID } from 'expo-crypto';
import { getAllContacts, getDatabase, invalidateContactsCache } from './database';
import { encryptField } from './dbCrypto';

const PROGRESS_EVERY = 10;

export async function importGoogleContacts(
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  await GoogleSignin.addScopes({
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
  });

  const { accessToken: token } = await GoogleSignin.getTokens();
  if (!token) throw new Error('Not signed in to Google');

  // Snapshot existing contacts once to avoid O(n²) re-queries
  const existing = await getAllContacts();
  const byName = new Map(existing.map((c) => [c.displayName.toLowerCase(), c]));

  const db = await getDatabase();
  const now = new Date().toISOString();
  let count = 0;
  let nextPageToken: string | undefined;

  do {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers');
    url.searchParams.set('pageSize', '1000');
    if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 403) throw new Error('People API not enabled. Go to console.cloud.google.com → APIs & Services → Enable "People API".');
      const body = await res.text().catch(() => '');
      throw new Error(`People API ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      connections?: Array<{
        names?: Array<{ displayName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
        phoneNumbers?: Array<{ value?: string }>;
      }>;
      nextPageToken?: string;
    };

    for (const person of data.connections ?? []) {
      const name = person.names?.[0]?.displayName;
      if (!name) continue;

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

      for (const { value } of person.emailAddresses ?? []) {
        if (value) {
          await db.runAsync(
            `INSERT OR IGNORE INTO platform_identities
               (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
             VALUES (?, ?, 'google', ?, 'email', 1.0, 0, ?, ?)`,
            [randomUUID(), id, value.toLowerCase(), now, now],
          );
        }
      }

      for (const { value } of person.phoneNumbers ?? []) {
        if (value) {
          await db.runAsync(
            `INSERT OR IGNORE INTO platform_identities
               (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
             VALUES (?, ?, 'phone', ?, 'phone', 1.0, 0, ?, ?)`,
            [randomUUID(), id, value.replace(/\s/g, ''), now, now],
          );
        }
      }

      // display_name identity enables plaintext name lookup without decrypting all contacts
      await db.runAsync(
        `INSERT OR IGNORE INTO platform_identities
           (id, contact_id, platform, identifier, identifier_type, confidence, user_confirmed, created_at, updated_at)
         VALUES (?, ?, 'google', ?, 'display_name', 0.9, 0, ?, ?)`,
        [randomUUID(), id, name, now, now],
      );

      count++;
      if (count % PROGRESS_EVERY === 0) {
        onProgress?.(count, 0); // total=0 = unknown, modal shows running count
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  onProgress?.(count, 0);
  invalidateContactsCache();
  return count;
}
