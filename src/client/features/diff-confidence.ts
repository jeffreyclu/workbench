// Grouping and presentation for AI-assessed diff blocks. The risk score itself
// is produced by the model server-side (`POST /api/diff-confidence`); this
// module only decides what counts as one logical block and how a score maps
// to colour and prominence — low risk recedes, high risk is loud.
export interface DiffBlockLine {
  key: string;
  kind: 'context' | 'addition' | 'deletion' | 'header';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffBlock {
  key: string;
  lines: DiffBlockLine[];
}

export interface DiffConfidenceAssessment {
  /** Null means the scorer was unavailable; it is deliberately not a score. */
  risk: number | null;
  reasoning: string;
}

/** One changed block of a rendered patch, as followed up from the GitHub diff. */
export interface DiffBlockFollowUpReference {
  filePath: string;
  lines: DiffBlockLine[];
  assessment: DiffConfidenceAssessment;
}

/** One review-queue decision, carrying everything the agent needs to act on it:
 * what the change does, which hunks it spans, why it is risky, and the patch.
 * Deliberately holds plain fields so this module stays independent of the
 * review feature's own model. */
export interface DiffDecisionFollowUpReference {
  ordinal: number;
  behavior: string;
  /** Null while the scorer has not produced an assessment for this decision. */
  assessment: DiffConfidenceAssessment | null;
  state: string;
  hunks: Array<{ filePath: string; location: string; lines: string[] }>;
}

export type DiffFollowUpReference = DiffBlockFollowUpReference | DiffDecisionFollowUpReference;

/** A follow-up quotes the patch so the agent reads the same lines the reviewer
 * did. A whole-file rewrite would otherwise bury the composer, so each hunk is
 * bounded and the omission is stated rather than silently truncated. */
const FOLLOW_UP_HUNK_LINE_LIMIT = 120;

function boundFollowUpPatch(lines: string[]): string {
  if (lines.length <= FOLLOW_UP_HUNK_LINE_LIMIT) return lines.join('\n');
  const head = lines.slice(0, FOLLOW_UP_HUNK_LINE_LIMIT - 20);
  const tail = lines.slice(lines.length - 19);
  return [...head, `… ${lines.length - head.length - tail.length} more lines omitted …`, ...tail].join('\n');
}

/** Produces agent-readable context without inventing a file attachment or a new persistence layer. */
export function formatDiffFollowUpReference(reference: DiffFollowUpReference): string {
  return 'lines' in reference ? formatBlockFollowUp(reference) : formatDecisionFollowUp(reference);
}

function formatBlockFollowUp({ filePath, lines, assessment }: DiffBlockFollowUpReference): string {
  const lineNumbers = lines.map((line) => line.newLine ?? line.oldLine).filter((line): line is number => line !== null);
  const location = lineNumbers.length ? `:${Math.min(...lineNumbers)}${Math.max(...lineNumbers) === Math.min(...lineNumbers) ? '' : `-${Math.max(...lineNumbers)}`}` : '';
  const patch = lines.map((line) => line.text).join('\n');
  const risk = assessment.risk === null ? 'unavailable' : `${assessment.risk}/100`;
  return `Please follow up on this risk assessment.\n\n**${filePath}${location}** · AI risk: ${risk}\n\n> ${assessment.reasoning}\n\n\`\`\`diff\n${patch}\n\`\`\``;
}

function formatDecisionFollowUp({ ordinal, behavior, assessment, state, hunks }: DiffDecisionFollowUpReference): string {
  const risk = !assessment ? 'not scored yet' : assessment.risk === null ? 'unavailable' : `${assessment.risk}/100`;
  const facts = [`AI risk: ${risk}`, `Review state: ${state}`];
  const sections = hunks.map((hunk) => `**${hunk.filePath}** · ${hunk.location}\n\n\`\`\`diff\n${boundFollowUpPatch(hunk.lines)}\n\`\`\``);
  return [
    `Please follow up on review decision ${ordinal}.`,
    `**${behavior}**`,
    facts.join(' · '),
    ...(assessment?.reasoning ? [`> ${assessment.reasoning}`] : []),
    ...sections,
  ].join('\n\n');
}

/** Group parsed diff lines into logical blocks: each contiguous run of changed
 * lines is one block; each context/header line stands alone. */
export function groupDiffBlocks(lines: DiffBlockLine[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  for (const line of lines) {
    const previous = blocks[blocks.length - 1];
    const isChange = line.kind === 'addition' || line.kind === 'deletion';
    if (isChange && previous && previous.lines[0].kind !== 'header' && previous.lines.every((entry) => entry.kind === 'addition' || entry.kind === 'deletion')) {
      previous.lines.push(line);
      continue;
    }
    blocks.push({ key: line.key, lines: [line] });
  }
  return blocks;
}

/** Only blocks that actually change code are worth an assessment: context and
 * hunk headers carry no risk and would waste model tokens. */
export function isChangedBlock(block: DiffBlock): boolean {
  return block.lines.some((line) => line.kind === 'addition' || line.kind === 'deletion');
}

export function confidenceTone(risk: number | null) {
  if (risk === null) return 'var(--text-muted, #888780)';
  const low = { r: 108, g: 191, b: 110 };
  const high = { r: 217, g: 90, b: 90 };
  const t = Math.max(0, Math.min(1, risk / 100));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(low.r, high.r)}, ${mix(low.g, high.g)}, ${mix(low.b, high.b)})`;
}

/** Trivial/low risk should recede into the background; high risk should draw the eye. */
export function confidenceProminence(risk: number | null): { opacity: number; fontWeight: number } {
  if (risk === null) return { opacity: 0.72, fontWeight: 500 };
  const t = Math.max(0, Math.min(1, risk / 100));
  return { opacity: Math.round((0.55 + t * 0.45) * 100) / 100, fontWeight: t > 0.3 ? 700 : 500 };
}

// `diffConfidenceRequestSchema` caps a scoring request at 200 lines of 4,000
// characters per block under a 2,000-character key. A new file, a large
// refactor hunk, or a cross-file decision that groups dozens of hunks exceeds
// those limits and the server rejects that request outright — which is why
// whole files stayed unscored while their smaller siblings got a score.
const MAX_BLOCK_LINES = 200;
const MAX_LINE_LENGTH = 4_000;
const MAX_KEY_LENGTH = 2_000;
const TAIL_LINES = 60;

function clampLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;
}

/** Keeps the head and tail of an oversized block and says what was dropped, so
 * the model still scores the change instead of the request failing. */
function condenseLines(lines: string[]): string[] {
  if (!lines.length) return ['(no changed lines)'];
  if (lines.length <= MAX_BLOCK_LINES) return lines.map(clampLine);
  const head = lines.slice(0, MAX_BLOCK_LINES - TAIL_LINES - 1).map(clampLine);
  const tail = lines.slice(-TAIL_LINES).map(clampLine);
  return [...head, `… ${lines.length - head.length - tail.length} more lines omitted …`, ...tail];
}

/** Rewrites blocks into a shape the request contract always accepts. An
 * over-long key is replaced by a positional stand-in, so callers map the
 * response back through `sourceKeyByRequestKey` instead of the sent key. */
export function boundConfidenceRequestBlocks(blocks: Array<{ key: string; lines: string[] }>): {
  requests: Array<{ key: string; lines: string[] }>;
  sourceKeyByRequestKey: Record<string, string>;
} {
  const sourceKeyByRequestKey: Record<string, string> = {};
  const requests = blocks.map((block, index) => {
    const key = block.key.length <= MAX_KEY_LENGTH ? block.key : `block:${index}`;
    sourceKeyByRequestKey[key] = block.key;
    return { key, lines: condenseLines(block.lines) };
  });
  return { requests, sourceKeyByRequestKey };
}
