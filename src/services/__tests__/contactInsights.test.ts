import { NativeModules } from 'react-native';
import { getContactInsights } from '../contactInsights';
import { getTopIntentForContact } from '../database';

jest.mock('../database', () => ({
  getTopIntentForContact: jest.fn(),
}));

const LINKS = JSON.stringify([
  { convKey: 'com.whatsapp:Alice', contactId: 'c1', displayName: 'Alice', platform: 'whatsapp' },
  { convKey: 'org.telegram.messenger:alice_t', contactId: 'c1', displayName: 'alice_t', platform: 'telegram' },
  { convKey: 'com.whatsapp:Bob', contactId: 'c2', displayName: 'Bob', platform: 'whatsapp' },
]);

describe('getContactInsights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTopIntentForContact as jest.Mock).mockResolvedValue(null);
    NativeModules.ProTxtSettings = {
      getAllConfirmedLinks: jest.fn().mockResolvedValue(LINKS),
      getContactInsightsRaw: jest.fn().mockResolvedValue(JSON.stringify({
        'com.whatsapp:Alice': { msgsLast7d: 10, msgsPrior7d: 4, avgReplySecs: 120, mostActiveHour: 14 },
        'org.telegram.messenger:alice_t': { msgsLast7d: 2, msgsPrior7d: 0 },
      })),
    };
  });

  it('sums message counts across every platform linked to the contact', async () => {
    const result = await getContactInsights('c1');
    expect(result?.msgsLast7d).toBe(12);
    expect(result?.msgsPrior7d).toBe(4);
  });

  it('takes reply-speed and active-hour from the platform with the most last-7-day volume, not an average', async () => {
    const result = await getContactInsights('c1');
    expect(result?.avgReplySecs).toBe(120);
    expect(result?.mostActiveHour).toBe(14);
  });

  it('includes the top intent from the separate style_edits aggregate', async () => {
    (getTopIntentForContact as jest.Mock).mockResolvedValue('eta');
    const result = await getContactInsights('c1');
    expect(result?.topIntent).toBe('eta');
  });

  it('only aggregates convKeys belonging to the requested contact', async () => {
    await getContactInsights('c1');
    const queried = JSON.parse((NativeModules.ProTxtSettings.getContactInsightsRaw as jest.Mock).mock.calls[0][0]);
    expect(queried.sort()).toEqual(['com.whatsapp:Alice', 'org.telegram.messenger:alice_t'].sort());
  });

  it('returns an intent-only result when there is a top intent but no platform signal data', async () => {
    (getTopIntentForContact as jest.Mock).mockResolvedValue('booking');
    NativeModules.ProTxtSettings.getAllConfirmedLinks = jest.fn().mockResolvedValue(JSON.stringify([]));

    const result = await getContactInsights('c1');
    expect(result).toEqual({ msgsLast7d: 0, msgsPrior7d: 0, topIntent: 'booking' });
  });

  it('returns null when there is neither a top intent nor any platform signal data', async () => {
    NativeModules.ProTxtSettings.getAllConfirmedLinks = jest.fn().mockResolvedValue(JSON.stringify([]));
    const result = await getContactInsights('unknown-contact');
    expect(result).toBeNull();
  });

  it('falls back gracefully instead of throwing if the native module is unavailable', async () => {
    NativeModules.ProTxtSettings = undefined as any;
    await expect(getContactInsights('c1')).resolves.toBeNull();
  });
});
