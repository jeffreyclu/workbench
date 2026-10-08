import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { marked } from 'marked';

import {
  consolidationModelResponseSchema,
  consolidationModelVerdictSchema,
  type ConsolidationProposal,
  type ConsolidationProposalItem,
  type ConsolidationProvenance,
} from '../shared/contracts.js';
import { analyzeMemoryFile } from '../shared/memory-catalogue.js';
import { runAgentCommand, type CliAgent } from './agent-runner.js';
import type { WorkbenchDatabase } from './database.js';
import { defaultRecordLearningDirectories, findSecretPattern, indexedFiles, type RecordLearningDirectories } from './record-learning.js';
import type { ShortTermMemoryStore } from './short-term-memory.js';

export { getConsolidationProposal } from './consolidation-store.js';

/**
 * Builds a memory consolidation proposal. A cheap model suggests a verdict for
 * every candidate record; this module then validates each verdict in code and
 * drops (and logs) any it cannot prove safe, so nothing unvalidated is stored
 * or displayed. Accepting and applying a proposal is a separate step.
 */

export interface ConsolidationCandidate {
  /** Stable key the model echoes back; provenance itself is never taken from the model. */
  provenanceId: string;
  provenance: ConsolidationProvenance;
  title: string;
  text: string;
}

export interface ConsolidationInputs {
  database: WorkbenchDatabase;
  shortTermMemory: Pick<ShortTermMemoryStore, 'conversations'> | null;
  directories?: RecordLearningDirectories;
}

export interface ConsolidationCorpus {
  candidates: ConsolidationCandidate[];
  /** Indexed topic file name → entry ids it contains. Promote targets and citations resolve against this. */
  entries: Map<string, Set<number>>;
}

export interface ConsolidationDrop {
  provenanceId: string | null;
  reason: string;
}

export interface ConsolidationResult {
  items: ConsolidationProposalItem[];
  dropped: ConsolidationDrop[];
}

export type ConsolidationModel = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface BuildConsolidationOptions {
  model?: ConsolidationModel;
  agent?: CliAgent;
  log?: (message: string) => void;
  signal?: AbortSignal;
}

// The economy pass sees every numbered entry (450+ today), so existing entries
// get a short excerpt; new records keep enough text to judge.
const PROMPT_TEXT_LIMIT = 800;
const PROMPT_ENTRY_TEXT_LIMIT = 240;

