import { useState } from 'react';
import type { AgentRun } from '../../../shared/contracts';
import { readTaskModelProfiles, writeTaskModelProfile } from '../../preferences';

export function useTaskExecutionProfile(taskId: string) {
  const [executionProfile, setExecutionProfileState] = useState<AgentRun['executionProfile']>(() => readTaskModelProfiles()[taskId] ?? null);
  const setExecutionProfile = (profile: AgentRun['executionProfile']) => {
    setExecutionProfileState(profile);
    writeTaskModelProfile(taskId, profile);
  };
  return { executionProfile, setExecutionProfile };
}
