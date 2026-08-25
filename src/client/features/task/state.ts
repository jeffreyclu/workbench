import { useEffect, useState } from 'react';
import { DEFAULT_ACCOUNT_PROFILE, defaultAccountProfileForTask, type AgentRun, type WorkItem } from '../../../shared/contracts';
import { readTaskModelProfiles, writeTaskModelProfile } from '../../preferences';

export function useTaskExecutionProfile(taskId: string) {
  const [executionProfile, setExecutionProfileState] = useState<AgentRun['executionProfile']>(() => readTaskModelProfiles()[taskId] ?? null);
  const setExecutionProfile = (profile: AgentRun['executionProfile']) => {
    setExecutionProfileState(profile);
    writeTaskModelProfile(taskId, profile);
  };
  return { executionProfile, setExecutionProfile };
}

export function useTaskAccountProfile(taskId: string, task: Pick<WorkItem, 'projectName' | 'workspacePath'> | null | undefined) {
  const key = `workbench.task-account-profile.${taskId}`;
  const defaultProfile = task ? defaultAccountProfileForTask(task) : DEFAULT_ACCOUNT_PROFILE;
  const [accountProfile, setAccountProfileState] = useState(() => localStorage.getItem(key) ?? defaultProfile);
  useEffect(() => {
    if (!localStorage.getItem(key)) setAccountProfileState(defaultProfile);
  }, [defaultProfile, key]);
  const setAccountProfile = (value: string) => {
    const profile = value.trim() || defaultProfile;
    setAccountProfileState(profile);
    localStorage.setItem(key, profile);
  };
  return { accountProfile, setAccountProfile };
}
