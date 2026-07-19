// pickAndParseWhatsAppExport does its own regex line-parsing inline (no separate pure
// function to unit test), so these tests drive it end-to-end: mock the file picker + fetch
// to hand it canned export text, and let it run against the real database.ts (node:sqlite
// backed, same approach as the other service suites) to verify contacts/memories actually
// land correctly.
import { DatabaseSync } from 'node:sqlite';
import * as DocumentPicker from 'expo-document-picker';

const mockRawDb = new DatabaseSync(':memory:');

jest.mock('expo-sqlite', () => ({
  __esModule: true,
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: async (sql: string) => { mockRawDb.exec(sql); },
    runAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).run(...params),
    getFirstAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, params: any[] = []) => mockRawDb.prepare(sql).all(...params),
  })),
}));

jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => require('node:crypto').randomUUID(),
  digestStringAsync: async (_algo: any, input: string) => `digest:${input}`,
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
}));

jest.mock('expo-document-picker', () => ({
  __esModule: true,
  getDocumentAsync: jest.fn(),
}));

import { getDatabase, invalidateContactsCache, getAllContacts, getSemanticMemoriesByContact } from '../database';
import { pickAndParseWhatsAppExport } from '../whatsappParser';

function mockPickedFile(text: string) {
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///export.txt' }],
  });
  (global as any).fetch = jest.fn(async () => ({ ok: true, text: async () => text }));
}

beforeEach(async () => {
  await getDatabase();
  for (const table of ['platform_identities', 'memories', 'style_edits', 'contacts', 'saved_places', 'bookings']) {
    mockRawDb.exec(`DELETE FROM ${table}`);
  }
  invalidateContactsCache();
  jest.clearAllMocks();
});

describe('pickAndParseWhatsAppExport — line formats', () => {
  it('parses the Android format and groups messages per sender', async () => {
    mockPickedFile([
      '01/03/2026, 09:15 - Alice: hey are you free later?',
      '01/03/2026, 09:16 - Bob: yeah what time works',
      '01/03/2026, 09:17 - Alice: maybe 6pm?',
    ].join('\n'));

    const result = await pickAndParseWhatsAppExport();

    expect(result).toEqual({ contactName: 'Alice', messageCount: 3 });
    const contacts = await getAllContacts();
    expect(contacts.map((c) => c.displayName).sort()).toEqual(['Alice', 'Bob']);
  });

  it('parses the iOS bracketed format', async () => {
    mockPickedFile('[01/03/2026, 09:15:03] Alice: hey are you free later?');

    const result = await pickAndParseWhatsAppExport();

    expect(result).toEqual({ contactName: 'Alice', messageCount: 1 });
  });

  it('parses the US format with AM/PM', async () => {
    mockPickedFile('3/1/26, 9:15 AM - Alice: hey are you free later?');

    const result = await pickAndParseWhatsAppExport();

    expect(result).toEqual({ contactName: 'Alice', messageCount: 1 });
  });
});

describe('pickAndParseWhatsAppExport — filtering', () => {
  it('drops a system notice whose captured "sender" is the encryption banner text', async () => {
    // The banner sentence contains a colon ("Tap for more info: click here"), so the parser's
    // colon-split regex captures everything before it as the "sender" — SYSTEM_SENDER_RE exists
    // specifically to catch that case rather than importing it as a fake contact.
    mockPickedFile([
      '01/03/2026, 09:00 - Messages and calls are end-to-end encrypted. Tap for more info: click here',
      '01/03/2026, 09:15 - Alice: hey are you free later?',
    ].join('\n'));

    const result = await pickAndParseWhatsAppExport();

    expect(result.messageCount).toBe(1);
    const contacts = await getAllContacts();
    expect(contacts.map((c) => c.displayName)).toEqual(['Alice']);
  });

  it('drops messages under 2 characters after trimming', async () => {
    mockPickedFile([
      '01/03/2026, 09:15 - Alice: k',
      '01/03/2026, 09:16 - Alice: ok will do',
    ].join('\n'));

    const result = await pickAndParseWhatsAppExport();

    expect(result.messageCount).toBe(1);
  });

  it('silently drops continuation lines that lack their own timestamp prefix', async () => {
    // A known limitation of the line-based regex: multi-line messages only capture their first line.
    mockPickedFile([
      '01/03/2026, 09:15 - Alice: hey, quick question —',
      'are you around this weekend?',
    ].join('\n'));

    const result = await pickAndParseWhatsAppExport();

    expect(result.messageCount).toBe(1);
  });
});

describe('pickAndParseWhatsAppExport — errors', () => {
  it('throws Cancelled when the user backs out of the picker', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: true });

    await expect(pickAndParseWhatsAppExport()).rejects.toThrow('Cancelled');
  });

  it('throws when the picked file cannot be read', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false, assets: [{ uri: 'file:///export.txt' }],
    });
    (global as any).fetch = jest.fn(async () => ({ ok: false }));

    await expect(pickAndParseWhatsAppExport()).rejects.toThrow('Could not read file');
  });

  it('throws when no line in the file matches the expected export format', async () => {
    mockPickedFile('this is not a WhatsApp export at all\njust some random text');

    await expect(pickAndParseWhatsAppExport()).rejects.toThrow(/No messages found/);
  });
});

describe('pickAndParseWhatsAppExport — storage', () => {
  it('chunks a large message history into batches of 50 per memory row', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `01/03/2026, 09:${String(i % 60).padStart(2, '0')} - Alice: message number ${i}`);
    mockPickedFile(lines.join('\n'));

    const result = await pickAndParseWhatsAppExport();
    expect(result.messageCount).toBe(120);

    const contact = (await getAllContacts())[0];
    const memories = await getSemanticMemoriesByContact(contact.id, 100); // semantic-only — see below
    // conversation_history isn't 'semantic', so fetch it directly instead.
    const db = await getDatabase();
    const rows = await db.getAllAsync<{ content: string }>(
      'SELECT content FROM memories WHERE contact_id = ? AND type = ?', [contact.id, 'conversation_history']
    );
    expect(rows).toHaveLength(3); // 50 + 50 + 20
    expect(memories).toEqual([]); // sanity check the type filter actually excludes these
  });
});
