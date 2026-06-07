import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { upsertContact, upsertPlatformIdentity } from './database';
import { getAccessToken } from './googleAuth';

export async function importGoogleContacts(): Promise<number> {
  // Ensure contacts scope is granted — will prompt if not yet authorised
  await GoogleSignin.addScopes({
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
  });

  const token = await getAccessToken();
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

      const contact = await upsertContact({ displayName: name });

      for (const { value } of person.emailAddresses ?? []) {
        if (value) {
          await upsertPlatformIdentity({
            contactId: contact.id,
            platform: 'google',
            identifier: value.toLowerCase(),
            identifierType: 'email',
            confidence: 1.0,
            userConfirmed: false,
          });
        }
      }

      for (const { value } of person.phoneNumbers ?? []) {
        if (value) {
          await upsertPlatformIdentity({
            contactId: contact.id,
            platform: 'phone',
            identifier: value.replace(/\s/g, ''),
            identifierType: 'phone',
            confidence: 1.0,
            userConfirmed: false,
          });
        }
      }

      count++;
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return count;
}
