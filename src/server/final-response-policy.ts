import { editFinalResponseWithSupervisor } from './turn-grounding-ai.js';

export const FINAL_RESPONSE_CONTRACT = `Final response: Workbench will reject and rewrite the draft before delivery unless it is one plain-English paragraph of at most 120 words in exactly this order: Problem: ... Solution: ... Context: ... Never use a list, heading, blank line, preamble, repeated conclusion, or unexplained specialist shorthand. Keep exact commands, paths, URLs, error text, verification, and blockers when they matter.`;

const LABELS = /^Problem:\s+.+\s+Solution:\s+.+\s+Context:\s+.+$/s;

export function finalResponsePolicyViolation(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return 'The response is empty.';
  if (/\r?\n/.test(trimmed)) return 'The response uses more than one line or paragraph.';
  if (!LABELS.test(trimmed)) return 'The response does not use Problem, Solution, Context in that order.';
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

export function fallbackFinalResponse(draft: string, objective: string): string {
  return `Problem: ${compactWords(objective, 20)} Solution: ${compactWords(draft, 70)} Context: Workbench shortened the saved draft automatically because its language editor was unavailable.`;
}

export async function editFinalResponse(
  draft: string,
  objective: string,
  edit: (prompt: string) => Promise<string> = editFinalResponseWithSupervisor,
): Promise<string> {
  try {
    const edited = (await edit(`User request or task:\n${objective.slice(0, 4_000)}\n\nAgent draft:\n${draft.slice(0, 16_000)}`)).trim();
    const violation = finalResponsePolicyViolation(edited);
    if (!violation) return edited;
    console.warn(`[final-response-policy] response editor returned an invalid result: ${violation}`);
  } catch (error) {
    console.warn(`[final-response-policy] response editor unavailable; using the saved draft: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fallbackFinalResponse(draft, objective);
}
