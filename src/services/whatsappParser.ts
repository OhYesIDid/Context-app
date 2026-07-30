import * as DocumentPicker from 'expo-document-picker';
import { getAllContacts, insertMemory, upsertContact, upsertContactName, upsertPlatformIdentity } from './database';
import { findBestNameMatch } from '../utils/fuzzyMatch';

// Handles iOS: [DD/MM/YYYY, HH:MM:SS] Sender: msg  (no dash before the sender)
//     Android: DD/MM/YYYY, HH:MM - Sender: msg
//          US: M/D/YY, H:MM AM/PM - Sender: msg
// The dash is optional: it was previously required unconditionally, which meant the
// documented iOS format (no dash) never actually matched and iOS exports silently
// produced zero messages.
const LINE_RE = /^[\[⁨]?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),?\s+[\d:]+(?:\s*[AP]M)?[\]⁩]?\s*[-–]?\s*(.+?):\s(.+)$/;

const SYSTEM_SENDER_RE = /^(Messages and calls|You deleted|This message was deleted|Your security code|Waiting for this message|null|‎)/i;

export async function pickAndParseWhatsAppExport(): Promise<{ contactName: string; messageCount: number }> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['text/plain', 'text/*'],
    copyToCacheDirectory: true,
  });
  if (result.canceled) throw new Error('Cancelled');

  const uri = result.assets[0].uri;
  const res = await fetch(uri);
  if (!res.ok) throw new Error('Could not read file');
  const text = await res.text();

  // Collect messages per sender
  const bySender = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const sender = m[2].trim();
    const msg = m[3].trim();
    if (SYSTEM_SENDER_RE.test(sender) || msg.length < 2) continue;
    if (!bySender.has(sender)) bySender.set(sender, []);
    bySender.get(sender)!.push(msg);
  }

  if (bySender.size === 0) throw new Error('No messages found — make sure this is a WhatsApp .txt export');

  // In a DM export both participants appear by name.
  // Import all senders as contacts + memories; the user can later mark which is themselves.
  let contactName = '';
  let messageCount = 0;
  const CHUNK = 50;

  // Matched by fuzzy name (not exact-lowercase) so re-importing the same export — e.g. to
  // backfill the whatsapp platform_identity added below onto contacts created before that
  // existed — upserts the same contact instead of creating a duplicate, and so a sender
  // saved slightly differently elsewhere (e.g. "Paul Diaz" here vs "Paul A. Diaz" from a
  // Google import) still resolves to one contact. upsertContact's own conflict target is
  // `id`, not name, so without this every re-import would double up.
  const existing = await getAllContacts();

  for (const [sender, messages] of bySender) {
    const match = findBestNameMatch(sender, existing, (c) => c.displayName);
    const contact = await upsertContact({ id: match?.id, displayName: sender });
    // 'platform' — lowest survivorship trust — so a Device/Google Contacts name already
    // on file isn't clobbered by whatever this export happened to save the sender as.
    await upsertContactName(contact.id, sender, 'platform', 0.6);
    if (!match) existing.push(contact);
    await upsertPlatformIdentity({
      contactId: contact.id,
      platform: 'whatsapp',
      identifier: sender,
      identifierType: 'username',
      confidence: 1,
      userConfirmed: true,
    });
    if (!contactName) contactName = sender;

    for (let i = 0; i < messages.length; i += CHUNK) {
      const chunk = messages.slice(i, i + CHUNK);
      await insertMemory({
        contactId: contact.id,
        type: 'conversation_history',
        content: chunk.map(msg => `${sender}: ${msg}`).join('\n'),
        relevanceScore: 0.8,
      });
    }

    messageCount += messages.length;
  }

  return { contactName, messageCount };
}
