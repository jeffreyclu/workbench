// Project names are free text, so derive the existing task-card theme
// deterministically. This is the single project identity used by the card and
// anywhere else a task can be represented.
import { createElement, type CSSProperties } from 'react';

const projectThemePalette = [
  { accent: '#648bd8', tint: '#151c2a', border: '#2d4164' },
  { accent: '#9676d3', tint: '#1e1928', border: '#43365d' },
  { accent: '#c06ca8', tint: '#261824', border: '#543046' },
] as const;

export function projectTheme(projectName: string) {
  let hash = 0;
  for (const character of projectName) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return projectThemePalette[Math.abs(hash) % projectThemePalette.length];
}

export function projectColor(projectName: string): string {
  return projectTheme(projectName).accent;
}

export function ProjectColorDot({ projectName, labelled = false }: { projectName: string; labelled?: boolean }) {
  return createElement('span', {
    className: 'project-color-dot',
    style: { background: projectColor(projectName) } as CSSProperties,
    'aria-hidden': labelled ? undefined : true,
    'aria-label': labelled ? `${projectName} project` : undefined,
    title: labelled ? projectName : undefined,
  });
}
