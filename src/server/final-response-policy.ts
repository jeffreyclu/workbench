import { editFinalResponseWithSupervisor } from './turn-grounding-ai.js';

export const FINAL_RESPONSE_CONTRACT = `Final response: Workbench will reject and rewrite the draft before delivery unless it is one plain-English paragraph of at most 120 words in exactly this order: Problem: ... Solution: ... Context: ... Never use a list, heading, blank line, preamble, repeated conclusion, or unexplained specialist shorthand. Keep exact commands, paths, URLs, error text, verification, and blockers when they matter. If Jeffrey's current request explicitly asks you to be verbose or to give a verbose response, keep the same plain-English Problem, Solution, Context order but allow multiple paragraphs, lists, and the length needed for that answer. This override applies only to that request.`;

const LABELS = /^Problem:\s+.+\s+Solution:\s+.+\s+Context:\s+.+$/s;

export function verboseResponseRequested(request: string): boolean {
  if (/\b(?:do not|don't|never|not|less)\s+(?:be\s+)?verbose\b/i.test(request)) return false;
  return /\b(?:please\s+)?be\s+(?:very\s+)?verbose\b/i.test(request)
    || /\brespond\s+(?:very\s+)?verbosely\b/i.test(request)
    || /\b(?:give|provide|write|send|make)\s+(?:me\s+)?(?:an?\s+)?verbose\s+(?:response|answer|explanation|breakdown)\b/i.test(request);
}

export function finalResponsePolicyViolation(output: string, verbose = false): string | null {
  const trimmed = output.trim();
  if (!trimmed) return 'The response is empty.';
  if (!LABELS.test(trimmed)) return 'The response does not use Problem, Solution, Context in that order.';
  if (verbose) return null;
  if (/\r?\n/.test(trimmed)) return 'The response uses more than one line or paragraph.';
  if (trimmed.split(/\s+/).length > 120) return 'The response is longer than 120 words.';
  return null;
}

export function finalResponseEditingEnabled(): boolean {
  return !process.env.VITEST || process.env.WORKBENCH_TEST_FINAL_RESPONSE_POLICY === '1';
}

function compactWords(value: string, limit: number): string {
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
  return `${words.slice(0, limit).join(' ')}${words.length > limit ? '…' : ''}`;
}

export function fallbackFinalResponse(draft: string, objective: string, verbose = false): string {
  if (verbose) return `Problem: ${compactWords(objective, 40)}\n\nSolution: ${draft.trim()}\n\nContext: Workbench preserved the saved draft because its language editor was unavailable.`;
  return `Problem: ${compactWords(objective, 20)} Solution: ${compactWords(draft, 70)} Context: Workbench shortened the saved draft automatically because its language editor was unavailable.`;
}

type FinalResponseOptions = { verbose?: boolean };

export async function editFinalResponse(
  draft: string,
  objective: string,
  optionsOrEdit: FinalResponseOptions | ((prompt: string) => Promise<string>) = {},
  suppliedEdit: (prompt: string) => Promise<string> = editFinalResponseWithSupervisor,
): Promise<string> {
  const options = typeof optionsOrEdit === 'function' ? {} : optionsOrEdit;
  const edit = typeof optionsOrEdit === 'function' ? optionsOrEdit : suppliedEdit;
  const verbose = options.verbose === true;
  try {
    const edited = (await edit(`VERBOSITY: ${verbose ? 'VERBOSE' : 'SHORT'}\n\nUser request or task:\n${objective.slice(0, 4_000)}\n\nAgent draft:\n${draft.slice(0, 16_000)}`)).trim();
    const violation = finalResponsePolicyViolation(edited, verbose);
    if (!violation) return edited;
    console.warn(`[final-response-policy] response editor returned an invalid result: ${violation}`);
  } catch (error) {
    console.warn(`[final-response-policy] response editor unavailable; using the saved draft: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fallbackFinalResponse(draft, objective, verbose);
}
