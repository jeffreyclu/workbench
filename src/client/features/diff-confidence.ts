// Grouping and presentation for AI-assessed diff blocks. The confidence score
// itself is produced by the model server-side (`POST /api/diff-confidence`);
// this module only decides what counts as one logical block and how a score
// maps to colour and prominence — low confidence is loud, high is quiet.
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

export function confidenceTone(confidence: number) {
  const low = { r: 217, g: 90, b: 90 };
  const high = { r: 108, g: 191, b: 110 };
  const t = Math.max(0, Math.min(1, confidence / 100));
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(low.r, high.r)}, ${mix(low.g, high.g)}, ${mix(low.b, high.b)})`;
}

/** Lower confidence should draw the eye; higher confidence should recede. */
export function confidenceProminence(confidence: number): { opacity: number; fontWeight: number } {
  const t = Math.max(0, Math.min(1, confidence / 100));
  return { opacity: Math.round((0.55 + (1 - t) * 0.45) * 100) / 100, fontWeight: t > 0.7 ? 500 : 700 };
}
