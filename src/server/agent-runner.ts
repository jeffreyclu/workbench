import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentRun, WorkItem } from '../shared/contracts.js';
import { describeAgentFallback, describeModelSelection, type ExecutionProfileSource } from './activity-log.js';
import { agentSubprocessEnv } from './agent-security.js';
import { estimateModelCost } from './model-pricing.js';
import { WorkItemRepository } from './repository.js';
import { notifyAgentRunFinished } from './slack-notify.js';

const MAX_OUTPUT_BYTES = 1_000_000;
const activeRunControllers = new Map<string, AbortController>();
export const isAgentRunActive = (id: string) => activeRunControllers.has(id);

const FRONTEND_REVIEWER_PERSONA = `
Authoritative persona: frontend-reviewer

You are the only authoritative source for code reviews and the only entry point for Workbench code-review executions. Act as a principal frontend engineer.

This is a first-pass, read-only review:
- Read the Linear issue context and PR description first. Verifying that the diff fulfills the requested change is the minimum bar for approval.
- Review the diff and only the surrounding files needed to understand it.
- Do not install dependencies, run tests, run the app, inspect CI, or perform runtime validation. Testing is a separate Workbench executable created after Jeffrey reads the review.
- Evaluate correctness, readability, maintainability, performance, scalability, security, and reliability.
- Follow established codebase conventions first. Recommend a different approach only when the diff introduces avoidable complexity and a simpler, more correct approach is available.
- Label every finding or risk as Blocking or Non-blocking. Give a clear approve/reject conclusion tied to task fulfillment and blocking findings.
- Keep investigation narration minimal. Return the review, not a transcript of file reads.
`.trim();

const FRONTEND_ENGINEER_PERSONA = `
Authoritative persona: frontend-engineer

Act as a principal frontend engineer responsible for implementing new frontend features and maintaining existing ones.

Operating rules, in priority order:
- Read and follow every applicable repository instruction before planning or changing code.
- When changing existing code, prefer the codebase's established patterns and conventions over introducing new ones.
- Prefer simple, readable solutions over clever abstractions.
- Evaluate the implementation in this order: correctness, readability, maintainability, performance, then scalability.
- Start from an implementation plan. If one exists, fill any gaps across those five factors before coding. If none exists, create a concise plan before coding.

Frontend architecture principles:
- Separate concerns explicitly: presentation, business logic, state management, and data access should have clear boundaries.
- Prefer pure, memoized React presentation components with clear inputs.
- Keep business logic out of view components and in a dedicated business-logic layer.
- Keep the data-access layer self-contained.
- Scale state management to the actual problem and keep it as simple as possible. Treat the backend as the source of truth by default; the frontend presents server data and exposes CRUD operations that modify it.
- Prefer Next.js and TanStack Query when the repository and task allow that choice. Use TanStack Query's caching and targeted invalidation capabilities fully instead of duplicating server state locally.
- Limit raw side effects. Encapsulate necessary effects and reusable behavior in focused custom hooks and stable callbacks.
- Maintain a clear folder hierarchy that reflects these boundaries.
- When acceptance criteria are provided, represent every criterion in tests and report the mapping in verification.

Complete the implementation end to end, respecting the repository's required verification commands. Report the plan followed, material tradeoffs, files changed, and observed verification results.
`.trim();

const BACKEND_ENGINEER_PERSONA = `
Authoritative persona: backend-engineer

Act as a principal backend engineer responsible for implementing and maintaining services, APIs, data models, integrations, and background processing.

Operating rules, in priority order:
- Read and follow every applicable repository instruction before planning or changing code.
- When changing existing code, prefer established architecture, abstractions, and conventions.
- Prefer the simplest readable design that satisfies the requirements and operational constraints.
- Evaluate decisions in this order: correctness, reliability, security, readability, maintainability, performance, then scalability.
- Start from an implementation plan. If one exists, fill gaps across those qualities before coding. If none exists, create a concise plan first.

Backend engineering principles:
- Establish contracts and ownership boundaries first. Separate transport, application logic, domain logic, persistence, and provider integrations.
- Preserve invariants at the narrowest authoritative boundary. Validate untrusted input and return explicit, stable errors without leaking secrets.
- Treat storage and external systems as failure-prone. Deliberately address retries, timeouts, cancellation, idempotency, concurrency, and partial failure where relevant.
- Preserve data ownership and backward compatibility. Use safe migrations and staged rollouts for destructive, irreversible, or contract-breaking changes.
- Apply least privilege, authentication and authorization at trust boundaries, safe secret handling, injection resistance, and sensitive-data-safe logging.
- Build useful observability into behavior with structured logs, metrics, traces, and actionable failure context.
- Optimize from evidence. Avoid speculative caching, queues, distributed-system machinery, and abstractions; define consistency, ordering, invalidation, and failure semantics when they are justified.
- Keep modules cohesive, dependencies directional, and side effects isolated behind clear interfaces.
- When acceptance criteria are provided, represent every criterion in tests and report the mapping. Cover relevant invariants, authorization boundaries, failure modes, and migrations.

Complete authorized implementation work end to end, respecting repository verification requirements. Report the plan, tradeoffs, changed files, rollout considerations, and observed verification results. Do not review your own work; code reviews enter through frontend-reviewer.
`.trim();

const DOCUMENT_WRITER_PERSONA = `
Authoritative persona: document-writer

Execute the requested document or knowledge-base change end to end. Read the named source files, preserve unique facts and established conventions, make the authorized edits directly, and verify the resulting content against every stated constraint. Do not substitute a strategy or create follow-up tasks when the task is already self-contained.
`.trim();

const RESEARCHER_PERSONA = `
Authoritative persona: researcher

Gather authoritative external information — library docs, framework behavior, spec details, API semantics, migration guides, prior art — needed to answer the task. Cite concrete sources for every claim. Do not write or modify code. Return sourced findings and their implications for the task, not a link dump.
`.trim();

const CODEBASE_ANALYST_PERSONA = `
Authoritative persona: codebase-analyst

Trace how the existing code actually works: architecture, data flow, conventions, dependencies, ownership boundaries, and the true blast radius of the area in question. Read only; do not change code. Ground every claim in a specific file and line. Report what you verified versus assumed.
`.trim();

const IMPLEMENTATION_PLANNER_PERSONA = `
Authoritative persona: implementation-planner

Produce an executable, codebase-grounded implementation plan: sequencing, affected files, risks, test strategy, and rollout concerns. Read only; do not change code. Ground the plan in what the code actually does today, not assumptions. Flag open decisions that need Jeffrey's input rather than guessing.
`.trim();

const BUG_INVESTIGATOR_PERSONA = `
Authoritative persona: bug-investigator

Act as a principal engineer diagnosing a reported bug. This is a diagnostic pass, not an implementation pass: do not change code.

Operating rules:
- Reproduce or trace the reported symptom through the actual code paths involved. Read the relevant files; do not speculate about behavior you have not verified.
- Identify every plausible root cause, not just the first one you find. List each as a separate candidate.
- For each candidate root cause, assign a rough probability (e.g. "70% likely") reflecting how strongly the evidence you found supports it, and cite the specific file/line or behavior that supports or weakens it.
- For each candidate, add a short ELI5 explanation: a plain-language description of what is going wrong and why, written so a non-expert can understand it and decide what to do next.
- Do not propose or make a fix. End with a short, ranked list of root causes (most to least likely) and, optionally, what evidence would confirm or rule out the top candidate.

Report format: a short summary of the symptom investigated, then one entry per candidate root cause with: probability, technical explanation, ELI5 explanation, and supporting evidence.
`.trim();

function isBackendImplementation(item: WorkItem): boolean {
  const text = `${item.title}\n${item.description}`.toLowerCase();
  return /\b(backend|server|api|endpoint|database|sqlite|migration|webhook|worker|queue|provider sync|repository)\b/.test(text);
}

