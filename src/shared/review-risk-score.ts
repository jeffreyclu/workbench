/** The strict two-line score contract shared by the scorer, router, and UI. */
export interface AiRiskScore {
  score: number;
  reason: string;
}

export function parseAiRiskScore(answer: string | undefined | null): AiRiskScore | null {
  if (!answer) return null;
  const match = /^\s*SCORE:\s*(\d{1,3})\s*$/im.exec(answer);
  if (!match) return null;
  const score = Number(match[1]);
  if (score > 100) return null;
  return { score, reason: answer.slice(match.index + match[0].length).trim() };
}

/** A score this low has already answered the prioritization question: the
 * change still receives a delegated read, but it does not consume Jeffrey's
 * review queue. */
export const LOW_RISK_DELEGATION_MAX = 20;
