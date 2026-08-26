// Heuristic confidence scoring for reviewed diff blocks. There is no model
// confidence signal on a plain git/GitHub patch, so the score is derived from
// change shape: bigger and mixed edits are inherently riskier to skim past,
// and a few risk keywords call out lines worth a second look.
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
  confidence: number;
}

const RISK_PATTERN = /\b(TODO|FIXME|XXX|any)\b|@ts-ignore|debugger|console\.(log|error|warn)/i;

export function scoreDiffBlockConfidence(lines: DiffBlockLine[]): number {
  const additions = lines.filter((line) => line.kind === 'addition').length;
  const deletions = lines.filter((line) => line.kind === 'deletion').length;
  const changed = additions + deletions;
  let score = 85;
  score -= Math.min(45, (changed - 1) * 3);
  if (additions > 0 && deletions > 0) score -= 10;
  if (lines.some((line) => RISK_PATTERN.test(line.text))) score -= 20;
  return Math.max(5, Math.min(98, Math.round(score)));
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
    blocks.push({ key: line.key, lines: [line], confidence: 0 });
  }
  for (const block of blocks) {
    if (block.lines[0].kind === 'addition' || block.lines[0].kind === 'deletion') block.confidence = scoreDiffBlockConfidence(block.lines);
  }
  return blocks;
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