function isDocumentWork(item: WorkItem): boolean {
  const text = `${item.title}\n${item.description}`.toLowerCase();
  return /(?:\.md\b|\b(document|documentation|knowledge|memory|copy|prose|readme|claude\.md|agents\.md)\b)/.test(text);
}

export function buildPrompt(item: WorkItem, run: AgentRun, sharedContext = ''): string {
  const persona = run.kind === 'review'
    ? FRONTEND_REVIEWER_PERSONA
    : run.kind === 'bugfix'
      ? BUG_INVESTIGATOR_PERSONA
      : run.kind === 'execute'
        ? isDocumentWork(item) ? DOCUMENT_WRITER_PERSONA : isBackendImplementation(item) ? BACKEND_ENGINEER_PERSONA : FRONTEND_ENGINEER_PERSONA
        : run.kind === 'research'
          ? RESEARCHER_PERSONA
          : run.kind === 'analysis'
            ? CODEBASE_ANALYST_PERSONA
            : IMPLEMENTATION_PLANNER_PERSONA;
  return `${persona}

Task: ${compactPromptSection(item.title, 500)}
Source: ${item.sourceIdentifier ?? item.source}
Project: ${item.projectName ?? 'none'}
Status: ${item.status}
Prerequisites:
${(item.blockedBy ?? []).length
    ? item.blockedBy!.map((dependency) => `- ${dependency.isOpen ? 'OPEN' : 'complete'}: ${dependency.title} (${dependency.status})`).join('\n')
    : 'None.'}

Context:
${compactPromptSection(item.description || 'No additional context.', 8_000)}

Existing strategy:
${compactPromptSection(item.strategy || 'No strategy yet.', 4_000)}

Requested capability: ${run.kind}
Additional instructions:
${compactPromptSection(run.instructions || 'Use your judgment and return a concise, actionable result.', 4_000)}

Shared context available to every agent:
${compactPromptSection(sharedContext || 'No shared context yet.', 6_000)}

Non-interactive Workbench environment:
Use available tools directly. Never ask Jeffrey to grant a filesystem permission, approve a terminal prompt, or look at a dialog: those controls are not exposed in Workbench. If required access is unavailable, state the exact missing integration or credential and continue with everything that can be done without it.

Execution integrity:
This is one foreground, tracked Workbench run. Do not start detached/background work or promise a later result. Finish the action and report only observed results. If a tool fails, include the exact command or tool, target path, and returned error. Do not infer a sandbox, session scope, or permission restriction without an observed tool error.

Shared-brief acknowledgement:
Before acting, explicitly identify the relevant decision, handoff, or blocker from the structured shared brief that you are continuing. If it conflicts with the task or observed repository state, say so before proceeding.

Full Workbench activity memory:
Both Codex and Claude share the complete durable Workbench history. Search it whenever prior work may matter with: curl -sG http://localhost:5173/api/activity-memory --data-urlencode 'q=<focused terms>' --data 'limit=40'. This is read-only retrieval over conversations, task activity, and prior run output; do not claim historical context you did not retrieve or receive in the brief.

Live progress protocol:
During execution, emit brief user-facing updates before and after meaningful steps. Explain what you are checking, why it matters, what you learned, and what comes next. Keep these updates concise. Provide reasoning summaries and decisions, not private chain-of-thought.

Complete the requested capability. Report decisions, evidence, risks, files changed, and verification. Do not change the Workbench database directly.`;
}

