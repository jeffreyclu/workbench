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

export function useTaskAccountProfile(taskId: string) {
  const key = `workbench.task-account-profile.${taskId}`;
  const [accountProfile, setAccountProfileState] = useState(() => localStorage.getItem(key) ?? 'default');
  const setAccountProfile = (value: string) => {
    const profile = value.trim() || 'default';
    setAccountProfileState(profile);
    localStorage.setItem(key, profile);
  };
  return { accountProfile, setAccountProfile };
}
