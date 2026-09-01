import type { Response } from 'express';
import { z } from 'zod';
import {
  createAgentRunSchema,
  defaultAccountProfileForTask,
  isSelfAssigned,
  SELF_ASSIGNED_EXECUTION_MESSAGE,
  type sourceProviderSchema,
  grafanaConnectionSchema,
  type BrokerSourceId,
} from '../../shared/contracts.js';
import type { Activity, AgentRun, WorkItem } from '../../shared/contracts.js';
import type { ActionFailure } from '../action-result.js';
import { isActionFailure } from '../action-result.js';
import { CANCEL_FORCE_KILL_DELAY_MS, cancelAgentRun, classifyExecutionRobust, executeAgentRun, resolveAgents } from '../agent-runner.js';
import { describeExecutionRouting } from '../activity-log.js';
import { contextForPrompt, listBrokerConnections, resolveBrokerUrl, searchBrokerSources } from '../connection-broker.js';
import { scanSource } from '../source-scanner.js';
import { LinearProvider } from '../providers/linear.js';
import { importSupportedMcpCredentials, startRemoteMcpOAuth, verifyRemoteMcpCredentials } from '../remote-mcp.js';
import type { WorkItemRepository } from '../repository.js';
import type { RuntimeCapabilities } from '../runtime-capabilities.js';
import { LEASE_MS, OWNER_ID } from '../scheduler.js';
import { cancelSharedReply, dispatchNextSharedTurn } from '../shared-room.js';
import type { WorkbenchAdminActions } from '../workbench-mcp.js';
import { oauthCallbackBase } from '../app-exports.js';
import type { ArtifactService } from './artifact-service.js';
import { runDiscovery } from '../discovery.js';

function selfAssignedFailure(item: WorkItem, force: boolean): ActionFailure | null {
  if (force || !isSelfAssigned(item.assignees)) return null;
  return { status: 409, body: { error: SELF_ASSIGNED_EXECUTION_MESSAGE, code: 'SELF_ASSIGNED' } };
}

function openPrerequisiteFailure(repository: WorkItemRepository, workItemId: string, force: boolean): ActionFailure | null {
  if (force) return null;
  const blockedBy = repository.listOpenDependencies(workItemId);
  if (!blockedBy.length) return null;
  return { status: 409, body: { error: 'Task is blocked by open prerequisites.', code: 'OPEN_PREREQUISITES', blockedBy } };
}

// Must clear the Stop escalation delay (SIGTERM -> SIGKILL) with real margin for
// the kill signal to land, the child's `close` event to fire, and the
// cancellation commit write to land — not just edge past it.
const CANCELLATION_SETTLE_TIMEOUT_MS = CANCEL_FORCE_KILL_DELAY_MS + 5_000;