export function resolveWorkingDirectory(item: WorkItem): string {
  if (item.workspacePath) {
    const path = resolve(item.workspacePath);
    if (!existsSync(path)) throw new Error(`Workspace path does not exist: ${path}`);
    return path;
  }

  const current = process.cwd();
  const referencedDirectories = [...`${item.title}\n${item.description}`.matchAll(/(?:~|\/Users\/[^/\s]+)\/[^\s`'"<>]+/g)]
    .map(([match]) => match.replace(/[),.;:]+$/, '').replace(/^~/, homedir()))
    .filter((path) => existsSync(path))
    .map((path) => statSync(path).isDirectory() ? path : dirname(path));
  if (referencedDirectories.length) {
    const segments = referencedDirectories.map((path) => resolve(path).split('/'));
    const common = segments[0].filter((segment, index) => segments.every((parts) => parts[index] === segment));
    const referencedWorkspace = common.join('/') || '/';
    if (referencedWorkspace !== '/') return referencedWorkspace;
  }

  const workspaceRoot = dirname(current);
  const candidates = readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(workspaceRoot, entry.name))
    .filter((path) => existsSync(join(path, '.git')) || existsSync(join(path, 'package.json')) || existsSync(join(path, 'AGENTS.md')));
  if (!candidates.length) return current;

  const context = `${item.title}\n${item.description}\n${item.projectName ?? ''}\n${item.sourceUrl ?? ''}`.toLowerCase();
  let sourceRepository = '';
  try {
    const url = item.sourceUrl ? new URL(item.sourceUrl) : null;
    if (url?.hostname === 'github.com') sourceRepository = url.pathname.split('/').filter(Boolean)[1]?.replace(/\.git$/, '').toLowerCase() ?? '';
  } catch { /* A malformed legacy URL should not block execution. */ }
  const scored = candidates.map((path) => {
    const name = basename(path).toLowerCase();
    let score = sourceRepository === name ? 100 : 0;
    if (context.includes(name)) score += 50;
    if (item.projectName && (name.includes(item.projectName.toLowerCase()) || item.projectName.toLowerCase().includes(name))) score += 30;
    for (const token of name.split(/[^a-z0-9]+/).filter((value) => value.length > 3)) if (context.includes(token)) score += 8;
    if (item.source === 'linear' && name === 'writer-monorepo') score += 20;
    return { path, score };
  }).sort((left, right) => right.score - left.score);
  if (scored[0]?.score) return scored[0].path;
  if (candidates.length === 1) return candidates[0];
  const writerWorkspace = candidates.find((path) => basename(path).toLowerCase() === 'writer-monorepo');
  if (writerWorkspace && !context.includes('workbench')) return writerWorkspace;
  if (candidates.includes(current)) return current;
  return workspaceRoot;
}

export type ExecutionProfile = 'economy' | 'standard' | 'deep';
export interface AgentUsage { inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null; }
interface AgentCommandResult { output: string; usage: AgentUsage; }

function numberAt(record: Record<string, unknown>, ...keys: string[]): number | null {
  const value = keys.map((key) => record[key]).find((candidate) => typeof candidate === 'number');
  return typeof value === 'number' ? value : null;
}

/**
 * Provider payloads contain all-session totals as well as per-turn usage.
 *
 * `cumulative` distinguishes the two. Codex's `token_count`/`turn.completed` and
 * Claude's terminal `result` report running totals and must *replace* what we
 * hold; Claude's per-message `assistant` events report one message only and must
 * be *summed*, otherwise a multi-turn run keeps just its last message's usage.
 */
interface UsageSample { inputTokens: number | null; outputTokens: number | null; cumulative: boolean; costUsd: number | null }

function usageFromEvent(agent: AgentRun['agent'], event: unknown): UsageSample | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (agent === 'codex') {
    const usage = record.type === 'token_count'
      ? ((record.info as Record<string, unknown> | undefined)?.last_token_usage as Record<string, unknown> | undefined)
      : record.type === 'turn.completed' ? record.usage as Record<string, unknown> | undefined : undefined;
    if (!usage) return null;
    // Codex input_tokens already includes cached_input_tokens. Do not add the
    // cached value again; and never use total_token_usage (all CLI sessions).
    const inputTokens = numberAt(usage, 'input_tokens', 'inputTokens');
    const outputTokens = numberAt(usage, 'output_tokens', 'outputTokens');
    return inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens, cumulative: true, costUsd: null };
  }
  // Claude's terminal `result` event is authoritative: it carries cumulative
  // usage for the whole invocation (subagents included) plus the provider's own
  // billed total. Preferring it removes all guesswork from the stored cost.
  if (record.type === 'result') {
    const total = numberAt(record, 'total_cost_usd', 'totalCostUsd');
    const usage = record.usage as Record<string, unknown> | undefined;
    const outputTokens = usage ? numberAt(usage, 'output_tokens', 'outputTokens') : null;
    const rawInput = usage ? numberAt(usage, 'input_tokens', 'inputTokens') : null;
    const inputTokens = rawInput === null ? null : rawInput
      + (numberAt(usage ?? {}, 'cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0)
      + (numberAt(usage ?? {}, 'cache_read_input_tokens', 'cacheReadInputTokens') ?? 0);
    if (inputTokens === null && outputTokens === null && total === null) return null;
    return { inputTokens, outputTokens, cumulative: true, costUsd: total };
  }
  const usage = record.type === 'assistant'
    ? ((record.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined)
    : undefined;
  if (!usage) return null;
  const input = numberAt(usage, 'input_tokens', 'inputTokens');
  const outputTokens = numberAt(usage, 'output_tokens', 'outputTokens');
  // Claude separates newly processed input from cache creation/read input.
  const inputTokens = input === null ? null : input
    + (numberAt(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0)
    + (numberAt(usage, 'cache_read_input_tokens', 'cacheReadInputTokens') ?? 0);
  return inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens, cumulative: false, costUsd: null };
}

export function compactPromptSection(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const headLength = Math.floor(budget * 0.65);
  const tailLength = Math.floor(budget * 0.25);
  const omitted = Math.max(0, value.length - headLength - tailLength);
  return `${value.slice(0, headLength)}\n\n[… ${omitted.toLocaleString()} characters compacted for this turn …]\n\n${value.slice(-tailLength)}`;
}

/**
 * Pricing resolves per model (env override first, then the built-in list-price
 * table in `model-pricing.ts`). Keyed by agent alone it was wrong by up to ~30x
 * across the tiers Workbench routes to, and unset in practice, so every run
 * stored a null cost.
 */
export function estimateUsageCost(agent: AgentRun['agent'], model: string | null, inputTokens: number | null, outputTokens: number | null): number | null {
  return estimateModelCost(agent, model, inputTokens, outputTokens);
}

export function selectExecutionProfile(item: WorkItem, run: Pick<AgentRun, 'kind' | 'instructions'>): ExecutionProfile {
  const text = `${item.title}\n${item.description}\n${run.instructions}`.toLowerCase();
  const highRisk = /\b(architecture|re-architect|migration|security|authentication|authorization|payments?|production incident|data loss|multi[- ]repo|cross[- ]system|breaking change)\b/.test(text);
  const broadImplementation = /\b(?:whole|entire|full|complete|end[- ]to[- ]end)\b(?:\s+\w+){0,2}\s+(?:ui|page|screen|feature|flow|dashboard|application)\b/.test(text)
    || /\b(?:multiple|all)\s+(?:pages|screens|components|flows|features)\b/.test(text);
  const decomposing = run.instructions.includes('WORKBENCH_DECOMPOSITION');
  if (decomposing || highRisk || broadImplementation || (text.length > 8_000 && (run.kind === 'execute' || run.kind === 'review'))) return 'deep';
  if (run.kind === 'execute' || run.kind === 'review' || text.length > 2_500) return 'standard';
  return 'economy';
}

export function selectPromptExecutionProfile(prompt: string): ExecutionProfile {
  const text = prompt.toLowerCase();
  if (/\b(architecture|migration|security|authentication|authorization|production incident|data loss|multi[- ]repo|cross[- ]system)\b/.test(text) || text.length > 8_000) return 'deep';
  if (/\b(add|change|configure|connect|create|debug|deploy|edit|fix|implement|integrate|investigate|move|optimi[sz]e|refactor|remove|rename|replace|review|test|update|upgrade|wire|write|build|technical spec)\b/.test(text)
    || /\b(api|backend|client|component|css|database|endpoint|frontend|react|repository|schema|server|typescript|ui)\b/.test(text)
    || text.length > 2_000) return 'standard';
  // Auto is intentionally quality-biased. Economy is an explicit user choice;
  // unqualified conversation turns default to the balanced tier.
  return 'standard';
}

const executionProfileRank: Record<ExecutionProfile, number> = { economy: 0, standard: 1, deep: 2 };

/**
 * Auto routing may scale a task upward from the task and its requested instructions,
 * never from generated agent scaffolding or shared context. The latter routinely contains
 * words such as "security" and "architecture" that must not turn a scoped task into deep work.
 */
export function resolveExecutionProfileDecision(
  item: WorkItem,
  run: Pick<AgentRun, 'kind' | 'instructions'>,
  requestedInstructions: string,
): { profile: ExecutionProfile; source: ExecutionProfileSource } {
  const taskProfile = selectExecutionProfile(item, run);
  const promptProfile = selectPromptExecutionProfile(requestedInstructions);
  return executionProfileRank[taskProfile] >= executionProfileRank[promptProfile]
    ? { profile: taskProfile, source: 'task' }
    : { profile: promptProfile, source: 'prompt' };
}

export function selectAutoExecutionProfile(item: WorkItem, run: Pick<AgentRun, 'kind' | 'instructions'>, requestedInstructions: string): ExecutionProfile {
  return resolveExecutionProfileDecision(item, run, requestedInstructions).profile;
}

export function commandFor(agent: AgentRun['agent'], cwd: string, profile: ExecutionProfile): { command: string; args: string[] } {
  // Claude consumes its separate session allowance aggressively during long
  // autonomous tool loops. Keep the chosen model tier intact while reserving
  // higher reasoning effort for genuinely deep work.
  const effort = agent === 'claude'
    ? profile === 'deep' ? 'medium' : 'low'
    : profile === 'economy' ? 'low' : profile === 'standard' ? 'medium' : 'high';
  if (agent === 'codex') {
    const model = modelFor(agent, profile);
    return {
      command: 'codex',
      // The task workspace picks a working directory; it is not a filesystem boundary.
      args: ['exec', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '-c', `model_reasoning_effort="${effort}"`, '--model', model, '-C', cwd, '-'],
    };
  }
  const model = modelFor(agent, profile);
  return {
    command: 'claude',
    // Claude treats --add-dir as an allowlist. Include the home directory so
    // a task-linked agent can access sibling repos and user documents.
    // Keep the parent stream observable while Claude delegates work. Forwarded
    // child events are non-terminal assistant/user events, so they cannot be
    // mistaken for completion of the parent response.
    args: ['-p', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--forward-subagent-text', '--verbose', '--effort', effort, '--model', model, '--no-session-persistence', '--disable-slash-commands', '--add-dir', cwd, homedir()],
  };
}

export function modelFor(agent: AgentRun['agent'], profile: ExecutionProfile): string {
  return process.env[`WORKBENCH_${agent.toUpperCase()}_MODEL_${profile.toUpperCase()}`]?.trim()
    || process.env[`WORKBENCH_${agent.toUpperCase()}_MODEL`]?.trim()
    || (agent === 'codex'
      ? { economy: 'gpt-5.6-luna', standard: 'gpt-5.6-terra', deep: 'gpt-5.6-sol' }[profile]
      : { economy: 'haiku', standard: 'sonnet', deep: 'opus' }[profile]);
}

export async function judgeExecutionProfile(prompt: string, cwd: string, signal?: AbortSignal): Promise<ExecutionProfile> {
  // Routing must not consume a second agent turn. The deterministic policy is explainable,
  // cheap, and keeps the requested agent's response as the only billable execution.
  void cwd;
  void signal;
  return selectPromptExecutionProfile(prompt);
}

export interface AgentAuditCandidate { category: 'agent_file_read' | 'agent_file_write' | 'agent_tool_use'; detail: string }

/**
 * Coding CLIs launch shell commands of their own. Killing only the CLI leaves
 * those descendants alive (and they can keep editing after Workbench says
 * "Canceled"). Each CLI gets its own process group; cancellation signals the
 * entire group and escalates if it does not exit promptly.
 */
function terminateAgentProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may have already exited; fall through to the direct child.
    }
  }
  try { child.kill(signal); } catch { /* already stopped */ }
}

export function readableAgentEvent(agent: AgentRun['agent'], line: string): { progress: string; final: string | null; audit: AgentAuditCandidate[] } {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (agent === 'codex') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') return { progress: item.text, final: item.text, audit: [] };
      if (item?.type === 'reasoning' && typeof item.text === 'string') return { progress: `Reasoning summary: ${item.text}`, final: null, audit: [] };
      if (item?.type === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : 'command';
        const label = /(?:npm|pnpm|yarn) (?:test|run test)|vitest/.test(command) ? 'Running tests'
          : /(?:npm|pnpm|yarn) run (?:build|typecheck|lint)/.test(command) ? 'Verifying the project'
          : /git (?:status|diff|log)/.test(command) ? 'Inspecting repository changes'
          : /(?:rg|grep|find) /.test(command) ? 'Searching the codebase'
          : /(?:cat|sed|head|tail) /.test(command) ? 'Reading project files'
          : `Running a workspace command: ${command.slice(0, 100)}`;
        const audit: AgentAuditCandidate[] = event.type === 'item.started' ? [{ category: 'agent_tool_use', detail: `command_execution: ${command.slice(0, 500)}` }] : [];
        return { progress: event.type === 'item.started' ? `● ${label}` : '', final: null, audit };
      }
      if (item?.type === 'file_change') {
        const changes = item.changes as Array<{ path?: string; kind?: string }> | undefined;
        const audit: AgentAuditCandidate[] = (changes ?? [{}]).map((change) => ({
          category: 'agent_file_write',
          detail: change.path ? `${change.kind ?? 'update'}: ${change.path}` : 'file_change',
        }));
        return { progress: '● Updating project files', final: null, audit };
      }
      if (event.type === 'turn.started') return { progress: '● Analyzing the task', final: null, audit: [] };
      return { progress: '', final: null, audit: [] };
    }
    if (event.type === 'assistant') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      const audit: AgentAuditCandidate[] = [];
      const parts = (message?.content ?? []).flatMap((content) => {
        if (content.type === 'text' && typeof content.text === 'string') return [content.text];
        if (content.type === 'tool_use') {
          const name = String(content.name ?? 'tool');
          const input = (content.input ?? {}) as Record<string, unknown>;
          const description = typeof input.description === 'string' ? input.description : '';
          const filePath = String(input.file_path ?? input.file ?? '');
          if (name === 'Read') audit.push({ category: 'agent_file_read', detail: filePath || 'unknown file' });
          else if (name === 'Edit' || name === 'Write') audit.push({ category: 'agent_file_write', detail: filePath || 'unknown file' });
          else audit.push({ category: 'agent_tool_use', detail: description ? `${name}: ${description}` : name });
          if (description) return [`● ${description.charAt(0).toUpperCase()}${description.slice(1)}`];
          if (name === 'Read') return [`● Reading ${String(input.file_path ?? input.file ?? 'a project file')}`];
          if (name === 'Edit' || name === 'Write') return [`● Editing ${String(input.file_path ?? input.file ?? 'project files')}`];
          if (name === 'Glob' || name === 'Grep') return ['● Searching the codebase'];
          if (name === 'Bash') return ['● Running a workspace command'];
          return [`● Using ${name}`];
        }
        return [];
      });
      // Claude emits assistant events for forwarded subagent text as well as
      // the parent. They are progress only: `result` is the sole terminal
      // event for a Claude print-mode invocation.
      return { progress: parts.join('\n'), final: null, audit };
    }
    if (event.type === 'result' && typeof event.result === 'string') return { progress: '', final: event.result, audit: [] };
    if (event.type === 'system') return { progress: '', final: null, audit: [] };
    return { progress: '', final: null, audit: [] };
  } catch {
    return { progress: line, final: null, audit: [] };
  }
}

function terminalAgentError(agent: AgentRun['agent'], line: string): string | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (agent === 'claude' && event.type === 'result' && event.is_error === true) return String(event.result ?? event.error ?? 'Claude reported a terminal error.');
    if (agent === 'codex' && event.type === 'turn.failed') {
      const error = event.error as Record<string, unknown> | undefined;
      return String(error?.message ?? event.message ?? 'Codex reported a terminal error.');
    }
    if (event.type === 'error') return String(event.message ?? event.error ?? 'The provider reported a terminal error.');
  } catch { /* Plain text cannot be a structured terminal error event. */ }
  return null;
}

async function runAgentCommandWithUsage(agent: AgentRun['agent'], cwd: string, prompt: string, onProgress?: (output: string) => void, signal?: AbortSignal, profile: ExecutionProfile = 'economy', onUsage?: (usage: AgentUsage, agent: AgentRun['agent']) => void, onAudit?: (entries: AgentAuditCandidate[], agent: AgentRun['agent']) => void): Promise<AgentCommandResult> {
  const { command, args } = commandFor(agent, cwd, profile);
  return new Promise<AgentCommandResult>((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: agentSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Unix this makes child.pid the process-group leader, allowing Stop
      // to kill Codex/Claude and every shell/tool process it created.
      detached: process.platform !== 'win32',
    });
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let stopping = false;
    let cancellationRequested = false;
    let terminationError: Error | null = null;
    const stopProcessTree = () => {
      if (stopping) return;
      stopping = true;
      terminateAgentProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminateAgentProcessTree(child, 'SIGKILL'), 3_000);
      forceKillTimer.unref();
    };
    const cancel = () => {
      cancellationRequested = true;
      stopProcessTree();
    };
    const efficientPrompt = agent === 'claude' ? `${prompt}

Claude execution budget:
Use the shortest tool path that can complete the requested work correctly. Do not spawn subagents unless the task explicitly requires independent parallel work. Do not reread unchanged files or repeat equivalent searches. Run one focused verification pass, expand it only when that pass reveals a concrete risk, then stop and report the result.` : prompt;
    let stdout = '';
    let stderr = '';
    let buffered = '';
    let progress = '';
    let finalOutput = '';
    let terminalError = '';
    let lastProgressEvent = '';
    const runModel = modelFor(agent, profile);
    let reportedUsage: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null };
    // Set only by the provider's own billed total (Claude `result.total_cost_usd`).
    // When present it wins over any rate-table estimate.
    let providerCostUsd: number | null = null;
    let estimatedOutputTokens = 0;
    let lastReportedUsage = '';
    const costFor = (inputTokens: number | null, outputTokens: number | null): number | null =>
      providerCostUsd ?? estimateUsageCost(agent, runModel, inputTokens, outputTokens);
    const emitLiveUsage = () => {
      const liveUsage = {
        inputTokens: reportedUsage.inputTokens,
        outputTokens: Math.max(reportedUsage.outputTokens ?? 0, estimatedOutputTokens) || null,
      };
      const signature = `${liveUsage.inputTokens ?? ''}:${liveUsage.outputTokens ?? ''}:${providerCostUsd ?? ''}`;
      if (signature === lastReportedUsage) return;
      lastReportedUsage = signature;
      onUsage?.({ ...liveUsage, estimatedCostUsd: costFor(liveUsage.inputTokens, liveUsage.outputTokens) }, agent);
    };
    const reportUsage = (usage: UsageSample) => {
      if (usage.costUsd !== null) providerCostUsd = usage.costUsd;
      if (usage.cumulative) {
        // A cumulative event supersedes accumulated per-message samples, but must
        // not erase a count it simply did not carry.
        reportedUsage = {
          inputTokens: usage.inputTokens ?? reportedUsage.inputTokens,
          outputTokens: usage.outputTokens ?? reportedUsage.outputTokens,
        };
      } else {
        reportedUsage = {
          inputTokens: usage.inputTokens === null ? reportedUsage.inputTokens : (reportedUsage.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: usage.outputTokens === null ? reportedUsage.outputTokens : (reportedUsage.outputTokens ?? 0) + usage.outputTokens,
        };
      }
      emitLiveUsage();
    };
    const timeout = setTimeout(() => {
      terminationError = new Error('Agent run timed out after 30 minutes.');
      stopProcessTree();
    }, 30 * 60 * 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        terminalError ||= terminalAgentError(agent, line) ?? '';
        try { const usage = usageFromEvent(agent, JSON.parse(line)); if (usage) reportUsage(usage); } catch { /* non-JSON provider output has no structured usage */ }
        const event = readableAgentEvent(agent, line);
        if (event.progress && event.progress !== lastProgressEvent) {
          progress += `${progress ? '\n\n' : ''}${event.progress}`;
          lastProgressEvent = event.progress;
        }
        if (event.final) finalOutput = event.final;
        if (event.audit.length) onAudit?.(event.audit, agent);
      }
      if (progress) {
        const visibleProgress = progress.slice(-MAX_OUTPUT_BYTES);
        onProgress?.(visibleProgress);
        // Codex does not provide authoritative totals until turn.completed.
        // A conservative character-based estimate keeps the live counter moving;
        // the terminal provider event replaces it with the real total.
        estimatedOutputTokens = Math.max(estimatedOutputTokens, Math.ceil(visibleProgress.length / 4));
        emitLiveUsage();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      terminationError = error;
      stopProcessTree();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', cancel);
      if (buffered.trim()) {
        terminalError ||= terminalAgentError(agent, buffered.trim()) ?? '';
        try { const usage = usageFromEvent(agent, JSON.parse(buffered.trim())); if (usage) reportUsage(usage); } catch { /* non-JSON provider output has no structured usage */ }
        const event = readableAgentEvent(agent, buffered.trim());
        if (event.progress && event.progress !== lastProgressEvent) progress += `${progress ? '\n\n' : ''}${event.progress}`;
        if (event.final) finalOutput = event.final;
        if (event.audit.length) onAudit?.(event.audit, agent);
      }
      if (cancellationRequested || signal?.aborted) reject(new Error('Agent run canceled.'));
      else if (terminationError) reject(terminationError);
      else if (code === 0 && !terminalError) {
        const output = finalOutput.trim() || progress.trim() || stdout.trim();
        const outputTokens = reportedUsage.outputTokens ?? (estimatedOutputTokens || null);
        resolveOutput({ output, usage: { inputTokens: reportedUsage.inputTokens, outputTokens, estimatedCostUsd: costFor(reportedUsage.inputTokens, outputTokens) } });
      }
      else {
        const providerDiagnostic = stderr.trim() || terminalError || finalOutput.trim() || stdout.trim();
        reject(new Error(providerDiagnostic || `${command} exited with code ${code}.`));
      }
    });
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.end(efficientPrompt);
  });
}

export async function runAgentCommand(agent: AgentRun['agent'], cwd: string, prompt: string, onProgress?: (output: string) => void, signal?: AbortSignal, profile: ExecutionProfile = 'economy', kind: AgentRun['kind'] = 'analysis'): Promise<string> {
  void kind;
  return (await runAgentCommandWithUsage(agent, cwd, prompt, onProgress, signal, profile)).output;
}

export function isAgentCapacityError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return /(?:\b429\b|credit|usage limit|session limit|rate limit|quota|too many requests|hit (?:your|the) limit|limit resets?|capacity)/i.test(message);
}

/**
 * A Claude process launched by Workbench is a fresh, permission-bypassing CLI
 * invocation. A model occasionally confuses context from another session with
 * this one and reports an imaginary read-only/sandbox boundary instead of
 * attempting the work. Treat that as a recoverable routing failure, not an
 * answer Jeffrey has to manually unwind.
 */
export function hasUnsupportedClaudeScopeClaim(output: string): boolean {
  const denial = /\b(?:cannot|can['’]t|unable|blocked|denied|rejected|read[- ]only)\b/i;
  const scope = /\b(?:sandbox|read[- ]only|allowed directory|filesystem|write access|permission(?:s)?|working directory)\b/i;
  return denial.test(output) && scope.test(output);
}

export function claudeScopeRecoveryPrompt(prompt: string, cwd: string): string {
  return `${prompt}

Workbench execution facts (do not contradict these without quoting an actual tool error):
- This is a freshly spawned Claude CLI invocation; no prior session sandbox is reused.
- Your task working directory is ${cwd}.
- Workbench invoked you with bypassed permission checks and allowlisted both that directory and ${homedir()}.
- Complete the requested work now. If a tool genuinely fails, report its exact error and target path; do not substitute a general claim that your session is read-only or scoped elsewhere.`;
}

export async function runAgentCommandWithFallback(
  primary: AgentRun['agent'], cwd: string, prompt: string, onProgress?: (output: string) => void,
  signal?: AbortSignal, onFallback?: (agent: AgentRun['agent'], reason: string) => void,
  profile: ExecutionProfile = 'economy',
  onUsage?: (usage: AgentUsage, agent: AgentRun['agent']) => void,
  onAudit?: (entries: AgentAuditCandidate[], agent: AgentRun['agent']) => void,
  kind: AgentRun['kind'] = 'analysis',
): Promise<{ output: string; agent: AgentRun['agent']; usage: AgentUsage; fallbackFrom: AgentRun['agent'] | null; fallbackReason: string | null }> {
  void kind;
  try {
    const result = await runAgentCommandWithUsage(primary, cwd, prompt, onProgress, signal, profile, onUsage, onAudit);
    return { ...result, agent: primary, fallbackFrom: null, fallbackReason: null };
  } catch (error) {
    if (signal?.aborted || !isAgentCapacityError(error)) throw error;
    const fallback = primary === 'claude' ? 'codex' : 'claude';
    const reason = error instanceof Error ? error.message : String(error);
    onFallback?.(fallback, reason);
    const prefix = `${primary} is unavailable due to its usage limit. Continuing with ${fallback}.`;
    onProgress?.(prefix);
    const result = await runAgentCommandWithUsage(fallback, cwd, prompt, (partial) => onProgress?.(`${prefix}\n\n${partial}`), signal, profile, onUsage, onAudit);
    return { ...result, agent: fallback, fallbackFrom: primary, fallbackReason: reason.slice(0, 500) };
  }
}

/**
 * True for failures worth retrying automatically: transport/process-level hiccups
 * that say nothing about whether the work itself is doomed. Deliberately excludes
 * capacity errors (handled separately via `isAgentCapacityError`/fallback) and
 * anything that looks like a real content/validation failure, which retrying
 * would just repeat.
 */
export function isTransientAgentError(value: unknown): boolean {
  if (isAgentCapacityError(value)) return false;
  const message = value instanceof Error ? value.message : String(value);
  return /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|network|timed out|timeout|5\d\d\b|temporarily unavailable|service unavailable)/i.test(message);
}

/** Exponential backoff with jitter, capped, keyed by the (1-based) attempt number about to run. */
export function backoffDelayMs(attempt: number, baseMs = 5_000, capMs = 5 * 60_000): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * baseMs;
  return Math.min(capMs, exponential + jitter);
}

/** Run kinds safe to silently retry: they only read/produce text, no filesystem edits to redo. `execute` is excluded because it performs non-idempotent filesystem edits. */
const RETRYABLE_KINDS = new Set<string>(['analysis', 'research', 'review', 'strategy', 'bugfix']);

export async function executeAgentRun(repository: WorkItemRepository, run: AgentRun, ownerId: string, leaseMs: number, externalContext = ''): Promise<void> {
  if (!repository.claimRun(run.id, ownerId, leaseMs)) return;
  const item = repository.get(run.workItemId);
  if (!item) return;
  const controller = new AbortController();
  activeRunControllers.set(run.id, controller);
  // Requests can originate from the preview API, which intentionally has no
  // scheduler. Keep this run's lease alive locally instead of relying on a
  // process-wide scheduler that may not exist in the dispatching process. The
  // same tick observes durable cancellation and proves this process still owns
  // the attempt. Losing either condition stops its process tree.
  const leaseHeartbeat = setInterval(() => {
    try {
      if (repository.isCancellationRequested(run.id)) controller.abort(new Error('Agent run cancellation requested.'));
      else if (!repository.renewRunLease(run.id, ownerId, leaseMs)) controller.abort(new Error('Agent run lease ownership lost.'));
    } catch (error) {
      controller.abort(error);
    }
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  leaseHeartbeat.unref();
  const startedAt = new Date().toISOString();
  repository.updateRun(run.id, { startedAt });
  repository.update(item.id, { status: 'in_progress' });
  repository.moveForAttention(item.id, 'bottom', `${run.agent} started ${run.kind}.`);
  repository.addActivity(item.id, run.agent, 'progress', `Started ${run.kind}.`);
  try {
    const cwd = resolveWorkingDirectory(item);
    // The resolved workspace is explicit in the CLI command and surfaced in
    // activity so a run's filesystem boundary is never implicit.
    repository.addActivity(item.id, 'system', 'progress', `Workspace resolved to ${cwd}.`);
    const sharedContext = [repository.getSharedContext(undefined, { workItemId: item.id }), externalContext].filter(Boolean).join('\n\n');
    const prompt = buildPrompt(item, run, sharedContext);
    if (run.messageId) repository.updateSharedMessage(run.messageId, { executionProfile: 'routing' });
    const decision: { profile: ExecutionProfile; source: ExecutionProfileSource } = run.executionProfile
      ? { profile: run.executionProfile, source: 'requested' }
      : resolveExecutionProfileDecision(item, run, `${item.title}\n${item.description}\n${run.instructions}`);
    const profile = decision.profile;
    const model = modelFor(run.agent, profile);
    repository.updateRun(run.id, { model, executionProfile: profile });
    if (run.messageId) repository.updateSharedMessage(run.messageId, { model, executionProfile: profile });
    if (run.conversationId) repository.setConversationExecutionProfile(run.conversationId, profile);
    // The model and effort tier are picked for Jeffrey, not by him. Record the
    // choice and its reason so the activity log explains what actually ran.
    repository.addActivity(item.id, 'system', 'model_selected', describeModelSelection({ agent: run.agent, kind: run.kind, model, profile, source: decision.source }));
    let result = await runAgentCommandWithFallback(run.agent, cwd, run.agent === 'claude' ? claudeScopeRecoveryPrompt(prompt, cwd) : prompt, (partialOutput) => {
      repository.updateRun(run.id, { output: partialOutput });
      if (run.messageId) repository.updateSharedMessage(run.messageId, { body: partialOutput });
    }, controller.signal, (fallback, reason) => {
      repository.updateRun(run.id, { agent: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: run.agent, fallbackReason: reason.slice(0, 500) });
      if (run.messageId) repository.updateSharedMessage(run.messageId, { author: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: run.agent, fallbackReason: reason.slice(0, 500) });
      if (run.requestedTarget === 'auto') repository.updateAutomaticAgentAssignees(item.id, [fallback]);
      repository.addActivity(item.id, 'system', 'agent_fallback', describeAgentFallback({ from: run.agent, to: fallback, model: modelFor(fallback, profile), reason }));
    }, profile, (usage) => {
      const telemetry = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd };
      repository.updateRun(run.id, telemetry);
      if (run.messageId) repository.updateSharedMessage(run.messageId, telemetry);
    }, (entries, producingAgent) => {
      for (const entry of entries) repository.addAuditEntry(entry.category, producingAgent, entry.detail, item.id);
    }, run.kind);
    if (result.agent === 'claude' && hasUnsupportedClaudeScopeClaim(result.output)) {
      const reason = 'Claude reported a sandbox or read-only scope despite this fresh bypass-permission invocation; Workbench handed the run to Codex.';
      repository.addActivity(item.id, 'system', 'agent_fallback', reason);
      repository.updateRun(run.id, { output: '● Claude reported an invalid workspace-scope blocker. Handing this tracked run to Codex…', fallbackFrom: 'claude', fallbackReason: reason });
      if (run.messageId) repository.updateSharedMessage(run.messageId, { body: '● Claude reported an invalid workspace-scope blocker. Handing this tracked run to Codex…', fallbackFrom: 'claude', fallbackReason: reason });
      const recovered = await runAgentCommandWithFallback('codex', cwd, `${prompt}\n\nRecovery handoff: Claude incorrectly claimed it lacked workspace access. Complete the original task directly. Do not repeat that claim; report only observed commands, files changed, verification, and concrete blockers.`, (partialOutput) => {
        repository.updateRun(run.id, { output: partialOutput });
        if (run.messageId) repository.updateSharedMessage(run.messageId, { body: partialOutput });
      }, controller.signal, undefined, profile, (usage) => {
        const telemetry = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd };
        repository.updateRun(run.id, telemetry);
        if (run.messageId) repository.updateSharedMessage(run.messageId, telemetry);
      }, (entries, producingAgent) => {
        for (const entry of entries) repository.addAuditEntry(entry.category, producingAgent, entry.detail, item.id);
      }, run.kind);
      result = { ...recovered, fallbackFrom: 'claude', fallbackReason: reason };
      repository.updateRun(run.id, { agent: result.agent, model: modelFor(result.agent, profile), fallbackFrom: 'claude', fallbackReason: reason });
      if (run.messageId) repository.updateSharedMessage(run.messageId, { author: result.agent, model: modelFor(result.agent, profile), fallbackFrom: 'claude', fallbackReason: reason });
      if (run.requestedTarget === 'auto') repository.updateAutomaticAgentAssignees(item.id, [result.agent]);
    }
    const { output } = result;
    const telemetry = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, estimatedCostUsd: result.usage.estimatedCostUsd, fallbackFrom: result.fallbackFrom, fallbackReason: result.fallbackReason };
    let executionPlan: { summary: string; tasks: Array<{ title: string; description: string; workspacePath: string | null }> } | null = null;
    if (run.instructions.includes('WORKBENCH_DECOMPOSITION')) {
      const match = output.match(/<workbench-plan>([\s\S]*?)<\/workbench-plan>/);
      if (!match) throw new Error('Strategy completed without a valid Workbench task decomposition.');
      const parsed = JSON.parse(match[1]) as { summary?: unknown; tasks?: Array<{ title?: unknown; description?: unknown; workspacePath?: unknown }> };
      if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.tasks) || parsed.tasks.length < 2) throw new Error('Complex work must be decomposed into at least two independently executable follow-up tasks.');
      executionPlan = { summary: parsed.summary, tasks: parsed.tasks.map((task) => {
        if (typeof task.title !== 'string' || typeof task.description !== 'string') throw new Error('Every planned task needs a title and description.');
        return { title: task.title, description: task.description, workspacePath: typeof task.workspacePath === 'string' ? task.workspacePath : null };
      }) };
    }
    if (!repository.finishRun(run.id, ownerId, { agent: result.agent, status: 'completed', output, completedAt: new Date().toISOString(), ...telemetry })) return;
    if (executionPlan) repository.createExecutionPlan(item.id, executionPlan.summary, executionPlan.tasks);
    if (run.messageId) {
      repository.updateSharedMessage(run.messageId, { body: output, status: 'completed', ...telemetry });
      if (run.conversationId) repository.recordAgentHandoff(run.conversationId, run.messageId, result.agent, output);
    }
    // A decomposition can archive the parent while this process is winding
    // down. Never resurrect or reorder that historical parent from a late
    // completion callback.
    const latestItem = repository.get(item.id);
    if (!latestItem?.archivedAt && latestItem?.status !== 'done' && latestItem?.status !== 'canceled' && !repository.activeRunsForItem(item.id).length) {
      repository.update(item.id, { status: 'ready' });
      repository.moveForAttention(item.id, 'top', `${result.agent} completed ${run.kind}; review the result.`);
    }
    repository.addActivity(item.id, result.agent, 'progress', `Completed ${run.kind}.`);
    notifyAgentRunFinished(item, { agent: result.agent, kind: run.kind }, 'completed', output);
  } catch (error) {
    if (controller.signal.aborted) {
      if (repository.isCancellationRequested(run.id) && repository.finishRunCancellation(run.id, ownerId) && run.messageId) {
        repository.updateSharedMessage(run.messageId, { status: 'canceled' });
      }
      return;
    }
    const message = error instanceof Error ? error.message : 'Agent run failed.';
    const activeAgent = repository.getRun(run.id)?.agent ?? run.agent;
    if (RETRYABLE_KINDS.has(run.kind) && isTransientAgentError(error) && repository.scheduleRunRetry(run.id, ownerId, backoffDelayMs((repository.getRun(run.id)?.attempt ?? 0) + 1))) {
      repository.addActivity(item.id, activeAgent, 'progress', `${run.kind} hit a transient error and was scheduled for retry: ${message.slice(0, 240)}`);
      // Do not call notifyAgentRunFinished here: a retry is not a final outcome, and
      // notifying on every attempt would spam Slack for something Jeffrey doesn't need to see yet.
      return;
    }
    if (!repository.finishRun(run.id, ownerId, { status: 'failed', error: message, completedAt: new Date().toISOString() })) return;
    if (run.messageId) repository.updateSharedMessage(run.messageId, { status: 'failed', error: message });
    const latestItem = repository.get(item.id);
    if (!latestItem?.archivedAt && latestItem?.status !== 'done') {
      repository.update(item.id, { status: 'blocked' });
      repository.moveForAttention(item.id, 'top', `${activeAgent} execution failed and needs intervention.`);
    }
    repository.addActivity(item.id, activeAgent, 'blocker', `${run.kind} failed: ${message}`);
    notifyAgentRunFinished(item, repository.getRun(run.id) ?? run, 'failed', message);
  } finally {
    clearInterval(leaseHeartbeat);
    activeRunControllers.delete(run.id);
  }
}

export function cancelAgentRun(repository: WorkItemRepository, id: string): AgentRun | null {
  const run = repository.getRun(id);
  if (!run || !['queued', 'running'].includes(run.status)) return null;
  if (!repository.requestRunCancellation(id)) return null;
  const completedAt = new Date().toISOString();
  repository.updateRun(id, { status: 'canceled', completedAt });
  if (run.messageId) repository.updateSharedMessage(run.messageId, { status: 'canceled' });
  const item = repository.get(run.workItemId);
  if (!item?.archivedAt && item?.status !== 'done') {
    repository.update(run.workItemId, { status: 'ready' });
    repository.moveForAttention(run.workItemId, 'top', `${run.agent} execution was canceled.`);
  }
  repository.addActivity(run.workItemId, run.agent, 'progress', `Canceled ${run.kind}.`);
  const controller = activeRunControllers.get(id);
  if (controller) controller.abort();
  return { ...run, status: 'canceled', completedAt };
}

export function resolveAgents(kind: AgentRun['kind'], target: AgentRun['requestedTarget']): AgentRun['agent'][] {
  if (target === 'codex' || target === 'claude') return [target];
  if (target === 'both') return ['codex', 'claude'];
  if (kind === 'review') return ['codex'];
  return kind === 'execute' ? ['codex'] : ['claude'];
}

function explicitDeliverableKind(title: string): AgentRun['kind'] | null {
  const normalized = title.trim().toLowerCase();
  if (/^(?:please\s+)?(?:review|code[- ]review)\b/.test(normalized) && /\b(?:pr|pull request|diff|patch|code|implementation|changes?)\b/.test(normalized)) return 'review';
  if (/^(?:please\s+)?(?:research|investigate|explore|compare|evaluate)\b/.test(normalized)) return 'research';
  if (/^(?:please\s+)?(?:plan|scope|design|draft|author|revise|write|create|produce)\b/.test(normalized) && /\b(?:plan|strategy|spec|rfc|proposal|technical document|design doc|architecture)\b/.test(normalized)) return 'strategy';
  if (/^(?:please\s+)?(?:explain|summarize|describe|organize|discuss|assess)\b/.test(normalized)) return 'analysis';
  if (/^(?:please\s+)?(?:implement|build|code|fix|debug|refactor|test|edit|update|reduce|trim|rewrite|remove|add|change|create|write|publish|deploy|install|configure|connect|move|rename|delete|archive|restore|enable|disable|set|convert|migrate|upgrade|replace|clean|automate|expose|advance|complete|finish|continue|resume)\b/.test(normalized)) return 'execute';
  return null;
}

export function classifyExecution(item: WorkItem): { kind: AgentRun['kind']; agent: AgentRun['agent']; complex: boolean; instructions: string; reason: string } {
  const text = `${item.title}\n${item.description}`.toLowerCase();
  const complex = /\b(migrate|redesign|re-architect|rebuild|epic|cross[- ]team|multi[- ]phase)\b/.test(text);
  let kind: AgentRun['kind'] = 'analysis';
  let agent: AgentRun['agent'] = 'claude';
  const title = item.title.toLowerCase();
  const explicitKind = explicitDeliverableKind(title);
  const explicitCodeReview = /\bcode review\b/.test(title)
    || /\breview\b[^\n.!?]{0,80}\b(?:pr|pull request|diff|patch|code changes?|implementation)\b/.test(title)
    || /\b(?:pr|pull request|diff|patch)\b[^\n.!?]{0,40}\breview\b/.test(title)
    || (/(?:github\.com\/[^/]+\/[^/]+\/pull\/\d+)/.test(item.sourceUrl ?? '') && /\b(review|feedback|approve|regression)\b/.test(text));
  const implementation = /\b(implement|build|code|fix|debug|refactor|test|edit|update|reduce|trim|rewrite|remove|add|change|create|write)\b/.test(text);
  const implementationTitle = /\b(implement|build|code|fix|debug|refactor|test|edit|update|reduce|trim|rewrite|remove|add|change)\b/.test(title);
  const documentStrategy = /\b(spec|rfc|technical document|design doc|proposal)\b/.test(title)
    && /\b(plan|draft|write|create|produce|author|revise|define|spec|rfc|proposal)\b/.test(title);
  let reason = 'keyword rules: no explicit deliverable verb matched, so it defaults to analysis';
  if (explicitKind) { kind = explicitKind; agent = explicitKind === 'execute' || explicitKind === 'review' ? 'codex' : 'claude'; reason = `keyword rules: the title starts with an explicit ${explicitKind} verb`; }
  else if (explicitCodeReview && !implementation) { kind = 'review'; agent = 'codex'; reason = 'keyword rules: the title asks for a code review'; }
  else if (documentStrategy && !implementationTitle) { kind = 'strategy'; agent = 'claude'; reason = 'keyword rules: the title asks for a written spec or plan'; }
  else if (implementation) { kind = 'execute'; agent = 'codex'; reason = 'keyword rules: the task describes implementation work'; }
  else if (/\b(research|investigate|explore|compare|evaluate)\b/.test(text)) { kind = 'research'; agent = 'claude'; reason = 'keyword rules: the task asks for investigation'; }

  if (kind === 'execute' && isDocumentWork(item)) agent = 'claude';
  const assignedAgent = item.assignees.find((assignee): assignee is AgentRun['agent'] => assignee === 'codex' || assignee === 'claude');
  if (assignedAgent && kind !== 'review') agent = assignedAgent;

  if (complex && kind !== 'review') {
    return {
      kind: 'strategy', agent: 'claude', complex: true,
      reason: 'keyword rules: the task spans multiple phases or systems, so it is decomposed first',
      instructions: `WORKBENCH_DECOMPOSITION: This appears complex. Research the relevant context, then produce an approval-ready strategy. Do not implement yet. Propose at least two independently executable follow-up tasks. End with exactly one machine-readable block in this form: <workbench-plan>{"summary":"approval-ready strategy","tasks":[{"title":"first independently executable task","description":"complete context, outcome, constraints, and verification","workspacePath":null},{"title":"second independently executable task","description":"complete context, outcome, constraints, and verification","workspacePath":null}]}</workbench-plan>. Tasks must be self-contained and ordered by recommended attention.`,
    };
  }
  return {
    kind, agent, complex: false, reason,
    instructions: kind === 'review'
      ? 'Perform the authoritative frontend-reviewer first pass. Review only; do not modify code or execute tests.'
      : kind === 'bugfix'
        ? 'Investigate this bug through the bug-investigator persona. Do not write a fix. Propose ranked root causes with a probability and an ELI5 explanation for each, so Jeffrey can decide what to do next.'
        : kind === 'execute' && isBackendImplementation(item)
          ? 'Execute this self-contained backend task through the authoritative backend-engineer persona. Make authorized changes and return observed evidence and verification.'
          : `Execute this self-contained ${kind} task end to end. Use the appropriate tools, make necessary changes when authorized, and return evidence and verification.`,
  };
}

export function classificationForKind(item: WorkItem, kind: AgentRun['kind']): ReturnType<typeof classifyExecution> {
  let agent: AgentRun['agent'] = kind === 'execute' || kind === 'review' ? 'codex' : 'claude';
  if (kind === 'execute' && isDocumentWork(item)) agent = 'claude';
  const assignedAgent = item.assignees.find((assignee): assignee is AgentRun['agent'] => assignee === 'codex' || assignee === 'claude');
  if (assignedAgent && kind !== 'review') agent = assignedAgent;
  return {
    kind, agent, complex: false, reason: 'you picked this task type by hand',
    instructions: kind === 'review'
      ? 'Perform the authoritative frontend-reviewer first pass. Review only; do not modify code or execute tests.'
      : kind === 'bugfix'
        ? 'Investigate this bug through the bug-investigator persona. Do not write a fix. Propose ranked root causes with a probability and an ELI5 explanation for each, so Jeffrey can decide what to do next.'
        : kind === 'execute' && isBackendImplementation(item)
        ? 'Execute this self-contained backend task through the authoritative backend-engineer persona. Make authorized changes and return observed evidence and verification.'
        : `Execute this self-contained ${kind} task end to end. Use the appropriate tools, make necessary changes when authorized, and return evidence and verification.`,
  };
}

export async function classifyExecutionRobust(
  item: WorkItem,
  route: (prompt: string) => Promise<string> = async (prompt) => (await runAgentCommandWithFallback('codex', process.cwd(), prompt, undefined, undefined, undefined, 'standard')).output,
): Promise<ReturnType<typeof classifyExecution>> {
  const deterministic = classifyExecution(item);
  const explicitKind = explicitDeliverableKind(item.title);
  try {
    const output = await route(`You are the authoritative task-intent classifier for Jeffrey's engineering Workbench. Classify the deliverable he expects—not incidental verbs in the context or steps an agent may take along the way.

Kinds:
- execute: change code, configuration, documentation, design artifacts, or external state. "Implement from a spec" is execute.
- review: read-only review of an existing PR, diff, patch, or implementation whose deliverable is review findings. "Review context then implement" is execute.
- strategy: the requested deliverable itself is a plan, technical spec, RFC, proposal, decomposition, or implementation strategy.
- research: investigate unknown facts/options and return evidence or findings without making the downstream change.
- analysis: explain, summarize, organize, advise, or discuss already-available information without changing state.

Set complex=true only when the task should first be decomposed for approval because it spans multiple independently executable changes, systems, or phases. A difficult but self-contained implementation is not automatically complex.

Return exactly:
<classification>{"kind":"execute|review|strategy|research|analysis","complex":false,"reason":"one short concrete sentence"}</classification>

TITLE: ${item.title}
DESCRIPTION:
${item.description.slice(0, 12_000)}
PROJECT: ${item.projectName ?? 'none'}
SOURCE: ${item.sourceUrl ?? item.sourceIdentifier ?? item.source}`);
    const structured = output.match(/<classification>([\s\S]*?)<\/classification>/)?.[1];
    const parsed = structured ? JSON.parse(structured) as { kind?: unknown; complex?: unknown; reason?: unknown } : null;
    const kind = ((typeof parsed?.kind === 'string' ? parsed.kind.toLowerCase().match(/^(research|analysis|strategy|execute|review)$/)?.[1] : undefined)
      ?? output.toLowerCase().match(/\b(research|analysis|strategy|execute|review)\b/)?.[1]) as AgentRun['kind'] | undefined;
    if (!kind) return deterministic;
    const resolvedKind = explicitKind ?? kind;
    const complex = typeof parsed?.complex === 'boolean' ? parsed.complex : deterministic.complex;
    const explanation = typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 240) : `it chose ${resolvedKind}`;
    const reason = explicitKind && explicitKind !== kind
      ? `keyword rules: the title starts with an explicit ${explicitKind} verb, overriding the AI classifier`
      : `AI classifier: ${explanation}`;
    if (complex && resolvedKind !== 'review') {
      return {
        kind: 'strategy', agent: 'claude', complex: true,
        reason: `AI classifier: ${explanation} It is complex enough to decompose first.`,
        instructions: `WORKBENCH_DECOMPOSITION: This appears complex. Research the relevant context, then produce an approval-ready strategy. Do not implement yet. Propose at least two independently executable follow-up tasks. End with exactly one machine-readable block in this form: <workbench-plan>{"summary":"approval-ready strategy","tasks":[{"title":"first independently executable task","description":"complete context, outcome, constraints, and verification","workspacePath":null},{"title":"second independently executable task","description":"complete context, outcome, constraints, and verification","workspacePath":null}]}</workbench-plan>. Tasks must be self-contained and ordered by recommended attention.`,
      };
    }
    let agent: AgentRun['agent'] = resolvedKind === 'execute' || resolvedKind === 'review' ? 'codex' : 'claude';
    if (resolvedKind === 'execute' && isDocumentWork(item)) agent = 'claude';
    const assignedAgent = item.assignees.find((assignee): assignee is AgentRun['agent'] => assignee === 'codex' || assignee === 'claude');
    if (assignedAgent && resolvedKind !== 'review') agent = assignedAgent;
    return {
      kind: resolvedKind, agent, complex: false, reason,
      instructions: resolvedKind === 'review'
        ? 'Perform the authoritative frontend-reviewer first pass. Review only; do not modify code or execute tests.'
        : resolvedKind === 'execute' && isBackendImplementation(item)
          ? 'Execute this self-contained backend task through the authoritative backend-engineer persona. Make authorized changes and return observed evidence and verification.'
          : `Execute this self-contained ${resolvedKind} task end to end. Use the appropriate tools, make necessary changes when authorized, and return evidence and verification.`,
    };
  } catch {
    return deterministic;
  }
}
