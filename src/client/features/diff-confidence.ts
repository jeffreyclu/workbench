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
  risk: number;
  reasoning: string;
}

export interface DiffFollowUpReference {
  filePath: string;
  lines: DiffBlockLine[];
  assessment: DiffConfidenceAssessment;
}

/** Produces agent-readable context without inventing a file attachment or a new persistence layer. */
export function formatDiffFollowUpReference({ filePath, lines, assessment }: DiffFollowUpReference): string {
  const lineNumbers = lines.map((line) => line.newLine ?? line.oldLine).filter((line): line is number => line !== null);
  const location = lineNumbers.length ? `:${Math.min(...lineNumbers)}${Math.max(...lineNumbers) === Math.min(...lineNumbers) ? '' : `-${Math.max(...lineNumbers)}`}` : '';
  const patch = lines.map((line) => line.text).join('\n');
  return `Please follow up on this risk assessment.\n\n**${filePath}${location}** · AI risk: ${assessment.risk}/100\n\n> ${assessment.reasoning}\n\n\`\`\`diff\n${patch}\n\`\`\``;
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

export function confidenceTone(risk: number) {
  const low = { r: 108, g: 191, b: 110 };
  const high = { r: 217, g: 90, b: 90 };
  const t = Math.max(0, Math.min(1, risk / 100));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(low.r, high.r)}, ${mix(low.g, high.g)}, ${mix(low.b, high.b)})`;
}

/** Trivial/low risk should recede into the background; high risk should draw the eye. */
export function confidenceProminence(risk: number): { opacity: number; fontWeight: number } {
  const t = Math.max(0, Math.min(1, risk / 100));
  return { opacity: Math.round((0.55 + t * 0.45) * 100) / 100, fontWeight: t > 0.3 ? 700 : 500 };
}