export function collectConsolidationCandidates({ database, shortTermMemory, directories = defaultRecordLearningDirectories() }: ConsolidationInputs): ConsolidationCorpus {
  const candidates: ConsolidationCandidate[] = [];
  const entries = new Map<string, Set<number>>();

  for (const [file, catalogue] of [...indexedFiles(directories).entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const analysis = analyzeMemoryFile(readFileSync(join(catalogue.directory, file), 'utf8'));
    entries.set(file, new Set(analysis.entries.map((entry) => entry.id)));
    for (const entry of analysis.entries) {
      const id = `${file}#${entry.id}`;
      candidates.push({ provenanceId: `memory_entry:${id}`, provenance: { source: 'memory_entry', id }, title: entry.title, text: entry.body });
    }
  }

  for (const conversation of shortTermMemory?.conversations() ?? []) {
    candidates.push({ provenanceId: `short_term_memory:${conversation.id}`, provenance: { source: 'short_term_memory', id: conversation.id }, title: conversation.title, text: conversation.body });
  }

  const pinned = database.prepare(`SELECT m.id, m.author, m.body FROM shared_messages m
    LEFT JOIN shared_conversations c ON c.id = m.conversation_id
    WHERE m.pinned = 1 AND trim(m.body) != '' AND (c.id IS NULL OR c.deleted_at IS NULL)
    ORDER BY m.created_at`).all() as Array<{ id: string; author: string; body: string }>;
  for (const message of pinned) {
    candidates.push({ provenanceId: `pinned_message:${message.id}`, provenance: { source: 'pinned_message', id: message.id }, title: `Pinned message from ${message.author}`, text: message.body });
  }

  const handoffs = database.prepare(`SELECT agent_run_id, learnings_json FROM agent_run_review_handoffs
    WHERE learnings_json != '[]' ORDER BY created_at`).all() as Array<{ agent_run_id: string; learnings_json: string }>;
  for (const handoff of handoffs) {
    for (const [learningIndex, learning] of (JSON.parse(handoff.learnings_json) as unknown[]).entries()) {
      if (typeof learning !== 'string' || !learning.trim()) continue;
      candidates.push({
        provenanceId: `run_learning:${handoff.agent_run_id}#${learningIndex}`,
        provenance: { source: 'run_learning', id: handoff.agent_run_id, learningIndex },
        title: `Run learning ${learningIndex + 1}`,
        text: learning.trim(),
      });
    }
  }

  return { candidates, entries };
}

export function consolidationPrompt(corpus: ConsolidationCorpus): string {
  const records = corpus.candidates.map((candidate) => {
    const limit = candidate.provenance.source === 'memory_entry' ? PROMPT_ENTRY_TEXT_LIMIT : PROMPT_TEXT_LIMIT;
    return JSON.stringify({
      provenanceId: candidate.provenanceId,
      source: candidate.provenance.source,
      title: candidate.title,
      text: candidate.text.length <= limit ? candidate.text : `${candidate.text.slice(0, limit - 1)}…`,
    });
  });
  return `You are consolidating Workbench memory. Give one verdict for each record below.

Verdicts:
- "promote": a reusable, durable finding that is not yet in a memory file. Give "targetFile" (one of the indexed files), a short "title", and the entry "text". Do not put markdown headings in the text.
- "keep": leave the record as it is. If an existing memory entry already says the same thing, set "coveredBy" to that entry's citation, written exactly as [file.md#N].
- "archive_then_remove": stale or one-off run state with no lasting value. Give a short "reason". Never choose this for a record that cites source code (file:line), an upstream issue, or version-specific behaviour.

Indexed files: ${[...corpus.entries.keys()].join(', ') || 'none'}
Existing entries are records whose source is "memory_entry"; their citation is [file.md#N] where the provenanceId ends in file.md#N.

Records (one JSON object per line):
${records.join('\n') || 'none'}

Reply with JSON only, no other text:
{"items":[{"provenanceId":"…","verdict":"promote","targetFile":"…","title":"…","text":"…"},{"provenanceId":"…","verdict":"keep","coveredBy":"[file.md#N]"},{"provenanceId":"…","verdict":"archive_then_remove","reason":"…"}]}`;
}

function parseModelItems(output: string): unknown[] {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Consolidation model returned no JSON object.');
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error('Consolidation model returned malformed JSON.');
  }
  const parsed = consolidationModelResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Consolidation model reply has no "items" array.');
  return parsed.data.items;
}

/** Parses exactly one `[file.md#N]` citation and confirms that entry exists. */
function resolveCitation(value: string, entries: ConsolidationCorpus['entries']): { file: string; entry: number } | null {
  const citations = analyzeMemoryFile(value).citations;
  if (citations.length !== 1 || value.trim() !== `[${citations[0].file}#${citations[0].entry}]`) return null;
  return entries.get(citations[0].file)?.has(citations[0].entry) ? citations[0] : null;
}

function unresolvedCitation(text: string, entries: ConsolidationCorpus['entries']): string | null {
  const missing = analyzeMemoryFile(text).citations.find((citation) => !entries.get(citation.file)?.has(citation.entry));
  return missing ? `[${missing.file}#${missing.entry}]` : null;
}

