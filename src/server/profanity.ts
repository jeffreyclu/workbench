import type { CurseInsight } from '../shared/contracts.js';
import { localCalendarDate } from '../shared/due-date.js';
import { MASKED_PROFANITY_PATTERNS, PROFANITY_TERMS } from './profanity-terms.js';

const escapedTerms = [...PROFANITY_TERMS]
  .sort((left, right) => right.length - left.length || left.localeCompare(right))
  .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// Unicode boundaries prevent partial matches (for example, "assassin") while
// still allowing punctuation and multi-word phrases.
const profanityPattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${escapedTerms.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
const maskedProfanityPatterns = MASKED_PROFANITY_PATTERNS.map(({ pattern, term }) => ({
  term,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, 'giu'),
}));

// Keep typo matching narrow and explainable. A generic fuzzy match across the
// full list would turn ordinary words into false positives; these are the
// conversational terms most likely to be misspelled in a heated message.
const TYPO_BASE_TERMS = ['fuck', 'fucking', 'fucker', 'shit', 'shitty', 'cunt', 'bitch', 'asshole', 'bastard', 'dick', 'cock', 'prick', 'twat', 'wank'] as const;
const wordPattern = /[\p{L}\p{N}_]+/gu;

function normalizeLeetspeak(word: string): string {
  return word.toLowerCase().replaceAll('0', 'o').replaceAll('1', 'i').replaceAll('3', 'e').replaceAll('4', 'a').replaceAll('$', 's').replaceAll('@', 'a');
}

function hasSingleInsertionDeletionOrTranspose(word: string, target: string): boolean {
  if (word.length === target.length) {
    const mismatch = [...word].findIndex((character, index) => character !== target[index]);
    return mismatch >= 0
      && mismatch < word.length - 1
      && word[mismatch] === target[mismatch + 1]
      && word[mismatch + 1] === target[mismatch]
      && word.slice(mismatch + 2) === target.slice(mismatch + 2);
  }
  if (Math.abs(word.length - target.length) !== 1) return false;
  const [shorter, longer] = word.length < target.length ? [word, target] : [target, word];
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;
  return shorter.slice(index) === longer.slice(index + 1);
}

function typoMatches(body: string): string[] {
  return (body.match(wordPattern) ?? []).flatMap((rawWord) => {
    const word = normalizeLeetspeak(rawWord);
    const target = TYPO_BASE_TERMS.find((candidate) =>
      (word !== rawWord.toLowerCase() && word === candidate) || hasSingleInsertionDeletionOrTranspose(word, candidate));
    return target ? [canonicalTerm(target)] : [];
  });
}

function canonicalTerm(match: string): string {
  const word = match.toLowerCase();
  if (word.startsWith('fuck')) return 'fuck';
  if (word.startsWith('shit')) return 'shit';
  if (word.startsWith('damn')) return 'damn';
  if (word.startsWith('ass')) return 'ass';
  if (word.startsWith('bitch')) return 'bitch';
  if (word.startsWith('bastard')) return 'bastard';
  return word;
}

/** Counts whole-word profanity in Jeffrey's submitted messages without storing a second copy of the source text. */
export function summarizeCursing(messages: Array<{ body: string; createdAt: string }>): CurseInsight {
  const byTerm = new Map<string, number>();
  const byDay = new Map<string, number>();
  let total = 0;
  let messagesWithCurses = 0;

  for (const message of messages) {
    const matches = [
      ...(message.body.match(profanityPattern) ?? []).map(canonicalTerm),
      ...maskedProfanityPatterns.flatMap(({ pattern, term }) => (message.body.match(pattern) ?? []).map(() => term)),
      ...typoMatches(message.body),
    ];
    if (matches.length === 0) continue;
    messagesWithCurses += 1;
    total += matches.length;
    const day = localCalendarDate(Date.parse(message.createdAt));
    byDay.set(day, (byDay.get(day) ?? 0) + matches.length);
    for (const term of matches) {
      byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
    }
  }

  let angriestDay: CurseInsight['angriestDay'] = null;
  for (const [day, count] of byDay.entries()) {
    if (!angriestDay || count > angriestDay.count || (count === angriestDay.count && day < angriestDay.day)) {
      angriestDay = { day, count };
    }
  }

  return {
    total,
    angriestDay,
    messagesAnalyzed: messages.length,
    messagesWithCurses,
    instancesPer100Messages: messages.length === 0 ? 0 : total / messages.length * 100,
    byTerm: [...byTerm.entries()]
      .map(([term, count]) => ({ term, count }))
      .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term)),
    byDay: [...byDay.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((left, right) => left.day.localeCompare(right.day)),
  };
}
