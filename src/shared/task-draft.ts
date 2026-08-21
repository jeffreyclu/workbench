import type { GeneratedTaskDraft } from './contracts.js';

const IMPERATIVE = /^(?:add|analyze|archive|automate|build|change|clean|complete|configure|connect|convert|create|debug|delete|deploy|describe|design|disable|document|edit|enable|evaluate|explain|explore|finish|fix|implement|improve|install|investigate|migrate|move|optimize|plan|publish|reclassify|reduce|refactor|remove|rename|replace|research|restore|review|rewrite|scope|search|set|summarize|test|trim|update|upgrade|verify|wire|write)\b/i;
const FAILURE = /\b(?:bug|broken|crash|error|fail(?:ed|ing|s)?|incorrect|not working|regression|stuck)\b/i;

function titleCaseAction(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function fastTaskDraft(rawPrompt: string): GeneratedTaskDraft {
  const prompt = rawPrompt.trim().replace(/\r\n?/g, '\n');
  const firstThought = prompt.split('\n').find((line) => line.trim())!.trim();
  let candidate = firstThought
    .replace(/^(?:hey[,!]?\s*)?(?:please\s+)?/i, '')
    .replace(/^(?:i\s+(?:really\s+)?(?:need|want)\s+(?:you\s+)?to|we\s+(?:really\s+)?need\s+to|(?:need|want)\s+to|can\s+you|could\s+you|would\s+you)\s+/i, '')
    .replace(/^task\s*:\s*/i, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();

  if (FAILURE.test(prompt)) candidate = candidate.replace(/^there(?:'s| is)\s+(?:a\s+)?(?:major\s+)?(?:bug|issue|problem)(?:\s+where|\s+with|\s+that)?\s*/i, '');
  if (!IMPERATIVE.test(candidate)) {
    candidate = `${FAILURE.test(prompt) ? 'Fix' : /\b(?:why|how|whether)\b/i.test(candidate) ? 'Investigate' : 'Implement'} ${candidate}`;
  }

  const unclippedTitle = titleCaseAction(candidate || 'Implement the requested task');
  const title = unclippedTitle.length <= 140 ? unclippedTitle : `${unclippedTitle.slice(0, 137).trimEnd()}…`;
  return {
    title,
    description: prompt,
    projectName: null,
    workspacePath: null,
  };
}
