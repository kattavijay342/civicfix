/** Jaccard word-overlap similarity (0-1). Shared by
 * src/lib/duplicate-detection.ts (report-level) and
 * src/lib/incident-detection.ts (incident-level) so the two text-overlap
 * checks can never silently drift apart. */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsOf = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
  const setA = wordsOf(a);
  const setB = wordsOf(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