export function validateConsolidationVerdicts(rawItems: unknown[], corpus: ConsolidationCorpus): ConsolidationResult {
  const byId = new Map(corpus.candidates.map((candidate) => [candidate.provenanceId, candidate]));
  const seen = new Set<string>();
  const items: ConsolidationProposalItem[] = [];
  const dropped: ConsolidationDrop[] = [];
  const drop = (provenanceId: string | null, reason: string) => { dropped.push({ provenanceId, reason }); };

  for (const raw of rawItems) {
    const parsed = consolidationModelVerdictSchema.safeParse(raw);
    const rawId = typeof (raw as { provenanceId?: unknown } | null)?.provenanceId === 'string' ? (raw as { provenanceId: string }).provenanceId : null;
    if (!parsed.success) { drop(rawId, 'malformed verdict'); continue; }
    const verdict = parsed.data;
    const candidate = byId.get(verdict.provenanceId);
    if (!candidate) { drop(verdict.provenanceId, 'unknown provenance id'); continue; }
    if (seen.has(candidate.provenanceId)) { drop(candidate.provenanceId, 'duplicate verdict for the same record'); continue; }
    const base = { provenanceId: candidate.provenanceId, provenance: candidate.provenance };

    if (verdict.verdict === 'keep') {
      let coveredBy: string | null = null;
      if (verdict.coveredBy) {
        const citation = resolveCitation(verdict.coveredBy, corpus.entries);
        if (!citation) { drop(candidate.provenanceId, `"already covered" citation ${verdict.coveredBy} does not resolve to an existing entry`); continue; }
        coveredBy = `[${citation.file}#${citation.entry}]`;
        if (candidate.provenance.source === 'memory_entry' && candidate.provenance.id === `${citation.file}#${citation.entry}`) {
          drop(candidate.provenanceId, `"already covered" citation ${coveredBy} cites the record itself`);
          continue;
        }
      }
      seen.add(candidate.provenanceId);
      items.push({ ...base, verdict: 'keep', coveredBy });
      continue;
    }

    if (verdict.verdict === 'promote') {
      if (!corpus.entries.has(verdict.targetFile)) { drop(candidate.provenanceId, `promote target ${verdict.targetFile} is not an indexed memory file`); continue; }
      const leaked = findSecretPattern(`${verdict.title}\n${verdict.text}`);
      if (leaked) { drop(candidate.provenanceId, `promote text looks like it contains a secret (${leaked})`); continue; }
      const analysis = analyzeMemoryFile(verdict.text);
      if (analysis.entries.length || analysis.hasUnnumberedHeading) { drop(candidate.provenanceId, 'promote text contains a markdown heading'); continue; }
      const badCitation = unresolvedCitation(verdict.text, corpus.entries);
      if (badCitation) { drop(candidate.provenanceId, `promote text cites ${badCitation}, which does not resolve to an existing entry`); continue; }
      seen.add(candidate.provenanceId);
      items.push({ ...base, verdict: 'promote', targetFile: verdict.targetFile, title: verdict.title, text: verdict.text });
      continue;
    }

    // Judge the record's own content, never its source category.
    const claim = sourceLevelClaim(candidate.text);
    if (claim) { drop(candidate.provenanceId, `archive-then-remove refused: the record makes a source-level claim (${claim})`); continue; }
    seen.add(candidate.provenanceId);
    items.push({ ...base, verdict: 'archive_then_remove', reason: verdict.reason });
  }
  return { items, dropped };
}

export async function buildConsolidationProposal(inputs: ConsolidationInputs, options: BuildConsolidationOptions = {}): Promise<ConsolidationResult> {
  const agent = options.agent ?? 'claude';
  const model = options.model ?? ((prompt, signal) => runAgentCommand(agent, process.cwd(), prompt, undefined, signal, 'economy', 'analysis'));
  const log = options.log ?? ((message: string) => console.warn(`[consolidation] ${message}`));
  const corpus = collectConsolidationCandidates(inputs);
  if (!corpus.candidates.length) return { items: [], dropped: [] };
  const result = validateConsolidationVerdicts(parseModelItems(await model(consolidationPrompt(corpus), options.signal)), corpus);
  for (const drop of result.dropped) log(`Dropped verdict for ${drop.provenanceId ?? 'an unidentified record'}: ${drop.reason}.`);
  return result;
}

