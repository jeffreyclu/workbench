import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ObservedRunEvent } from './review-handoff.js';

/** A run that wrote no files and used fewer tools than this is chatter, not history. */
export const WORK_LOG_MIN_TOOL_USES = 8;

const WORK_LOG_HEADER = '# Work log\n\nAppend-only chronology of completed runs, written by Workbench on run completion. Never edit existing lines.\n\n';

export interface WorkLogRun {
  id: string;
  kind: string;
  workItemId: string;
}

export function workLogPath(docsRoot = resolve(process.cwd(), 'docs')): string {
  return resolve(docsRoot, 'work-log.md');
}

/** Non-trivial = wrote at least one file, or used at least eight tools. */
export function isNonTrivialRun(events: ObservedRunEvent[]): boolean {
  if (events.some((event) => event.category === 'agent_file_write')) return true;
  return events.filter((event) => event.category === 'agent_tool_use').length >= WORK_LOG_MIN_TOOL_USES;
}

export function formatWorkLogLine(input: { date: string; run: WorkLogRun; repoPath: string | null; summary: string; output: string }): string {
  const repo = input.repoPath ? basename(input.repoPath.replace(/\/+$/, '')) : 'unknown';
  const summary = input.summary.replace(/\s+/g, ' ').trim() || `Completed ${input.run.kind} run.`;
  const pr = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(input.output)?.[1];
  return `## [${input.date}] ${input.run.kind} | ${repo} | ${summary} [run:${input.run.id}] [task:${input.run.workItemId}]${pr ? ` [pr:${pr}]` : ''}\n`;
}

/** Appends one line, creating the file with a header first. Returns whether a line was written. */
export function appendWorkLog(
  input: { run: WorkLogRun; events: ObservedRunEvent[]; repoPath: string | null; summary: string; output: string; completedAt: string },
  docsRoot?: string,
): boolean {
  if (!isNonTrivialRun(input.events)) return false;
  const path = workLogPath(docsRoot);
  const line = formatWorkLogLine({ date: input.completedAt.slice(0, 10), run: input.run, repoPath: input.repoPath, summary: input.summary, output: input.output });
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, WORK_LOG_HEADER, { flag: 'wx' });
  }
  appendFileSync(path, line);
  return true;
}
