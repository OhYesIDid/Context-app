import * as Contacts from 'expo-contacts';
import { upsertContact, upsertPlatformIdentity } from './database';

export async function importDeviceContacts(): Promise<number> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== 'granted') throw new Error('Contacts permission denied');

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Name, Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers],
  });

  let count = 0;
  for (const c of data) {
    if (!c.name) continue;

    const contact = await upsertContact({ displayName: c.name });

    for (const entry of c.emails ?? []) {
      if (entry.email) {
        await upsertPlatformIdentity({
          contactId: contact.id,
          platform: 'google',
          identifier: entry.email.toLowerCase(),
          identifierType: 'email',
          confidence: 0.9,
          userConfirmed: false,
        });
      }
    }

    for (const entry of c.phoneNumbers ?? []) {
      if (entry.number) {
        await upsertPlatformIdentity({
          contactId: contact.id,
          platform: 'phone',
          identifier: entry.number.replace(/\s/g, ''),
          identifierType: 'phone',
          confidence: 0.9,
          userConfirmed: false,
        });
      }
    }

    count++;
  }

  return count;
}
