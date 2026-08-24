import { describe, expect, it } from 'vitest';
import { isWorkbenchProject, matchProjectKey, projectKey, WORKBENCH_PROJECT_KEY } from './project-name.js';

/**
 * A slice of the real project vocabulary, including the short names and the
 * near-neighbours that make aggressive matching dangerous. Cases are written
 * against these rather than invented pairs, because the whole point of the
 * thresholds is that they hold on Jeffrey's actual projects.
 */
const VOCABULARY = [
  'Workbench', 'Connectors', 'Connector enhancements', 'Connectors UI Revamp', 'MCP', 'WDS', 'Pluto',
  'Networking', 'Notifications', 'Onboarding', 'Engineering', 'Testing', 'Team', 'Cloud Engineering',
  'Enterprise Brain', 'Enterprise Brain Core', 'Enterprise Brain Debugging', 'Product Polish',
].map(projectKey);

describe('projectKey', () => {
  it('folds away the differences that never mean a different project', () => {
    const same = ['Workbench', 'workbench', 'WORKBENCH', ' Work Bench ', 'work-bench', 'work_bench', 'Work.Bench'];
    expect(new Set(same.map(projectKey))).toEqual(new Set([WORKBENCH_PROJECT_KEY]));
  });

  it('keeps genuinely different names apart', () => {
    expect(projectKey('Enterprise Brain')).not.toBe(projectKey('Enterprise Brain Core'));
  });

  it('returns an empty key for names with no alphanumeric content', () => {
    expect(projectKey('—')).toBe('');
    expect(projectKey('   ')).toBe('');
    expect(projectKey(null)).toBe('');
    expect(projectKey(undefined)).toBe('');
  });

  it('strips accents so the same name typed two ways is one project', () => {
    expect(projectKey('Résumé')).toBe(projectKey('Resume'));
  });
});

describe('isWorkbenchProject', () => {
  it('recognises every spelling of the project that selects the Workbench stack', () => {
    for (const name of ['Workbench', 'workbench', 'WORKBENCH', 'work bench']) {
      expect(isWorkbenchProject(name)).toBe(true);
    }
  });

  it('rejects a different project and no project at all', () => {
    expect(isWorkbenchProject('Connectors')).toBe(false);
    expect(isWorkbenchProject(null)).toBe(false);
  });
});

describe('matchProjectKey', () => {
  it('resolves the typos that produce duplicate projects', () => {
    const cases: Array<[string, string]> = [
      ['wokrbench', 'Workbench'],
      ['workbnech', 'Workbench'],
      ['conectors', 'Connectors'],
      ['Connecters', 'Connectors'],
      ['Netwroking', 'Networking'],
      ['Testng', 'Testing'],
    ];
    for (const [typed, expected] of cases) {
      expect(matchProjectKey(projectKey(typed), VOCABULARY)).toBe(projectKey(expected));
    }
  });

  it('resolves a dropped-vowel abbreviation to the project it stands for', () => {
    expect(matchProjectKey(projectKey('wkbnch'), VOCABULARY)).toBe(WORKBENCH_PROJECT_KEY);
  });

  it('never merges two real projects in the vocabulary', () => {
    for (const key of VOCABULARY) {
      const others = VOCABULARY.filter((candidate) => candidate !== key);
      expect(matchProjectKey(key, others)).toBeNull();
    }
  });

  it('refuses to guess for short names, where one edit is a different project', () => {
    expect(matchProjectKey(projectKey('MCQ'), VOCABULARY)).toBeNull();
    expect(matchProjectKey(projectKey('WDX'), VOCABULARY)).toBeNull();
    expect(matchProjectKey(projectKey('Teem'), VOCABULARY)).toBeNull();
  });

  it('creates a new project rather than pick between equally close candidates', () => {
    // One edit from both `Testing` and `Nesting`, so there is no right answer.
    expect(matchProjectKey('nesting', ['testing', 'resting'])).toBeNull();
  });

  it('returns an exact key unchanged and ignores an empty one', () => {
    expect(matchProjectKey(WORKBENCH_PROJECT_KEY, VOCABULARY)).toBe(WORKBENCH_PROJECT_KEY);
    expect(matchProjectKey('', VOCABULARY)).toBeNull();
  });

  it('leaves an unrelated new name alone', () => {
    expect(matchProjectKey(projectKey('Quarterly planning'), VOCABULARY)).toBeNull();
  });
});
