export const FINAL_RESPONSE_CONTRACT = `Final response: Workbench will reject and rewrite the draft before delivery unless it uses exactly three Markdown sections in this order: ## Problem, ## Solution, ## Context. Put each heading on its own line. For a normal response, give each section one short plain-English paragraph and target 120 words or fewer. Do not add a preamble, closing remark, repeated conclusion, or unexplained specialist shorthand. Keep exact commands, paths, URLs, error text, verification, and blockers when they matter. Never truncate an answer or omit material results to meet the length target. If Jeffrey's current request explicitly asks you to be verbose or to give a verbose response, keep the same three sections but allow multiple paragraphs, lists, and the length needed for that answer. This override applies only to that request.`;

const SHORT_SECTIONS = /^## Problem\r?\n[^\r\n]+\r?\n\r?\n## Solution\r?\n[^\r\n]+\r?\n\r?\n## Context\r?\n[^\r\n]+$/;
const VERBOSE_SECTIONS = /^## Problem\r?\n[\s\S]+?\r?\n\r?\n## Solution\r?\n[\s\S]+?\r?\n\r?\n## Context\r?\n[\s\S]+$/;
const INLINE_SECTIONS = /^Problem:\s+([\s\S]+?)\s+Solution:\s+([\s\S]+?)\s+Context:\s+([\s\S]+)$/;

export function normalizeFinalResponse(output: string): string {
  const trimmed = output.trim();
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

export function finalResponsePolicyViolation(output: string, verbose = false): string | null {
  const trimmed = output.trim();
  if (!trimmed) return 'The response is empty.';
  if (!(verbose ? VERBOSE_SECTIONS : SHORT_SECTIONS).test(trimmed)) return 'The response does not use separate Problem, Solution, and Context sections in that order.';
  if (verbose) return null;
  return null;
}

export function finalResponseEditingEnabled(): boolean {
  return !process.env.VITEST || process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY === '1';
}

function plainParagraph(value: string): string {
  const words = value
    .replace(/<workbench-plan>[\s\S]*?<\/workbench-plan>/gi, '')
    .replace(/```(?:\w+)?/g, '')
    .replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/gm, '')
    .replace(/\b(?:Problem|Solution|Context):\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return 'No usable detail was returned.';
  return words.join(' ');
}

export function fallbackFinalResponse(draft: string, objective: string, verbose = false): string {
  if (verbose) return `## Problem\n${plainParagraph(objective)}\n\n## Solution\n${draft.trim()}\n\n## Context\nNo additional context.`;
  return `## Problem\n${plainParagraph(objective)}\n\n## Solution\n${plainParagraph(draft)}\n\n## Context\nNo additional context.`;
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
