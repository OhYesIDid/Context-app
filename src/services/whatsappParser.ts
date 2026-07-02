import * as DocumentPicker from 'expo-document-picker';
import { insertMemory, upsertContact } from './database';

// Handles iOS: [DD/MM/YYYY, HH:MM:SS] Sender: msg
//     Android: DD/MM/YYYY, HH:MM - Sender: msg
//          US: M/D/YY, H:MM AM/PM - Sender: msg
const LINE_RE = /^[\[⁨]?(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}),?\s+[\d:]+(?:\s*[AP]M)?[\]⁩]?\s*[-–]\s*(.+?):\s(.+)$/;

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

  for (const [sender, messages] of bySender) {
    const contact = await upsertContact({ displayName: sender });
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
