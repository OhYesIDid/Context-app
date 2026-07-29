// Jaro-Winkler string similarity, ported line-for-line from ContactMatcher.kt's private
// implementation (android/app/src/main/java/com/contextreply/app/ContactMatcher.kt) so
// JS-side contact dedup (imports, drainConfirmedIdentities) scores names the same way the
// native bubble-matching pipeline does — same MIN_MATCH threshold, same behavior on
// transposed "Smith John" vs "John Smith" names.

const MIN_MATCH = 0.70;

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;
  const window = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const m1 = new Array<boolean>(len1).fill(false);
  const m2 = new Array<boolean>(len2).fill(false);
  let matches = 0;

  for (let i = 0; i < len1; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, len2);
    for (let j = lo; j < hi; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true; m2[j] = true; matches++;
      break;
    }
  }
  if (matches === 0) return 0.0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const m = matches;
  return (m / len1 + m / len2 + (m - transpositions / 2) / m) / 3;
}

export function jaroWinkler(s1: string, s2: string): number {
  const j = jaro(s1, s2);
  const maxPre = Math.min(4, Math.min(s1.length, s2.length));
  let prefix = 0;
  while (prefix < maxPre && s1[prefix] === s2[prefix]) prefix++;
  return j + prefix * 0.1 * (1.0 - j);
}

// Handles transposed names: "Smith John" vs "John Smith"
export function tokenSortJaroWinkler(s1: string, s2: string): number {
  const sorted = (s: string) => s.split(/\s+/).sort().join(' ');
  return jaroWinkler(sorted(s1), sorted(s2));
}

export function nameSimilarity(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  return Math.max(jaroWinkler(s1, s2), tokenSortJaroWinkler(s1, s2));
}

/**
 * Finds the best-scoring candidate for `name` among `candidates` (scored via
 * nameSimilarity), returning null if nothing clears MIN_MATCH (0.70) — the same
 * threshold ContactMatcher.kt uses natively, so import-time dedup and live message
 * matching agree on what counts as "the same person."
 */
export function findBestNameMatch<T>(
  name: string,
  candidates: T[],
  getName: (c: T) => string,
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = nameSimilarity(name, getName(c));
    if (score >= MIN_MATCH && score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
