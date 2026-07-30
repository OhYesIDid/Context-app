import * as Contacts from 'expo-contacts';
import { getAllContacts, invalidateContactsCache, upsertContact, upsertContactName, upsertPlatformIdentity } from './database';
import { findBestNameMatch } from '../utils/fuzzyMatch';

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

  // Snapshot existing contacts once to avoid O(n²) re-queries. Matched by fuzzy name
  // (not exact-lowercase) so e.g. "Paul Diaz" from a WhatsApp link and "Paul A. Diaz"
  // from the device address book resolve to the same contact instead of duplicating.
  const existing = await getAllContacts();

  let count = 0;

  for (const c of filtered) {
    const name = c.name!;
    const prev = findBestNameMatch(name, existing, (contact) => contact.displayName);
    const contact = await upsertContact({
      id: prev?.id,
      displayName: name,
      relationship: prev?.relationship,
      preferredTone: prev?.preferredTone,
    });
    const id = contact.id;
    // Re-resolves display_name via source-trust survivorship rather than trusting this
    // sync's raw name — a Google Contacts import that ran since won't get clobbered.
    await upsertContactName(id, name, 'device', 0.9);
    if (!prev) existing.push(contact);

    for (const entry of c.emails ?? []) {
      if (entry.email) {
        await upsertPlatformIdentity({
          contactId: id, platform: 'google', identifier: entry.email.toLowerCase(),
          identifierType: 'email', confidence: 0.9, userConfirmed: false,
        });
      }
    }

    for (const entry of c.phoneNumbers ?? []) {
      if (entry.number) {
        await upsertPlatformIdentity({
          contactId: id, platform: 'phone', identifier: entry.number.replace(/\s/g, ''),
          identifierType: 'phone', confidence: 0.9, userConfirmed: false,
        });
      }
    }

    // display_name identity enables plaintext name lookup without decrypting all contacts
    await upsertPlatformIdentity({
      contactId: id, platform: 'device', identifier: name,
      identifierType: 'display_name', confidence: 0.9, userConfirmed: false,
    });

    count++;
    if (count % PROGRESS_EVERY === 0 || count === total) {
      onProgress?.(count, total);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  invalidateContactsCache();
  return count;
}
