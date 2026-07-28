import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadFollowUps, addFollowUp, markDone, deleteFollowUp, urgency, formatDueLabel, parseDueAt, taskTextSimilarity, type FollowUp } from '../followUps';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('parseDueAt', () => {
  it('returns undefined for null, undefined, or empty input', () => {
    expect(parseDueAt(null)).toBeUndefined();
    expect(parseDueAt(undefined)).toBeUndefined();
    expect(parseDueAt('')).toBeUndefined();
  });

  it('returns undefined for an unparseable string instead of NaN', () => {
    expect(parseDueAt('not a date')).toBeUndefined();
  });

  it('converts a valid ISO 8601 local datetime to a ms timestamp', () => {
    const ms = parseDueAt('2026-08-01T18:00:00');
    expect(ms).toBe(new Date('2026-08-01T18:00:00').getTime());
  });
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

describe('taskTextSimilarity', () => {
  it('scores 1 when one phrasing\'s content words are a subset of the other\'s', () => {
    expect(taskTextSimilarity('Call the dentist', 'Remind me to call the dentist about the appointment')).toBe(1);
  });

  it('scores lower for a different object with the same verb', () => {
    expect(taskTextSimilarity('Call the dentist', 'Call the vet')).toBeLessThan(0.7);
  });

  it('is order-independent', () => {
    expect(taskTextSimilarity('Send Sarah the invoice', 'Send the invoice to Sarah')).toBe(1);
  });

  it('returns 0 when either side has no content words left after stripping filler', () => {
    expect(taskTextSimilarity('to the a', 'Call the dentist')).toBe(0);
  });
});

describe('addFollowUp — duplicate merging', () => {
  it('merges a re-proposed pending follow-up with near-identical wording for the same contact instead of duplicating it', async () => {
    await addFollowUp({ text: 'Call the dentist', contactName: 'Sam' });
    const after = await addFollowUp({ text: 'Remind me to call the dentist about the appointment', contactName: 'Sam' });

    expect(after).toHaveLength(1);
  });

  it('does not merge across different contacts even with identical wording', async () => {
    await addFollowUp({ text: 'Call the dentist', contactName: 'Sam' });
    const after = await addFollowUp({ text: 'Call the dentist', contactName: 'Alex' });

    expect(after).toHaveLength(2);
  });

  it('does not merge against an already-done follow-up', async () => {
    const first = (await addFollowUp({ text: 'Call the dentist', contactName: 'Sam' }))[0];
    await markDone(first.id);
    const after = await addFollowUp({ text: 'Call the dentist', contactName: 'Sam' });

    expect(after).toHaveLength(2);
  });

  it('adopts the new due date on merge when it is sooner than the existing one', async () => {
    await addFollowUp({ text: 'Call the dentist', contactName: 'Sam', dueAt: 2_000 });
    const after = await addFollowUp({ text: 'Remind me to call the dentist', contactName: 'Sam', dueAt: 1_000 });

    expect(after).toHaveLength(1);
    expect(after[0].dueAt).toBe(1_000);
  });

  it('keeps the existing due date on merge when the new one is later or missing', async () => {
    await addFollowUp({ text: 'Call the dentist', contactName: 'Sam', dueAt: 1_000 });
    const after = await addFollowUp({ text: 'Remind me to call the dentist', contactName: 'Sam' });

    expect(after).toHaveLength(1);
    expect(after[0].dueAt).toBe(1_000);
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
