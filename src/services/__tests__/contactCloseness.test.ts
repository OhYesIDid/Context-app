import { NativeModules } from 'react-native';
import { recomputeClosenessScore } from '../contactCloseness';
import { updateContactCloseness } from '../database';

jest.mock('../database', () => ({
  updateContactCloseness: jest.fn(),
}));

const LINKS = JSON.stringify([
  { convKey: 'com.whatsapp:Alice', contactId: 'c1', displayName: 'Alice', platform: 'whatsapp' },
  { convKey: 'org.telegram.messenger:alice_t', contactId: 'c1', displayName: 'alice_t', platform: 'telegram' },
  { convKey: 'com.whatsapp:Bob', contactId: 'c2', displayName: 'Bob', platform: 'whatsapp' },
]);

describe('recomputeClosenessScore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    NativeModules.ProTxtSettings = {
      getAllConfirmedLinks: jest.fn().mockResolvedValue(LINKS),
      getClosenessScores: jest.fn().mockResolvedValue(JSON.stringify({ 'com.whatsapp:Alice': 0.4, 'org.telegram.messenger:alice_t': 0.9 })),
    };
  });

  it('takes the max score across every platform linked to the contact, not an average', async () => {
    const score = await recomputeClosenessScore('c1');
    expect(score).toBe(0.9);
    expect(updateContactCloseness).toHaveBeenCalledWith('c1', 0.9);
  });

  it('only queries convKeys belonging to the requested contact', async () => {
    await recomputeClosenessScore('c1');
    const queried = JSON.parse((NativeModules.ProTxtSettings.getClosenessScores as jest.Mock).mock.calls[0][0]);
    expect(queried.sort()).toEqual(['com.whatsapp:Alice', 'org.telegram.messenger:alice_t'].sort());
  });

  it('returns null and writes nothing when the contact has no linked platforms', async () => {
    const score = await recomputeClosenessScore('unknown-contact');
    expect(score).toBeNull();
    expect(updateContactCloseness).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when no linked platform has scoreable data yet', async () => {
    NativeModules.ProTxtSettings.getClosenessScores = jest.fn().mockResolvedValue(JSON.stringify({}));
    const score = await recomputeClosenessScore('c1');
    expect(score).toBeNull();
    expect(updateContactCloseness).not.toHaveBeenCalled();
  });

  it('resolves null instead of throwing if the native module is unavailable', async () => {
    NativeModules.ProTxtSettings = undefined as any;
    await expect(recomputeClosenessScore('c1')).resolves.toBeNull();
  });
});
