/**
 * Project names are free text typed by Jeffrey, drafted by an AI, or imported
 * from Linear, and the Workbench stack itself is selected by project name. That
 * makes the string load-bearing: `Workbench`, `workbench`, `wokrbench`, and
 * `wkbnch` all mean the same project, but only one of them keeps a task in the
 * right stack and under one colour.
 *
 * This module is the single definition of what "the same project" means. It is
 * shared so the server can canonicalise on write and the client can ask
 * "is this the Workbench project?" without re-deriving the rule.
 *
 * Matching happens in two tiers, and both are deliberately conservative:
 *
 * 1. `projectKey` folds away the differences that are never meaningful — case,
 *    accents, punctuation, and spacing. Two names with the same key are the
 *    same project, no judgement required.
 * 2. `matchProjectKey` catches genuine typos with a bounded edit distance and a
 *    consonant-skeleton pass for dropped vowels. It only ever returns a single
 *    unambiguous winner.
 *
 * The thresholds below were checked against the 111 distinct project keys in
 * the live database: they produce zero merges among real, distinct projects
 * while still resolving `wokrbench`, `wkbnch`, and `conectors` to the right
 * place. Names shorter than five characters are matched exactly and never
 * fuzzily — `MCP`, `WDS`, and `Team` are all real projects.
 */

export const WORKBENCH_PROJECT_NAME = 'Workbench';
export const WORKBENCH_PROJECT_KEY = 'workbench';

/**
 * The comparison identity of a project name. Returns `''` for names with no
 * alphanumeric content, which callers treat as "not a registrable project".
 */
export function projectKey(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function isWorkbenchProject(name: string | null | undefined): boolean {
  return projectKey(name) === WORKBENCH_PROJECT_KEY;
}

/** Consonants carry the identity of a name; `wkbnch` is still recognisably `workbench`. */
function consonantSkeleton(key: string): string {
  return key.replace(/[aeiou]/g, '') || key;
}

/**
 * Optimal string alignment distance. Unlike plain Levenshtein it charges a
 * single edit for a transposition, which is the most common way a project name
 * is mistyped (`wokrbench`).
 */
function editDistance(a: string, b: string): number {
  const rows = a.length;
  const columns = b.length;
  if (!rows) return columns;
  if (!columns) return rows;
  const distance = Array.from({ length: rows + 1 }, (_, row) => {
    const line = new Array<number>(columns + 1).fill(0);
    line[0] = row;
    return line;
  });
  for (let column = 0; column <= columns; column += 1) distance[0][column] = column;
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const substitution = a[row - 1] === b[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitution,
      );
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        distance[row][column] = Math.min(distance[row][column], distance[row - 2][column - 2] + 1);
      }
    }
  }
  return distance[rows][columns];
}

/**
 * Fuzzy matching needs a name long enough that a typo is a better explanation
 * than a different word. `MCP`, `WDS`, and `Team` are all real projects, and a
 * one-edit budget on names that short would merge them with anything nearby.
 */
const MINIMUM_FUZZY_LENGTH = 5;

/** How many typos to forgive, scaled so long names are not held to a short name's budget. */
function typoTolerance(length: number): number {
  if (length <= 7) return 1;
  if (length <= 15) return 2;
  return 3;
}

/**
 * Finds the one known key a mistyped key almost certainly meant, or `null`.
 *
 * Returns `null` whenever two candidates are equally good. A wrong merge is
 * worse than a new project: the new project is visible and fixable, a silently
 * relabelled task is neither.
 */
export function matchProjectKey(key: string, knownKeys: Iterable<string>): string | null {
  if (!key) return null;
  let best: { key: string; score: number } | null = null;
  let ambiguous = false;
  for (const candidate of knownKeys) {
    if (candidate === key) return candidate;
    const score = matchScore(key, candidate);
    if (score === null) continue;
    if (!best || score < best.score) {
      best = { key: candidate, score };
      ambiguous = false;
    } else if (score === best.score) {
      ambiguous = true;
    }
  }
  return best && !ambiguous ? best.key : null;
}

/** Lower is a better match. `null` means the two keys are not the same project. */
function matchScore(key: string, candidate: string): number | null {
  if (key.length < MINIMUM_FUZZY_LENGTH || candidate.length < MINIMUM_FUZZY_LENGTH) return null;
  const distance = editDistance(key, candidate);
  if (distance <= typoTolerance(Math.min(key.length, candidate.length))) return distance;
  // A dropped-vowel abbreviation is much shorter than the name it stands for,
  // so this pass compares consonant skeletons instead of the keys themselves.
  if (Math.abs(key.length - candidate.length) <= 3) {
    const skeletonDistance = editDistance(consonantSkeleton(key), consonantSkeleton(candidate));
    if (skeletonDistance <= 1) return 100 + skeletonDistance;
  }
  return null;
}