/** Stores a pending proposal and supersedes any earlier pending one. */
export function saveConsolidationProposal(database: WorkbenchDatabase, items: ConsolidationProposalItem[]): ConsolidationProposal {
  const proposal: ConsolidationProposal = { id: randomUUID(), status: 'pending', items, applyResults: null, createdAt: new Date().toISOString(), resolvedAt: null };
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.prepare("UPDATE consolidation_proposals SET status = 'superseded', resolved_at = ? WHERE status = 'pending'").run(proposal.createdAt);
    database.prepare("INSERT INTO consolidation_proposals (id, status, items_json, created_at) VALUES (?, 'pending', ?, ?)")
      .run(proposal.id, JSON.stringify(items), proposal.createdAt);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return proposal;
}

// Source-level claim detection. The record is parsed as markdown and each link
// and word is classified structurally; there is no pattern matching over text.

function isDigits(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= '0' && character <= '9');
}

const WRAPPING = new Set(['(', ')', '[', ']', '{', '}', '<', '>', ',', ';', ':', '.', '!', '?', '"', "'", '`', '*', '_']);

function trimWrapping(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && WRAPPING.has(value[start])) start += 1;
  while (end > start && WRAPPING.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function words(text: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const character of text) {
    if (character.trim() === '') {
      if (current) result.push(current);
      current = '';
    } else current += character;
  }
  if (current) result.push(current);
  return result.map(trimWrapping).filter(Boolean);
}

function upstreamUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const segments = url.pathname.split('/');
  return segments.some((segment, index) => ['issues', 'pull', 'pulls', 'merge_requests'].includes(segment) && isDigits(segments[index + 1] ?? ''));
}

function isFileName(value: string): boolean {
  const extension = extname(value).slice(1);
  return extension.length > 0 && [...extension].some((character) => character.toLowerCase() !== character.toUpperCase());
}

function isVersion(value: string, explicit: boolean): boolean {
  const segments = value.split('.');
  return segments.length >= 2 && segments.every(isDigits) && (explicit || segments.length >= 3);
}

function classifyWord(word: string): string | null {
  if (word.startsWith('http://') || word.startsWith('https://')) return upstreamUrl(word) ? 'upstream issue' : null;
  const hash = word.lastIndexOf('#');
  if (hash > 0) {
    const before = word.slice(0, hash);
    const after = word.slice(hash + 1);
    if (before.includes('/') && isDigits(after) && !isFileName(before)) return 'upstream issue';
    if (isFileName(before) && after.startsWith('L') && isDigits(after.slice(1))) return 'file:line';
  }
  const parts = word.split(':');
  if (parts.length >= 2 && isFileName(parts[0]) && isDigits(parts[1])) return 'file:line';
  const at = word.lastIndexOf('@');
  if (at > 0 && isVersion(word.slice(at + 1).replace('^', '').replace('~', ''), true)) return 'version-specific behaviour';
  if ((word.startsWith('v') || word.startsWith('V')) && isVersion(word.slice(1), true)) return 'version-specific behaviour';
  if (isVersion(word, false)) return 'version-specific behaviour';
  return null;
}

/** Names the first source-level claim in a record (file:line, upstream issue, version-specific behaviour), or null. */
export function sourceLevelClaim(text: string): string | null {
  let claim: string | null = null;
  marked.walkTokens(marked.lexer(text), (token) => {
    if (claim) return;
    if (token.type === 'link') {
      if (upstreamUrl(token.href)) claim = 'upstream issue';
      return;
    }
    if ((token.type === 'codespan' || token.type === 'text') && !('tokens' in token && token.tokens?.length)) {
      for (const word of words(token.text)) {
        claim = classifyWord(word);
        if (claim) return;
      }
    }
  });
  return claim;
}
