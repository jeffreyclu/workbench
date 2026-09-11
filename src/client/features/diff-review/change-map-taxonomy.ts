import type { ChangeMapNode } from '../../../shared/change-map.js';

/** What kind of code a change is, and where it lives.
 *
 * Colour on the map is not decoration and is not per-file: it answers "what
 * sort of thing is this" before the reader has read a single label. A diagram
 * that is mostly one colour is a diff inside one layer; one that is evenly
 * mixed is a change cutting through the stack, and that difference is visible
 * from across the room.
 *
 * The categories are deliberately few and deliberately about role rather than
 * language. A dozen buckets is roughly the number of hues a person can tell
 * apart at the size of a node; a per-extension palette would be a legend
 * nobody reads. */
export const CODE_CATEGORIES = ['ui', 'state', 'logic', 'api', 'data', 'types', 'test', 'config', 'styles', 'docs', 'tooling', 'other'] as const;
export type CodeCategory = typeof CODE_CATEGORIES[number];

export const CODE_CATEGORY_LABELS: Record<CodeCategory, string> = {
  ui: 'UI', state: 'State', logic: 'Logic', api: 'API', data: 'Data', types: 'Types',
  test: 'Tests', config: 'Config', styles: 'Styles', docs: 'Docs', tooling: 'Tooling', other: 'Other',
};

/** A one-line reading of each bucket, shown on the legend so the colours are
 * accountable to something a reviewer can check rather than guessed at. */
export const CODE_CATEGORY_DESCRIPTIONS: Record<CodeCategory, string> = {
  ui: 'Components and views',
  state: 'Hooks, stores and context',
  logic: 'Plain modules and domain code',
  api: 'Routes, handlers and server entry points',
  data: 'Repositories, migrations and persistence',
  types: 'Contracts and type-only declarations',
  test: 'Tests, fixtures and mocks',
  config: 'Configuration and manifests',
  styles: 'Stylesheets',
  docs: 'Documentation',
  tooling: 'Scripts and build tooling',
  other: 'Everything else',
};

/** Directories that hold a workspace's packages, so `packages/ui/...` reads as
 * one package rather than as everything under `packages` being one. */
const WORKSPACE_ROOTS = new Set(['packages', 'apps', 'services', 'libs', 'modules', 'plugins']);

/** The package a file belongs to: the unit a reviewer would call "somewhere
 * else entirely". In a workspace that is the published package; in a single
 * project it is the top division under `src` — `src/client`, `src/server`,
 * `src/shared` — because that is what a dependency crossing it costs. */
export function packageOf(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length <= 1) return '.';
  const [first, second] = segments;
  if (WORKSPACE_ROOTS.has(first) && segments.length > 2) return `${first}/${second}`;
  if (first === 'src' && segments.length > 2) return `src/${second}`;
  return first;
}

/** The directory holding the file — the "domain" a change is either contained
 * in or reaching out of. */
export function folderOf(filePath: string): string {
  const cut = filePath.lastIndexOf('/');
  return cut === -1 ? '.' : filePath.slice(0, cut);
}

/** The part of a folder's path below its package, which is what tells two
 * rings inside the same package apart. */
export function folderLabel(folderPath: string, packagePath: string): string {
  if (folderPath === packagePath) return '.';
  return folderPath.startsWith(`${packagePath}/`) ? folderPath.slice(packagePath.length + 1) : folderPath;
}

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift', 'cs', 'php', 'sql']);

/** Buckets that describe what a file is *for*. They outrank everything below,
 * including the type-only reading: a test that moves nothing but types is
 * still a test, and colouring it as a contract change would hide the only
 * thing about it that matters. */
const PURPOSE_CATEGORIES = new Set<CodeCategory>(['test', 'styles', 'docs', 'config', 'tooling']);

/** Order is the whole rule set, so it is written once, in order, rather than
 * spread through branches. Earlier entries win: a repository's test is a test
 * and not data, and `src/server/repository.ts` is data even though it sits
 * under a directory that otherwise reads as API. */
const PATH_RULES: Array<[CodeCategory, RegExp]> = [
  ['test', /(^|\/)(__tests__|__mocks__|tests?|fixtures?|mocks?|e2e)\//i],
  ['test', /\.(test|spec)\.[cm]?[jt]sx?$/i],
  ['styles', /\.(css|scss|sass|less|styl)$/i],
  ['docs', /\.(md|mdx|rst|adoc|txt)$/i],
  ['config', /\.config\.[cm]?[jt]s$/i],
  ['config', /\.(json|ya?ml|toml|ini|env|lock)$/i],
  ['config', /(^|\/)\.[^/]+$/],
  ['tooling', /(^|\/)(scripts?|bin|tools|build|ci|\.github)\//i],
  ['tooling', /\.(sh|bash|zsh|mk)$|(^|\/)(Makefile|Dockerfile)$/],
  ['types', /\.d\.ts$/i],
  ['types', /(^|\/)(types?|contracts?|dto|interfaces?)\.[cm]?tsx?$/i],
  ['types', /(^|\/)(types?|contracts?|interfaces?)\//i],
  ['data', /(^|\/)(db|database|repositor(y|ies)|migrations?|persistence|dao|entities|models?)\//i],
  ['data', /(^|\/)[^/]*[-.](repository|migration|schema|queries|dao|model)\.[cm]?[jt]s$/i],
  ['data', /(^|\/)(repository|database|migrations|schema|queries)\.[cm]?[jt]s$/i],
  ['api', /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|middleware|resolvers?|server)\//i],
  ['api', /(^|\/)[^/]*[-.](route|router|controller|handler|endpoint|api|client)\.[cm]?[jt]s$/i],
  ['api', /(^|\/)(api|routes|router|server)\.[cm]?[jt]s$/i],
  ['state', /(^|\/)(hooks?|stores?|context|state|atoms?|reducers?|slices?)\//i],
  ['state', /(^|\/)(use-[^/]+|[^/]*[-.](store|hooks?|context|atoms?|reducer|slice))\.[cm]?[jt]sx?$/i],
  ['ui', /\.(tsx|jsx|vue|svelte)$/i],
];

function extensionOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function matchPath(filePath: string): CodeCategory | null {
  for (const [category, pattern] of PATH_RULES) {
    if (pattern.test(filePath)) return category;
  }
  return null;
}

/** What kind of code this change is.
 *
 * The path decides almost every case, because a repository's layout is the
 * most reliable statement it makes about its own layers. The one signal that
 * beats it is the declarations the change actually moves: a change that adds
 * and removes nothing but types is a contract change wherever it lives, and
 * that is the fact a reviewer needs to see on it. */
export function categoryOf(node: Pick<ChangeMapNode, 'filePath' | 'symbols'>): CodeCategory {
  const matched = matchPath(node.filePath);
  if (matched && PURPOSE_CATEGORIES.has(matched)) return matched;
  if (node.symbols.length > 0 && node.symbols.every((symbol) => symbol.kind === 'type')) return 'types';
  if (matched) return matched;
  return CODE_EXTENSIONS.has(extensionOf(node.filePath)) ? 'logic' : 'other';
}
