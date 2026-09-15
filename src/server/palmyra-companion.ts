import type { AgentRun } from '../shared/contracts.js';

export function palmyraCompanionEnabled(): boolean {
  return !process.env.VITEST || process.env.WORKBENCH_TEST_PALMYRA_COMPANION === 'true';
}

export function withPalmyraCompanion(agents: AgentRun['agent'][], enabled = palmyraCompanionEnabled()): AgentRun['agent'][] {
  return enabled && !agents.includes('palmyra') ? [...agents, 'palmyra'] : agents;
}
