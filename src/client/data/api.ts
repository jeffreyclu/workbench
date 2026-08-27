/**
 * Backward-compatible client facade. Feature code should import its domain client
 * from `data/`; existing consumers may continue to use this complete API object.
 */
import { artifactClient } from './artifact-client';
import { conversationClient } from './conversation-client';
import { discoveryClient } from './discovery-client';
import { insightsClient } from './insights-client';
import { queueClient } from './queue-client';
import { runtimeClient } from './runtime-client';
import { sourceClient } from './source-client';
import { taskClient } from './task-client';

export type { QueuePlan } from './queue-client';

export const api = {
  ...runtimeClient,
  ...discoveryClient,
  ...insightsClient,
  ...artifactClient,
  ...taskClient,
  ...queueClient,
  ...sourceClient,
  ...conversationClient,
};
