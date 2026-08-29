import { splitChangedLines } from './change-type.js';
import type { EvidenceHunk } from './coverage-evidence.js';

/** The surface a diff asserts exists but cannot show.
 *
 * Every other check in this review reads relationships between things the
 * patch contains: a caller and its callee, a declaration and the test that
 * names it. Both ends are on screen, so the check can settle itself. An
 * import of a third-party package is the opposite case — the patch states
 * that `retryDelay` is an option of a client it does not include, and nothing
 * in the diff, the review or the repository can contradict it. The same holds
 * for an environment variable: the diff proves the code reads `STRIPE_KEY`,
 * never that anything sets it.
 *
 * This is the failure that survives a clean read of everything else, because
 * generated code is fluent about interfaces it has not checked. So the module
 * does not try to decide whether the name is real. It collects the claims the
 * patch newly makes about the outside world and puts them in front of the
 * reviewer as the short list to confirm against documentation, which is the
 * only place the answer lives.
 *
 * Newness matters more than presence. An import that merely moved between
 * lines was already true before the patch and has already been paid for; only
 * a specifier that is absent from the removed side is a claim this change is
 * making for the first time. */
export interface ExternalImportClaim {
  /** The bare package specifier, never a relative path: a relative import
   * resolves to a file that review can actually open. */
  module: string;
  /** The names taken from it, which is the part most likely to be invented.
   * Empty for a side-effect import, where the package itself is the claim. */
  symbols: string[];
}

export interface ExternalSurfaceEvidence {
  imports: ExternalImportClaim[];
  /** Environment and build-time configuration keys the patch starts reading. */
  envKeys: string[];
  /** Every claim as one phrase, ordered for reading: packages first, because a
   * wrong symbol on a real package is the more common failure and the more
   * expensive one to find at runtime. */
  claims: string[];
}

export const EMPTY_EXTERNAL_SURFACE: ExternalSurfaceEvidence = { imports: [], envKeys: [], claims: [] };

/** Bounded for the same reason the coverage pack is: this rides in a summary
 * with a word budget, and a list past this length is not read at all. */
const MAX_CLAIMS = 8;
const MAX_SYMBOLS_PER_MODULE = 6;

/** Only JS/TS syntax is parsed here. A JSON or YAML file mentioning a package
 * name is a manifest, not a call into it. */
const CODE_FILE = /\.(?:m|c)?[jt]sx?$/;

const IMPORT_PATTERN = /import\s+(?:([\w$*{},\s]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_PATTERN = /(?:^|[^\w$])require\(\s*['"]([^'"]+)['"]\s*\)/g;
const ENV_PATTERN = /(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

/** A specifier that resolves to a file rather than a dependency. Those are
 * already reviewable — the file is either in the diff or in the repository —
 * so they are not claims about the outside world. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** The names an import clause binds, with aliases reduced to the name actually
 * taken from the module: `{ readFile as read }` is a claim about `readFile`,
 * and `read` is a local decision that cannot be wrong about the package. */
function importedSymbols(clause: string | undefined): string[] {
  if (!clause) return [];
  const braced = clause.match(/\{([^}]*)\}/);
  const names: string[] = [];
  const bare = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+[\w$]+/g, '').replace(/,/g, ' ').trim();
  if (bare) names.push(bare.split(/\s+/)[0]);
  if (braced) {
    for (const entry of braced[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
      if (name) names.push(name);
    }
  }
  return names.filter(Boolean);
}

interface ScanResult {
  modules: Map<string, Set<string>>;
  envKeys: Set<string>;
}

function scan(lines: string[]): ScanResult {
  const modules = new Map<string, Set<string>>();
  const envKeys = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(IMPORT_PATTERN)) {
      const specifier = match[2];
      if (!isBareSpecifier(specifier)) continue;
      const existing = modules.get(specifier) ?? new Set<string>();
      for (const name of importedSymbols(match[1])) existing.add(name);
      modules.set(specifier, existing);
    }
    for (const match of line.matchAll(REQUIRE_PATTERN)) {
      if (!isBareSpecifier(match[1])) continue;
      if (!modules.has(match[1])) modules.set(match[1], new Set());
    }
    for (const match of line.matchAll(ENV_PATTERN)) {
      const key = match[1] ?? match[2];
      if (key) envKeys.add(key);
    }
  }
  return { modules, envKeys };
}

function phraseFor(claim: ExternalImportClaim): string {
  if (claim.symbols.length === 0) return `\`${claim.module}\``;
  return `${claim.symbols.slice(0, MAX_SYMBOLS_PER_MODULE).map((name) => `\`${name}\``).join(', ')} from \`${claim.module}\``;
}

/** What the patch newly asserts about code it does not contain.
 *
 * Read from the added side and subtracted against the removed side, per hunk,
 * so an import that survived a reformat is not reported as new. A symbol is
 * new when the module is new or when that particular name was not taken from
 * the module before — widening an existing import to pull one more function
 * out of it is exactly the edit that invents a function. */
export function buildExternalSurfaceEvidence(target: EvidenceHunk[]): ExternalSurfaceEvidence {
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  const addedEnv = new Set<string>();
  const removedEnv = new Set<string>();

  for (const hunk of target) {
    if (!CODE_FILE.test(hunk.filePath)) continue;
    const sides = splitChangedLines(hunk.lines);
    const addedSide = scan(sides.added);
    const removedSide = scan(sides.removed);
    for (const [module, symbols] of addedSide.modules) {
      const existing = added.get(module) ?? new Set<string>();
      for (const name of symbols) existing.add(name);
      added.set(module, existing);
    }
    for (const [module, symbols] of removedSide.modules) {
      const existing = removed.get(module) ?? new Set<string>();
      for (const name of symbols) existing.add(name);
      removed.set(module, existing);
    }
    for (const key of addedSide.envKeys) addedEnv.add(key);
    for (const key of removedSide.envKeys) removedEnv.add(key);
  }

  const imports: ExternalImportClaim[] = [];
  for (const [module, symbols] of [...added].sort(([left], [right]) => left.localeCompare(right))) {
    const before = removed.get(module);
    const fresh = [...symbols].filter((name) => !before?.has(name)).sort();
    // A side-effect import counts only when the module itself is new; one that
    // was already imported for its side effects is not a new claim.
    if (fresh.length === 0 && (before || symbols.size > 0)) continue;
    imports.push({ module, symbols: fresh });
  }

  const envKeys = [...addedEnv].filter((key) => !removedEnv.has(key)).sort();
  const claims = [...imports.map(phraseFor), ...envKeys.map((key) => `\`${key}\``)].slice(0, MAX_CLAIMS);
  return { imports, envKeys, claims };
}