async function waitForCancellationToSettle(repository: WorkItemRepository, runId: string): Promise<boolean> {
  const deadline = Date.now() + CANCELLATION_SETTLE_TIMEOUT_MS;
  while (repository.isRunCancellationSettling(runId)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export class WorkbenchAdminService {
  constructor(
    readonly repository: WorkItemRepository,
    readonly capabilities: RuntimeCapabilities,
    readonly artifacts: ArtifactService,
  ) {}

  sourceContextFor = (item: WorkItem) => contextForPrompt(
    this.repository,
    [item.title, item.description, item.sourceUrl, ...this.repository.listReferences(item.id).map((reference) => reference.url)].filter(Boolean).join('\n'),
  );

  async startAgentRun(
    workItemId: string,
    input: z.infer<typeof createAgentRunSchema>,
    options: { actor: Activity['actor']; force: boolean },
  ): Promise<ActionFailure | { runs: AgentRun[] }> {
    const item = this.repository.get(workItemId);
    if (!item) return { status: 404, body: { error: 'Work item not found.' } };
    const refused = selfAssignedFailure(item, options.force) ?? openPrerequisiteFailure(this.repository, item.id, options.force);
    if (refused) return refused;
    if (this.repository.activeRunsForItem(item.id).length) return { status: 409, body: { error: 'This task already has an active agent run.' } };
    const conversation = this.repository.getOrCreateWorkConversation(item.id, item.title);
    this.repository.createSharedMessage('system', `Requested ${input.kind}: ${input.instructions || item.description}`, 'completed', conversation.id);
    const resolvedAgents = resolveAgents(input.kind, input.target);
    const agents = input.target === 'auto' ? [this.repository.selectBalancedAgent(resolvedAgents[0])] : resolvedAgents;
    const accountProfile = input.accountProfile ?? defaultAccountProfileForTask(item);
    const runs = agents.map((agent) => {
      const reply = this.repository.createSharedMessage(agent, '', 'running', conversation.id);
      const run = this.repository.createRun(item.id, input.kind, input.target, agent, input.instructions, conversation.id, reply.id, 'manual', accountProfile);
      if (!input.executionProfile) return run;
      this.repository.updateRun(run.id, { executionProfile: input.executionProfile });
      this.repository.updateSharedMessage(reply.id, { executionProfile: input.executionProfile });
      return { ...run, executionProfile: input.executionProfile };
    });
    this.repository.addActivity(item.id, options.actor, 'execution_started', describeExecutionRouting({
      kind: input.kind,
      agents,
      reason: 'you asked for this run type',
      agentSource: input.target === 'auto' ? 'balanced' : 'assigned',
      requestedProfile: input.executionProfile,
    }));
    // Persist the task lifecycle transition before yielding to the background
    // runner. The runner can be delayed by workspace contention or process
    // scheduling, but the task is already executing from the user's point of
    // view as soon as this request creates its run.
    this.repository.update(item.id, { status: 'in_progress' }, false, { actor: 'system', source: 'workbench_admin' });
    const sourceContext = await this.sourceContextFor(item);
    for (const run of runs) void executeAgentRun(this.repository, run, OWNER_ID, LEASE_MS, sourceContext);
    return { runs };
  }

  cancelRun(runId: string): ActionFailure | { run: AgentRun } {
    const run = cancelAgentRun(this.repository, runId);
    if (!run) return { status: 404, body: { error: 'Active agent run not found.' } };
    return { run };
  }

  async retryRun(runId: string, options: { force: boolean }) {
    const prior = this.repository.getRun(runId);
    if (!prior) return { status: 404, body: { error: 'Agent run not found.' } } as ActionFailure;
    if (prior.status !== 'failed' && prior.status !== 'canceled') return { status: 409, body: { error: 'Only failed or canceled runs can be retried.' } } as ActionFailure;
    // Cancel returns to the UI immediately, but the provider process needs a
    // moment to receive SIGTERM and release its durable lease. Retrying the
    // same row before that happens lets two processes write as one attempt.
    if (prior.status === 'canceled' && !await waitForCancellationToSettle(this.repository, prior.id)) {
      return { status: 409, body: { error: 'The canceled agent is still stopping. Try again in a moment.' } } as ActionFailure;
    }
    // Scoped to this run's own agent: a task can legitimately have two active
    // threads (Codex + Claude) at once, and retrying one failed/canceled
    // thread must not be blocked by its sibling's unrelated active run.
    if (this.repository.activeRunsForItem(prior.workItemId).some((run) => run.agent === prior.agent)) {
      return { status: 409, body: { error: 'This task already has an active agent run.' } } as ActionFailure;
    }
    const item = this.repository.get(prior.workItemId);
    if (!item) return { status: 404, body: { error: 'Work item not found.' } } as ActionFailure;
    const refused = selfAssignedFailure(item, options.force) ?? openPrerequisiteFailure(this.repository, item.id, options.force);
    if (refused) return refused;
    const conversation = prior.conversationId
      ? this.repository.listConversations('all').find((entry) => entry.id === prior.conversationId) ?? this.repository.getOrCreateWorkConversation(item.id, item.title)
      : this.repository.getOrCreateWorkConversation(item.id, item.title);
    const run = this.repository.prepareRunRetry(prior.id);
    if (!run) return { status: 409, body: { error: 'This run is no longer retryable.' } } as ActionFailure;
    this.repository.update(item.id, { status: 'in_progress' }, false, { actor: 'system', source: 'workbench_admin' });
    const activity = this.repository.addActivity(item.id, 'system', 'execution_retried', `Retrying ${prior.agent} ${prior.kind} after the prior attempt ${prior.status}.`);
    const sourceContext = await this.sourceContextFor(item);
    void executeAgentRun(this.repository, run, OWNER_ID, LEASE_MS, sourceContext);
    return { run, conversation, activity };
  }

  async startWorkItemExecution(workItemId: string, options: { executionProfile: AgentRun['executionProfile']; accountProfile?: string; force: boolean }) {
    const item = this.repository.get(workItemId);
    if (!item) return { status: 404, body: { error: 'Work item not found.' } } as ActionFailure;
    if (!options.force && (item.archivedAt || item.status === 'done' || item.status === 'canceled')) return { status: 409, body: { error: 'Archived or completed tasks cannot be executed. Restore the task first.' } } as ActionFailure;
    const refused = selfAssignedFailure(item, options.force) ?? openPrerequisiteFailure(this.repository, item.id, options.force);
    if (refused) return refused;
    if (this.repository.activeRunsForItem(item.id).length) return { status: 409, body: { error: 'This task already has an active agent run.' } } as ActionFailure;
    if (!options.force && this.repository.listRuns(item.id).length) return { status: 409, body: { error: 'This task has already been executed. Create a follow-up task for additional work.' } } as ActionFailure;
    // Flip to in_progress before the classification await below, which can be
    // a slow LLM call. A concurrent, unrelated realtime invalidation (e.g. a
    // different run finishing) that lands during that wait would otherwise
    // refetch this item's still-pre-dispatch status and visibly bounce it back
    // to the attention stack until this request finally completes.
    this.repository.update(item.id, { status: 'in_progress' }, false, { actor: 'system', source: 'workbench_admin' });
    const executionProfile = options.executionProfile;
    let classified = this.repository.getClassification(item.id);
    let classificationReason = classified?.source === 'manual' ? 'you picked this task type by hand' : 'reused the classification from the first routing pass';
    if (!classified) {
      const fresh = await classifyExecutionRobust(item);
      classificationReason = fresh.reason;
      classified = this.repository.setClassification(item.id, fresh);
    }
    const explicitlyAssigned = this.repository.getExplicitAgentAssignees(item.id);
    const agents = explicitlyAssigned.length ? explicitlyAssigned : [this.repository.selectBalancedAgent(classified.agent)];
    const classification = { ...classified, agent: agents[0] };
    if (!explicitlyAssigned.length) this.repository.updateAutomaticAgentAssignees(item.id, agents);
    let conversation = this.repository.getOrCreateWorkConversation(item.id, item.title);
    conversation = this.repository.setConversationExecutionProfile(conversation.id, executionProfile) ?? conversation;
    // The execution router has already made the agent decision at this point.
    // Persist that result on the conversation regardless of whether it came
    // from an explicit assignee or automatic balancing, so opening the newly
    // executed task hydrates the composer with the agent actually running it
    // instead of treating a null preference as the manual-conversation "Both"
    // default.
    const dispatchTarget = agents.length > 1 ? 'both' : agents[0];
    conversation = this.repository.setConversationComposerPreferences(conversation.id, {
      preferredDispatchTarget: dispatchTarget,
    }) ?? conversation;
    this.repository.createSharedMessage('system', `Execute: ${item.title}`, 'completed', conversation.id);
    const accountProfile = options.accountProfile ?? defaultAccountProfileForTask(item);
    const runs = agents.map((agent) => {
      const reply = this.repository.createSharedMessage(agent, '', 'running', conversation.id);
      const run = this.repository.createRun(item.id, classification.kind, explicitlyAssigned.length ? agent : 'auto', agent, classification.instructions, conversation.id, reply.id, 'manual', accountProfile);
      if (!executionProfile) return run;
      this.repository.updateRun(run.id, { executionProfile });
      this.repository.updateSharedMessage(reply.id, { executionProfile });
      return { ...run, executionProfile };
    });
    const activity = this.repository.addActivity(item.id, 'system', 'execution_started', describeExecutionRouting({
      kind: classification.kind,
      agents,
      reason: classificationReason,
      agentSource: explicitlyAssigned.length ? 'assigned' : 'balanced',
      requestedProfile: executionProfile,
    }));
    const sourceContext = await this.sourceContextFor(item);
    for (const run of runs) void executeAgentRun(this.repository, run, OWNER_ID, LEASE_MS, sourceContext);
    return { run: runs[0], runs, classification, conversation, activity };
  }

  resolvePlan(planId: string, resolution: 'accepted' | 'rejected', selectedTaskIndexes?: number[], archiveParent = false) {
    const plan = this.repository.resolveExecutionPlan(planId, resolution, selectedTaskIndexes, archiveParent);
    if (!plan) return { status: 404, body: { error: 'Pending execution plan not found.' } } as ActionFailure;
    if (resolution === 'accepted') {
      for (const run of this.repository.activeRunsForItem(plan.workItemId)) cancelAgentRun(this.repository, run.id);
      for (const conversation of this.repository.listConversationsForWorkItem(plan.workItemId)) {
        for (const message of this.repository.listAllSharedMessages(conversation.id)) {
          if (message.status === 'queued' || message.status === 'running') cancelSharedReply(this.repository, message.id);
        }
      }
    }
    return { plan, items: this.repository.list(), parentArchived: resolution === 'accepted' && archiveParent };
  }

  listSourceConnections = () => ({ connections: listBrokerConnections(this.repository) });

  searchExternalSources = (query: string, sources: BrokerSourceId[]) => searchBrokerSources(this.repository, query, sources);

  resolveExternalSource = (url: string) => resolveBrokerUrl(this.repository, url);

  setFigmaScope(roots: string[]): ActionFailure | { roots: string[] } {
    const settings = this.repository.getSourceSettings('figma');
    if (!settings) return { status: 404, body: { error: 'Figma is not connected.' } };
    this.repository.setSourceConnection('figma', 'Figma MCP · Workbench', { ...settings, figmaRoots: JSON.stringify(roots) });
    return { roots };
  }

  async configureGrafana(input: z.infer<typeof grafanaConnectionSchema>): Promise<{ configured: true }> {
    const settings = { token: input.token };
    await scanSource('grafana', settings);
    this.repository.setSourceConnection('grafana', 'Writer Grafana', settings);
    return { configured: true };
  }

  async authorizeSource(input: { provider: 'confluence' | 'slack' | 'figma' | 'grafana' | 'gmail'; serverUrl?: string }): Promise<ActionFailure | { url: string } | { connected: true }> {
    if (input.provider === 'grafana') return { status: 400, body: { error: 'Add the Grafana service-account token in Sources.' } };
    const defaultUrl = input.provider === 'confluence' ? 'https://mcp.atlassian.com/v1/mcp/authv2'
      : input.provider === 'slack' ? 'https://mcp.slack.com/mcp'
        : input.provider === 'figma' ? 'https://mcp.figma.com/mcp' : null;
    if (!input.serverUrl && !defaultUrl) return { status: 400, body: { error: 'serverUrl is required for Gmail authorization.' } };
    const serverUrl = input.serverUrl ?? defaultUrl!;
    const imported = importSupportedMcpCredentials(serverUrl);
    if (imported) {
      try {
        const verified = await verifyRemoteMcpCredentials(input.provider, imported);
        const previous = this.repository.getSourceSettings(input.provider);
        const label = input.provider === 'confluence' ? 'Atlassian MCP · Workbench'
          : input.provider === 'figma' ? 'Figma MCP · Workbench'
            : input.provider === 'slack' ? 'Slack MCP · Workbench' : 'Google Workspace MCP · Workbench';
        this.repository.setSourceConnection(input.provider, label, {
          ...verified,
          ...(input.provider === 'figma' && previous?.figmaRoots ? { figmaRoots: previous.figmaRoots } : {}),
        } as unknown as Record<string, string>);
        return { connected: true };
      } catch { /* The supported client credential is stale; use the provider's own OAuth flow. */ }
    }
    return { url: await startRemoteMcpOAuth(input.provider, serverUrl, oauthCallbackBase()) };
  }

  disconnectSource(provider: z.infer<typeof sourceProviderSchema>, actor: 'codex' | 'claude' | 'jeffrey' = 'jeffrey') {
    if (!this.repository.removeSourceConnection(provider)) return { status: 404, body: { error: 'Source connection not found.' } } as ActionFailure;
    this.repository.addAuditEntry('destructive_action', 'workbench', `Removed source connection ${provider} (${actor})`);
    return { disconnected: true, provider };
  }

  private linearProvider() {
    return new LinearProvider(process.env.LINEAR_API_KEY ?? '', this.repository.getLinearConfig().teamIds, this.repository.getLinearConfig().projectIds);
  }

  async syncLinearProvider() {
    const issues = await this.linearProvider().fetchOpenIssues();
    const counts = { imported: 0, updated: 0, skipped: 0, conflicts: 0 };
    const conflictsBefore = this.repository.countProviderConflicts();
    for (const outcome of this.repository.upsertLinearItems(issues)) counts[outcome] += 1;
    counts.conflicts = this.repository.countProviderConflicts() - conflictsBefore;
    return { ...counts, syncedAt: new Date().toISOString() };
  }

  async getLinearProvider(teamId?: string) {
    const provider = this.linearProvider();
    return teamId
      ? { config: this.repository.getLinearConfig(), teamId, projects: await provider.fetchTeamProjects(teamId) }
      : { config: this.repository.getLinearConfig(), teams: await provider.fetchTeams() };
  }

  configureLinearProvider(teamIds: string[], projectIds: string[]) {
    return { config: this.repository.setLinearConfig({ teamIds, projectIds }) };
  }

  queueLinearWorkItem(workItemId: string) {
    const item = this.repository.queueLinearItem(workItemId);
    return item ? { item } : { status: 404, body: { error: 'Linear issue not found.' } } as ActionFailure;
  }

  async updateLinearIssue(identifier: string, input: { title?: string; description?: string }) {
    const issue = await this.linearProvider().updateIssue(identifier, input);
    this.repository.upsertLinearItem(issue);
    this.repository.addAuditEntry('external_action', 'linear', `Updated Linear issue ${identifier}`);
    return { issue };
  }

  sendAction(response: Response, result: unknown, status = 202) {
    return isActionFailure(result) ? response.status(result.status).json(result.body) : response.status(status).json(result);
  }

  mcpActions(): WorkbenchAdminActions {
    return {
      startWorkItemExecution: (workItemId, options) => this.startWorkItemExecution(workItemId, { ...options, force: true }),
      startAgentRun: (workItemId, input, options) => this.startAgentRun(workItemId, input as z.infer<typeof createAgentRunSchema>, { ...options, force: true }),
      cancelRun: (runId) => this.cancelRun(runId),
      retryRun: (runId, options) => this.retryRun(runId, { ...options, force: true }),
      resolvePlan: (planId, resolution, selectedTaskIndexes, archiveParent) => this.resolvePlan(planId, resolution, selectedTaskIndexes, archiveParent),
      deleteWorkItem: (workItemId, actor) => {
        if (!this.repository.delete(workItemId)) return { status: 404, body: { error: 'Work item not found.' } };
        this.repository.addAuditEntry('destructive_action', 'workbench', `Deleted work item ${workItemId} (${actor})`, workItemId);
        return { deleted: true, workItemId };
      },
      deleteConversation: (conversationId, actor) => {
        if (!this.repository.deleteConversation(conversationId)) return { status: 404, body: { error: 'Conversation not found.' } };
        this.repository.addAuditEntry('destructive_action', 'workbench', `Deleted conversation ${conversationId} (${actor})`, null);
        return { deleted: true, conversationId };
      },
      dispatchConversationTurn: (conversationId, actor, body, dispatchTo, executionProfile) => {
        if (!this.repository.getConversation(conversationId)) return { status: 404, body: { error: 'Conversation not found.' } };
        if (!this.capabilities.executeAgents) return { status: 409, body: { error: 'This runtime does not execute agents.' } };
        if (dispatchTo !== 'none') this.repository.unpinConversationAndLinkedItem(conversationId);
        const message = this.repository.createSharedMessage(actor, body, dispatchTo === 'none' ? 'completed' : 'queued', conversationId, [], dispatchTo, executionProfile ?? null);
        const replies = dispatchTo === 'none' ? [] : dispatchNextSharedTurn(this.repository, conversationId);
        return { message, replies };
      },
      cancelSharedMessage: (messageId) => {
        const message = cancelSharedReply(this.repository, messageId);
        if (!message) return { status: 404, body: { error: 'Running or queued message not found.' } };
        return { message };
      },
      publishArtifact: (input) => this.artifacts.publishFromInput(input),
      listArtifacts: (view) => ({ artifacts: this.artifacts.library.list(view), counts: this.artifacts.library.counts() }),
      revokeArtifact: (artifactId) => this.artifacts.revoke(artifactId),
      runDiscoveryScan: async () => {
        if (this.repository.getDiscoveryInbox().running) return { status: 409, body: { error: 'A discovery scan is already running.' } };
        await runDiscovery(this.repository);
        return this.repository.getDiscoveryInbox('pending');
      },
      promoteRuntime: (conversationId) => {
        if (!this.repository.getConversation(conversationId)) return { status: 404, body: { error: 'Conversation not found.' } };
        const reply = this.repository.queueRuntimePromotion(conversationId);
        return { message: reply };
      },
      listSourceConnections: this.listSourceConnections,
      searchExternalSources: this.searchExternalSources,
      resolveExternalSource: this.resolveExternalSource,
      authorizeSource: (input) => this.authorizeSource(input),
      setFigmaScope: (roots) => this.setFigmaScope(roots),
      disconnectSource: (provider, actor) => this.disconnectSource(provider, actor),
      getLinearProvider: (teamId) => this.getLinearProvider(teamId),
      syncLinearProvider: () => this.syncLinearProvider(),
      configureLinearProvider: (teamIds, projectIds) => this.configureLinearProvider(teamIds, projectIds),
      queueLinearWorkItem: (workItemId) => this.queueLinearWorkItem(workItemId),
      updateLinearIssue: (identifier, input) => this.updateLinearIssue(identifier, input),
    };
  }
}
