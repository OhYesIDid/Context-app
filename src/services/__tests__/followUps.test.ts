import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadFollowUps, addFollowUp, markDone, deleteFollowUp, urgency, formatDueLabel, type FollowUp } from '../followUps';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('loadFollowUps', () => {
  it('returns an empty array when nothing has been stored', async () => {
    expect(await loadFollowUps()).toEqual([]);
  });

  it('returns [] instead of throwing on malformed stored JSON', async () => {
    await AsyncStorage.setItem('contxt_follow_ups_v1', '{not valid json');
    expect(await loadFollowUps()).toEqual([]);
  });
});

describe('addFollowUp / markDone / deleteFollowUp', () => {
  it('prepends a new pending follow-up and persists it', async () => {
    const result = await addFollowUp({ text: 'Call the vet' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: 'Call the vet', status: 'pending' });
    expect(result[0].id).toMatch(/^fu_\d+_[a-z0-9]+$/);

    expect(await loadFollowUps()).toEqual(result);
  });

  it('prepends newest-first across multiple additions', async () => {
    // Prepend order is structural (unshift), not timestamp-sorted — no need to stagger the clock.
    await addFollowUp({ text: 'first' });
    const after = await addFollowUp({ text: 'second' });

    expect(after.map((f) => f.text)).toEqual(['second', 'first']);
  });

  it('marks only the matching id as done, leaving others untouched', async () => {
    const afterAdd = await addFollowUp({ text: 'a' });
    const target = afterAdd[0].id;
    await addFollowUp({ text: 'b' });

    const afterDone = await markDone(target);
    const byId = Object.fromEntries(afterDone.map((f) => [f.text, f.status]));
    expect(byId.a).toBe('done');
    expect(byId.b).toBe('pending');
  });

  it('deletes only the matching id', async () => {
    const first = (await addFollowUp({ text: 'keep' }))[0];
    const second = (await addFollowUp({ text: 'remove' }))[0];

    const after = await deleteFollowUp(second.id);
    expect(after.map((f) => f.id)).toEqual([first.id]);
  });
});

describe('urgency', () => {
  const NOW = new Date('2026-06-15T12:00:00Z');
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  const withDueAt = (dueAt: number | undefined): FollowUp =>
    ({ id: 'x', text: 't', createdAt: Date.now(), status: 'pending', dueAt } as FollowUp);

  it('is "none" when there is no due date', () => {
    expect(urgency(withDueAt(undefined))).toBe('none');
  });

  it('is "overdue" once the due time has passed', () => {
    expect(urgency(withDueAt(NOW.getTime() - 1000))).toBe('overdue');
  });

  it('is "today" for a due time later today', () => {
    const laterToday = new Date(NOW); laterToday.setHours(23, 0, 0, 0);
    expect(urgency(withDueAt(laterToday.getTime()))).toBe('today');
  });

  it('is "soon" for a due time within the next 3 days but not today', () => {
    expect(urgency(withDueAt(NOW.getTime() + 2 * 86_400_000))).toBe('soon');
  });

  it('is "later" for anything beyond 3 days out', () => {
    expect(urgency(withDueAt(NOW.getTime() + 10 * 86_400_000))).toBe('later');
  });
});

describe('formatDueLabel', () => {
  const NOW = new Date('2026-06-15T12:00:00Z');
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  const withDueAt = (dueAt: number | undefined): FollowUp =>
    ({ id: 'x', text: 't', createdAt: Date.now(), status: 'pending', dueAt } as FollowUp);

  it('is empty when there is no due date', () => {
    expect(formatDueLabel(withDueAt(undefined))).toBe('');
  });

  it('reports hours overdue under a day, days overdue beyond that', () => {
    expect(formatDueLabel(withDueAt(NOW.getTime() - 3 * 3_600_000))).toBe('3h ago');
    expect(formatDueLabel(withDueAt(NOW.getTime() - 30 * 3_600_000))).toBe('1d ago');
  });

  it('is "now" for something due within the hour', () => {
    expect(formatDueLabel(withDueAt(NOW.getTime() + 30 * 60_000))).toBe('now');
  });

  it('shows a time for something due later today', () => {
    const laterToday = new Date(NOW); laterToday.setHours(18, 30, 0, 0);
    expect(formatDueLabel(withDueAt(laterToday.getTime()))).toBe('by 18:30');
  });

  it('says "tomorrow" for something due the next day', () => {
    const tomorrowEvening = new Date(NOW); tomorrowEvening.setDate(tomorrowEvening.getDate() + 1); tomorrowEvening.setHours(9, 0, 0, 0);
    expect(formatDueLabel(withDueAt(tomorrowEvening.getTime()))).toBe('tomorrow');
  });

  it('shows a weekday for anything further out', () => {
    const nextWeek = new Date(NOW); nextWeek.setDate(nextWeek.getDate() + 5);
    expect(formatDueLabel(withDueAt(nextWeek.getTime()))).toBe(
      nextWeek.toLocaleDateString('en-GB', { weekday: 'short' })
    );
  });
});
