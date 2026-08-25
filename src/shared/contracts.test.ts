import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_PROFILE, PERSONAL_ACCOUNT_PROFILE, defaultAccountProfileForTask } from './contracts.js';

describe('defaultAccountProfileForTask', () => {
  it('uses personal only for Workbench and Pluto tasks', () => {
    expect(defaultAccountProfileForTask({ projectName: 'Workbench', workspacePath: null })).toBe(PERSONAL_ACCOUNT_PROFILE);
    expect(defaultAccountProfileForTask({ projectName: 'Pluto', workspacePath: null })).toBe(PERSONAL_ACCOUNT_PROFILE);
    expect(defaultAccountProfileForTask({ projectName: null, workspacePath: '/Users/jeffrey.lu/dev/Pluto-Alpha' })).toBe(PERSONAL_ACCOUNT_PROFILE);
  });

  it('leaves every other task on the provider CLI default account', () => {
    expect(defaultAccountProfileForTask({ projectName: 'Connectors', workspacePath: '/Users/jeffrey.lu/dev/writer-monorepo' })).toBe(DEFAULT_ACCOUNT_PROFILE);
    expect(defaultAccountProfileForTask({ projectName: null, workspacePath: null })).toBe(DEFAULT_ACCOUNT_PROFILE);
  });
});
