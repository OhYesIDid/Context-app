import { jaroWinkler, tokenSortJaroWinkler, nameSimilarity, findBestNameMatch } from '../fuzzyMatch';

describe('jaroWinkler', () => {
  it('scores identical strings as 1.0', () => {
    expect(jaroWinkler('paul diaz', 'paul diaz')).toBe(1.0);
  });

  it('scores completely different strings low', () => {
    expect(jaroWinkler('paul diaz', 'zzz qqq')).toBeLessThan(0.5);
  });

  it('scores a close typo highly (classic MARTHA/MARHTA vector)', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.9);
  });

  it('rewards a shared prefix more than an equivalent internal difference', () => {
    const sharedPrefix = jaroWinkler('paul diaz', 'paul diez');
    const noPrefix = jaroWinkler('zaul diap', 'zaul diep');
    expect(sharedPrefix).toBeGreaterThanOrEqual(noPrefix);
  });
});

describe('tokenSortJaroWinkler', () => {
  it('matches transposed name order', () => {
    expect(tokenSortJaroWinkler('Diaz Paul', 'Paul Diaz')).toBe(1.0);
  });
});

describe('nameSimilarity', () => {
  it('is case-insensitive and takes the best of direct/token-sorted scores', () => {
    expect(nameSimilarity('PAUL DIAZ', 'diaz paul')).toBe(1.0);
  });

  it('scores a middle-initial variant highly but not perfectly', () => {
    const score = nameSimilarity('Paul Diaz', 'Paul A. Diaz');
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThan(1.0);
  });
});

describe('findBestNameMatch', () => {
  const contacts = [
    { id: '1', displayName: 'Paul Diaz' },
    { id: '2', displayName: 'Susan Meireles' },
    { id: '3', displayName: 'Preet Ramanu' },
  ];

  it('finds the best match above the 0.70 threshold', () => {
    const match = findBestNameMatch('Paul A. Diaz', contacts, (c) => c.displayName);
    expect(match?.id).toBe('1');
  });

  it('returns null when nothing clears the threshold', () => {
    const match = findBestNameMatch('Zzyzx Qwerty', contacts, (c) => c.displayName);
    expect(match).toBeNull();
  });

  it('picks the highest-scoring candidate, not just the first that clears the bar', () => {
    const close = [
      { id: 'a', displayName: 'Jon Smith' },
      { id: 'b', displayName: 'John Smith' },
    ];
    const match = findBestNameMatch('John Smith', close, (c) => c.displayName);
    expect(match?.id).toBe('b');
  });
});
