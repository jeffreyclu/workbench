/**
 * Backward-compatible client facade. Feature code should import its domain client
 * from `data/`; existing consumers may continue to use this complete API object.
 */
import { artifactClient } from './data/artifact-client';
import { conversationClient } from './data/conversation-client';
import { discoveryClient } from './data/discovery-client';
import { insightsClient } from './data/insights-client';
import { queueClient } from './data/queue-client';
import { runtimeClient } from './data/runtime-client';
import { sourceClient } from './data/source-client';
import { taskClient } from './data/task-client';

export type { QueuePlan } from './data/queue-client';

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
