import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { declaredNames, splitChangedLines } from '../shared/change-type.js';
import { EMPTY_STALE_REFERENCE_REPORT, type StaleReference, type StaleReferenceReport } from '../shared/stale-reference-contract.js';
import { getWorkspaceDiff, resolveWorkspaceRepository } from './workspace-diff.js';

const execFile = promisify(execFileCallback);

/** The references the patch did not update.
 *
 * Every other check in this review is diff-scoped, and that is the right scope
 * for almost all of them: the reviewer's question is "what else in this change
 * moved because of this?". But it leaves one failure invisible by
 * construction. A generated patch that widens a signature and updates three of
 * the five call sites produces a diff in which all three updated callers are
 * present, consistent, and correctly linked. The two it forgot are not in the
 * diff at all, so they have no node, no edge and no hunk. The map renders
 * clean, and the change is broken.
 *
 * This is the one check that has to leave the diff to be worth anything, and
 * it is worth the departure precisely because it is not a judgement. "This
 * file still says `loadConfig(` and the patch changed `loadConfig`" is a fact
 * the repository can be asked for directly.
 *
 * The search is deliberately narrow. Only declarations present on the *removed*
 * side are looked up — a name that exists after the patch and not before is
 * new, and nothing outside the diff can already reference it. So the symbols
 * asked about are exactly those whose shape the patch altered or deleted,
 * which is the set where an untouched reference is a defect rather than a
 * coincidence.
 *
 * It reports where to look, never a verdict. `git grep` matches text, so a hit
 * can be an unrelated method of the same name, and only reading it settles
 * that. Stating it as a location earns its place in a summary; stating it as a
 * break would be a claim this module cannot support. */
export type { StaleReference, StaleReferenceReport } from '../shared/stale-reference-contract.js';

/** Bounds. A repository-wide grep per symbol is the expensive part of this
 * check, so the symbol count is capped before any process is spawned, and each
 * symbol stops at a handful of hits: the reviewer needs to know a stale
 * reference exists and where to start, not to be handed every occurrence. */
const MAX_SYMBOLS = 12;
const MAX_HITS_PER_SYMBOL = 5;
const MAX_TEXT_LENGTH = 160;

/** Names common enough that a repository-wide match says nothing. The change
 * map keeps its own list for the same reason; this one is stricter because a
 * grep has none of the syntactic context the map's parser has. */
const AMBIGUOUS_NAMES = new Set([
  'config', 'context', 'count', 'data', 'error', 'event', 'file', 'handler', 'id', 'index', 'item', 'items',
  'key', 'label', 'line', 'list', 'map', 'message', 'name', 'node', 'options', 'path', 'props', 'ref',
  'render', 'request', 'response', 'result', 'set', 'state', 'text', 'title', 'type', 'value',
]);

const CODE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mts', '*.cts', '*.mjs', '*.cjs'];

/** `git grep` exits 1 for "no matches", which is a result and not a failure.
 * Any other non-zero exit is a real error and is allowed to propagate. */
async function grepSymbol(repositoryPath: string, symbol: string): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['grep', '--no-color', '-n', '--word-regexp', '--fixed-strings', '-e', symbol, '--', ...CODE_GLOBS],
      { cwd: repositoryPath, maxBuffer: 8 * 1024 * 1024, timeout: 10_000, encoding: 'utf8' },
    );
    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

/** `path:line:text`, where the text may itself contain colons. */
function parseGrepLine(line: string): { filePath: string; line: number; text: string } | null {
  const first = line.indexOf(':');
  if (first < 0) return null;
  const second = line.indexOf(':', first + 1);
  if (second < 0) return null;
  const lineNumber = Number(line.slice(first + 1, second));
  if (!Number.isInteger(lineNumber)) return null;
  return { filePath: line.slice(0, first), line: lineNumber, text: line.slice(second + 1).trim().slice(0, MAX_TEXT_LENGTH) };
}

/** Declarations the patch changed or deleted, read from the removed side of
 * every changed file. */
export function symbolsAtRisk(files: Array<{ path: string; patch: string | null; isBinary: boolean }>): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (file.isBinary || !file.patch) continue;
    if (!CODE_GLOBS.some((glob) => file.path.endsWith(glob.slice(1)))) continue;
    for (const name of declaredNames(splitChangedLines(file.patch.split('\n')).removed)) {
      if (!AMBIGUOUS_NAMES.has(name) && name.length > 2) names.add(name);
    }
  }
  return [...names].sort().slice(0, MAX_SYMBOLS);
}

/** Finds references to changed declarations in files the patch never touched. */
export async function findStaleReferences(workspacePath: string): Promise<StaleReferenceReport> {
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  const diff = await getWorkspaceDiff(workspacePath);
  const changedFiles = new Set(diff.files.map((file) => file.path));
  const symbols = symbolsAtRisk(diff.files);
  if (symbols.length === 0) return EMPTY_STALE_REFERENCE_REPORT;

  const references: StaleReference[] = [];
  const staleSymbols: string[] = [];
  let truncated = false;

  const results = await Promise.all(symbols.map(async (symbol) => ({ symbol, lines: await grepSymbol(repositoryPath, symbol) })));
  for (const { symbol, lines } of results) {
    const outside = lines
      .map(parseGrepLine)
      .filter((hit): hit is { filePath: string; line: number; text: string } => hit !== null)
      .filter((hit) => !changedFiles.has(hit.filePath));
    if (outside.length === 0) continue;
    staleSymbols.push(symbol);
    if (outside.length > MAX_HITS_PER_SYMBOL) truncated = true;
    for (const hit of outside.slice(0, MAX_HITS_PER_SYMBOL)) references.push({ symbol, ...hit });
  }

  return { symbols, references, staleSymbols: staleSymbols.sort(), truncated };
}
