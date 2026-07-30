import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { getAllContacts, invalidateContactsCache, upsertContact, upsertContactName, upsertPlatformIdentity } from './database';
import { findBestNameMatch } from '../utils/fuzzyMatch';

const PROGRESS_EVERY = 10;

export async function importGoogleContacts(
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  await GoogleSignin.addScopes({
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
  });

  const { accessToken: token } = await GoogleSignin.getTokens();
  if (!token) throw new Error('Not signed in to Google');

  // Snapshot existing contacts once to avoid O(n²) re-queries. Matched by fuzzy name
  // (not exact-lowercase) so e.g. "Paul Diaz" from a WhatsApp link and "Paul A. Diaz"
  // from Google resolve to the same contact instead of creating a duplicate.
  const existing = await getAllContacts();

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

      const prev = findBestNameMatch(name, existing, (c) => c.displayName);
      const contact = await upsertContact({
        id: prev?.id,
        displayName: name,
        relationship: prev?.relationship,
        preferredTone: prev?.preferredTone,
      });
      const id = contact.id;
      // Re-resolves display_name via source-trust survivorship rather than trusting this
      // sync's raw name — a Device Contacts import that ran since won't get clobbered.
      await upsertContactName(id, name, 'google', 1.0);
      if (!prev) existing.push(contact);

      for (const { value } of person.emailAddresses ?? []) {
        if (value) {
          await upsertPlatformIdentity({
            contactId: id, platform: 'google', identifier: value.toLowerCase(),
            identifierType: 'email', confidence: 1.0, userConfirmed: false,
          });
        }
      }

      for (const { value } of person.phoneNumbers ?? []) {
        if (value) {
          await upsertPlatformIdentity({
            contactId: id, platform: 'phone', identifier: value.replace(/\s/g, ''),
            identifierType: 'phone', confidence: 1.0, userConfirmed: false,
          });
        }
      }

      // display_name identity enables plaintext name lookup without decrypting all contacts
      await upsertPlatformIdentity({
        contactId: id, platform: 'google', identifier: name,
        identifierType: 'display_name', confidence: 0.9, userConfirmed: false,
      });

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
