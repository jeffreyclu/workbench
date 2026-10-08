import { stripFolds } from '../shared/review-synthesis.js';

export const GLOBAL_BREVITY_CONTRACT = `Global brevity rule: this applies to every user-visible answer from every agent, execution category, retry, code-review pass, and synthesis. Lead with the practical result. Use plain English and short sentences. A normal answer has a hard limit of 120 words. Do not narrate the investigation or use unexplained engineering shorthand. When several results matter, use compact bullets. Preserve concrete findings, exact evidence, verification gaps, commands, paths, URLs, and blockers; shorten the wording rather than deleting material results. A five-pass review may exceed 120 words only when needed to retain its actual findings, and must still use one compact bullet per finding. The only full verbosity override is Jeffrey explicitly asking for a verbose response in the current turn; it expires after that turn.`;

export const FINAL_RESPONSE_CONTRACT = `${GLOBAL_BREVITY_CONTRACT}

Final response: use exactly three Markdown sections in this order: ## Problem, ## Solution, ## Context. Put each heading on its own line. When the answer contains several items, use a readable Markdown list inside the relevant section. Do not add a preamble, closing remark, repeated conclusion, or unexplained specialist shorthand. Never truncate an answer, flatten a list, or omit material results to meet the length target. If Jeffrey's current request explicitly asks you to be verbose or to give a verbose response, keep the same three sections but use the length needed for that answer. This override applies only to that request.`;

const NORMAL_RESPONSE_HARD_LIMIT = 120;
const REVIEW_RESPONSE_HARD_LIMIT = 350;

const STRUCTURED_SECTIONS = /^## Problem\r?\n[\s\S]+?\r?\n\r?\n## Solution\r?\n[\s\S]+?\r?\n\r?\n## Context\r?\n[\s\S]+$/;
const INLINE_SECTIONS = /^Problem:\s+([\s\S]+?)\s+Solution:\s+([\s\S]+?)\s+Context:\s+([\s\S]+)$/;

export function normalizeFinalResponse(output: string): string {
  const trimmed = output.trim();
  const structuredStart = trimmed.search(/(?:^|\n)## Problem\r?\n/);
  if (structuredStart >= 0) {
    const structured = trimmed.slice(structuredStart).trim();
    if (STRUCTURED_SECTIONS.test(structured)) return structured;
  }
  const inline = trimmed.match(INLINE_SECTIONS);
  if (!inline) return trimmed;
  return `## Problem\n${inline[1].trim()}\n\n## Solution\n${inline[2].trim()}\n\n## Context\n${inline[3].trim()}`;
}

export function verboseResponseRequested(request: string): boolean {
  if (/\b(?:do not|don't|never|not|less)\s+(?:be\s+)?verbose\b/i.test(request)) return false;
  return /\b(?:please\s+)?be\s+(?:very\s+)?verbose\b/i.test(request)
    || /\brespond\s+(?:very\s+)?verbosely\b/i.test(request)
    || /\b(?:give|provide|write|send|make)\s+(?:me\s+)?(?:an?\s+)?verbose\s+(?:response|answer|explanation|breakdown)\b/i.test(request);
}

function visibleWordCount(value: string): number {
  return value
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_#[\]()>-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

/** Deterministic style gate used before a provider result becomes visible.
 * It deliberately checks measurable brevity failures; the shared agent
 * contract supplies the plain-language requirement at generation time. */
export function responseStyleViolation(output: string, options: { verbose?: boolean; review?: boolean } = {}): string | null {
  if (options.verbose) return null;
  // Folded review content (`:::fold`) is collapsed for the reader and does not count.
  const words = visibleWordCount(options.review ? stripFolds(output) : output);
  const limit = options.review ? REVIEW_RESPONSE_HARD_LIMIT : NORMAL_RESPONSE_HARD_LIMIT;
  if (words > limit) return `The response is ${words} words; the non-verbose limit is ${limit}.`;
  return null;
}

export function finalResponsePolicyViolation(output: string, _verbose = false): string | null {
  const trimmed = output.trim();
  if (!trimmed) return 'The response is empty.';
  if (!STRUCTURED_SECTIONS.test(trimmed)) return 'The response does not use separate Problem, Solution, and Context sections in that order.';
  return null;
}

export function finalResponseEditingEnabled(): boolean {
  return !process.env.VITEST || process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY === '1';
}

function cleanSectionMarkdown(value: string): string {
  const cleaned = value
    .replace(/<workbench-plan>[\s\S]*?<\/workbench-plan>/gi, '')
    .replace(/^\s*(?:#{1,6}\s+)?(?:Problem|Solution|Context):?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || 'No usable detail was returned.';
}

export function fallbackFinalResponse(draft: string, objective: string, _verbose = false): string {
  const problem = cleanSectionMarkdown(objective).replace(/\n+/g, ' ');
  const solution = cleanSectionMarkdown(draft);
  return `## Problem\n${problem}\n\n## Solution\n${solution}\n\n## Context\nNo additional context.`;
}

type FinalResponseOptions = { verbose?: boolean };

export async function editFinalResponse(
  draft: string,
  objective: string,
  optionsOrEdit: FinalResponseOptions | ((prompt: string) => Promise<string>) = {},
  _suppliedEdit?: (prompt: string) => Promise<string>,
): Promise<string> {
  const options = typeof optionsOrEdit === 'function' ? {} : optionsOrEdit;
  const verbose = options.verbose === true;
  const normalized = normalizeFinalResponse(draft);
  if (!finalResponsePolicyViolation(normalized, verbose)) return normalized;
  return fallbackFinalResponse(draft, objective, verbose);
}

const COMPLETION_CLAIM = /\b(?:done|fixed|works|verified)\b/gi;
// A claim word is negated by "not", "never", "no", "without" or any "n't"
// contraction within the two words before it ("not yet verified").
const NEGATED_BEFORE = /(?:\b(?:not|never|no|cannot|without)|n['’]t)(?:\s+[\w'’]+){0,2}\s+$/i;

/** True when the final answer asserts completion ("done", "fixed", "works", "verified") without negating it. */
export function claimsCompletion(output: string): boolean {
  const prose = output.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const match of prose.matchAll(COMPLETION_CLAIM)) {
    if (!NEGATED_BEFORE.test(prose.slice(Math.max(0, match.index - 40), match.index))) return true;
  }
  return false;
}

export const NO_UI_SURFACE_BADGE = 'no UI surface named';

const WHERE_TO_SEE_IT = /^[ \t>*_-]*(?:\*\*)?Where to see it:(?:\*\*)?[ \t]*\S/im;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\/__tests__\//;
// Client UI roots per repository: workbench `src/client`, writer-monorepo
// `frontend/src`, fe.web-app `src`. fe.web-app shares `src` with nothing else
// in its repo, so it is recognised by the repository directory name.
const CLIENT_PATH = /(?:^|\/)src\/client\/|(?:^|\/)frontend\/src\/|(?:^|\/)fe\.web-app(?:-[0-9a-f]+)?\/(?:[^/]+\/)*?src\//;

/** True when any observed file write landed in a client UI directory (tests excluded). */
export function writesClientFiles(paths: readonly string[]): boolean {
  return paths.some((path) => !TEST_FILE.test(path) && CLIENT_PATH.test(path.replace(/\\/g, '/')));
}

/** True when the answer has a line starting `Where to see it:` that names something. */
export function namesUiSurface(output: string): boolean {
  return WHERE_TO_SEE_IT.test(output);
}
