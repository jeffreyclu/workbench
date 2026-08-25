import type { Response } from 'express';
import { z } from 'zod';
import {
  createAgentRunSchema,
  defaultAccountProfileForTask,
  isSelfAssigned,
  SELF_ASSIGNED_EXECUTION_MESSAGE,
  type sourceProviderSchema,
} from '../../shared/contracts.js';
import type { Activity, AgentRun, WorkItem } from '../../shared/contracts.js';
import type { ActionFailure } from '../action-result.js';
import { isActionFailure } from '../action-result.js';
import { cancelAgentRun, classifyExecutionRobust, executeAgentRun, resolveAgents } from '../agent-runner.js';
import { describeExecutionRouting } from '../activity-log.js';
import { contextForPrompt, listBrokerConnections } from '../connection-broker.js';
import { startManagedMcpLogin } from '../managed-mcp-login.js';
import { LinearProvider } from '../providers/linear.js';
import { startRemoteMcpOAuth } from '../remote-mcp.js';
import type { WorkItemRepository } from '../repository.js';
import type { RuntimeCapabilities } from '../runtime-capabilities.js';
import { LEASE_MS, OWNER_ID } from '../scheduler.js';
import { cancelSharedReply, dispatchNextSharedTurn } from '../shared-room.js';
import type { WorkbenchAdminActions } from '../workbench-mcp.js';
import { oauthCallbackBase } from '../app-exports.js';
import type { ArtifactService } from './artifact-service.js';
import { runDiscovery } from '../discovery.js';
import { dispatchAutonomousWork } from '../autonomous-dispatcher.js';

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
    if (this.repository.activeRunsForItem(prior.workItemId).length) return { status: 409, body: { error: 'This task already has an active agent run.' } } as ActionFailure;
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

  setFigmaScope(roots: string[]): ActionFailure | { roots: string[] } {
    const settings = this.repository.getSourceSettings('figma');
    if (!settings) return { status: 404, body: { error: 'Figma is not connected.' } };
    this.repository.setSourceConnection('figma', 'Figma MCP · Codex', { ...settings, figmaRoots: JSON.stringify(roots) });
    this.repository.setSourceConnection('figma', 'Figma MCP · Codex', { ...settings, figmaRoots: JSON.stringify(roots) });
    return { roots };
  }

  async authorizeSource(input: { provider: 'confluence' | 'slack' | 'figma' | 'gmail'; mode: 'remote' | 'managed'; serverUrl?: string }): Promise<ActionFailure | { url: string }> {
    if (input.mode === 'managed') {
      if (input.provider !== 'figma' && input.provider !== 'confluence') return { status: 400, body: { error: 'Managed authorization is available only for Figma and Atlassian.' } };
      const managedProvider = input.provider === 'confluence' ? 'atlassian' : 'figma';
      const login = await startManagedMcpLogin(managedProvider);
      const stored = input.provider === 'figma' ? { key: 'figma' as const, label: 'Figma MCP · Codex' } : { key: 'confluence' as const, label: 'Atlassian MCP · Codex' };
      void login.completion.then(() => this.repository.setSourceConnection(stored.key, stored.label, { mode: 'managed' })).catch(() => undefined);
      return { url: login.url };
    }
    const defaultUrl = input.provider === 'confluence' ? 'https://mcp.atlassian.com/v1/mcp/authv2'
      : input.provider === 'slack' ? 'https://mcp.slack.com/mcp'
        : input.provider === 'figma' ? 'https://mcp.figma.com/mcp' : null;
    if (!input.serverUrl && !defaultUrl) return { status: 400, body: { error: 'serverUrl is required for Gmail authorization.' } };
    return { url: await startRemoteMcpOAuth(input.provider, input.serverUrl ?? defaultUrl!, oauthCallbackBase()) };
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

  async dispatchAutonomousWork() {
    if (!this.capabilities.executeAgents) return { status: 409, body: { error: 'This runtime does not execute agents.' } } as ActionFailure;
    const result = dispatchAutonomousWork(this.repository);
    if (!result.dispatched) return { status: 409, body: result };
    // Leave the run queued. The scheduler is the sole process dispatcher, so
    // autonomous and recovered work follow the same durable lease path.
    return result;
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
        const reply = this.repository.createSharedMessage('system', 'Promotion queued. It will build once active agent work reaches a durable terminal state.', 'queued', conversationId, [], 'promotion');
        return { message: reply };
      },
      listSourceConnections: this.listSourceConnections,
      authorizeSource: (input) => this.authorizeSource(input),
      setFigmaScope: (roots) => this.setFigmaScope(roots),
      disconnectSource: (provider, actor) => this.disconnectSource(provider, actor),
      getLinearProvider: (teamId) => this.getLinearProvider(teamId),
      syncLinearProvider: () => this.syncLinearProvider(),
      configureLinearProvider: (teamIds, projectIds) => this.configureLinearProvider(teamIds, projectIds),
      queueLinearWorkItem: (workItemId) => this.queueLinearWorkItem(workItemId),
    };
  }
}
