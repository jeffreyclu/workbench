export type RuntimeMode = 'live' | 'preview';

/**
 * Runtime responsibilities are opt-in. Preview exercises candidate source
 * against the live local state, including normal user and agent actions, but
 * never owns background scheduling or promotion execution. A preview promotion
 * request is durable and the live worker claims it.
 */
export interface RuntimeCapabilities {
  mode: RuntimeMode;
  allowMutations: boolean;
  runDiscoveryCatchUp: boolean;
  ownScheduler: boolean;
  promoteRuntime: boolean;
  executeAgents: boolean;
}

export const liveRuntimeCapabilities: RuntimeCapabilities = {
  mode: 'live',
  allowMutations: true,
  runDiscoveryCatchUp: true,
  ownScheduler: true,
  promoteRuntime: true,
  executeAgents: true,
};

export const previewRuntimeCapabilities: RuntimeCapabilities = {
  mode: 'preview',
  allowMutations: true,
  runDiscoveryCatchUp: false,
  ownScheduler: false,
  promoteRuntime: false,
  executeAgents: true,
};

/** Backs the Playwright e2e server: an isolated database with no background work or agent dispatch. */
export const e2eRuntimeCapabilities: RuntimeCapabilities = {
  mode: 'preview',
  allowMutations: true,
  runDiscoveryCatchUp: false,
  ownScheduler: false,
  promoteRuntime: false,
  executeAgents: false,
};
