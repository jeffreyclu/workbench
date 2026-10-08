import { REVIEW_PASSES, escapedAttacks, type AdversarialLedger, type ReviewLedger } from './review-harness.js';

/**
 * The review result Jeffrey reads, rendered from two correctness ledgers.
 *
 * Nothing here reconciles. Where the reviewers disagree, the disagreement is
 * the first thing shown, one line each, for Jeffrey to adjudicate. Then at
 * most five blocking findings, one line each. Everything else moves inside a
 * counted fold: nothing is deleted. The five-pass ledger underneath is not
 * touched; this is presentation only.
 */
export const MAX_VISIBLE_BLOCKING = 5;

/** `:::fold <summary>` … `:::`. Folded text does not count toward the visible word cap. */
export const FOLD_PATTERN = /^:::fold[ \t]+(.+?)[ \t]*\r?\n([\s\S]*?)\r?\n:::[ \t]*$/gm;

export function stripFolds(text: string): string {
  return text.replace(FOLD_PATTERN, '');
}

type LedgerFinding = ReviewLedger['passes'][number]['findings'][number];
interface Entry { pass: number; reviewer: string; finding: LedgerFinding }

function fold(summary: string, lines: string[]): string {
  return `:::fold ${summary}\n${lines.join('\n')}\n:::`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A blocking finding earns a headline only with a stateable consequence. */
const isHeadline = (entry: Entry) => entry.finding.severity === 'blocking' && Boolean(entry.finding.consequence);

function headlineLine(entry: Entry): string {
  const { finding } = entry;
  const where = finding.location ?? `D${finding.decision}`;
  const fix = finding.fix ?? 'see the full finding';
  return `- ${where} — ${finding.consequence!.replace(/[.\s]+$/, '')}. Fix: ${fix.replace(/[.\s]+$/, '')}.`;
}

function detailLine(entry: Entry): string {
  const { finding } = entry;
  const label = finding.severity === 'blocking' ? 'Blocking' : 'Non-blocking';
  return `${label}: ${finding.finding} (Pass ${entry.pass}, D${finding.decision}, ${entry.reviewer})`;
}

export function renderReviewSynthesis(input: {
  reviewers: [string, string];
  ledgers: [ReviewLedger, ReviewLedger];
  adversarial?: AdversarialLedger | null;
}): string {
  const entries: Entry[][] = input.ledgers.map((ledger, index) => ledger.passes.flatMap((pass) => pass.findings.map((finding) => ({ pass: pass.pass, reviewer: input.reviewers[index], finding }))));
  const blockingKeys = entries.map((list) => new Set(list.filter((entry) => entry.finding.severity === 'blocking').map((entry) => `${entry.pass}:${entry.finding.decision}`)));

  const disagreements: string[] = [];
  const agreed = new Map<string, Entry>();
  const rest: Entry[] = [];
  entries.forEach((list, index) => {
    const other = blockingKeys[1 - index];
    for (const entry of list) {
      const key = `${entry.pass}:${entry.finding.decision}`;
      if (!isHeadline(entry)) { rest.push(entry); continue; }
      if (!other.has(key)) {
        const where = entry.finding.location ?? `D${entry.finding.decision}`;
        disagreements.push(`- ${where} (Pass ${entry.pass}): ${entry.reviewer} says blocking — ${entry.finding.consequence!.replace(/[.\s]+$/, '')}. ${input.reviewers[1 - index]} found nothing blocking there. Adjudicate.`);
        rest.push(entry);
        continue;
      }
      const identity = `${key}:${entry.finding.location ?? ''}:${entry.finding.consequence}`;
      if (agreed.has(identity)) rest.push(entry);
      else agreed.set(identity, entry);
    }
  });

  const blocking = [...agreed.values()].sort((a, b) => a.pass - b.pass || a.finding.decision - b.finding.decision);
  const visible = blocking.slice(0, MAX_VISIBLE_BLOCKING);
  const hidden = blocking.slice(MAX_VISIBLE_BLOCKING);

  const out: string[] = [];
  out.push(disagreements.length ? `Reviewers disagree (${disagreements.length}):\n${disagreements.join('\n')}` : 'Reviewers disagree: none.');
  out.push(blocking.length ? `Blocking (${blocking.length}):\n${visible.map(headlineLine).join('\n')}` : 'Blocking: none.');
  if (hidden.length) out.push(fold(plural(hidden.length, 'further blocking finding'), hidden.map(headlineLine)));

  // Headline blocking findings are shown above (or as disagreements); every
  // finding, headline or not, is also listed under its pass in Pass coverage.
  const nonBlocking = rest.filter((entry) => entry.finding.severity === 'non-blocking' || !isHeadline(entry));
  if (nonBlocking.length) out.push(fold(`${nonBlocking.length} non-blocking`, nonBlocking.map((entry) => `- ${detailLine(entry)}`)));

  if (input.adversarial) {
    const escaped = escapedAttacks(input.adversarial);
    out.push(fold(`Adversarial: ${plural(input.adversarial.attacks.length, 'attack')}, ${escaped.length} escaped`, input.adversarial.attacks.map((attack) => `- ${attack.result === 'escaped' ? 'Escaped' : 'Held'}: ${attack.targetClaim}. Attack: ${attack.method} Evidence: ${attack.evidence}`)));
  }

  const coverage = REVIEW_PASSES.flatMap((pass) => {
    const all = entries.flat().filter((entry) => entry.pass === pass.number);
    return [`### ${pass.heading}`, ...(all.length ? all.map(detailLine) : ['No material issues.'])];
  });
  out.push(fold('Pass coverage', coverage));
  return out.join('\n\n');
}
