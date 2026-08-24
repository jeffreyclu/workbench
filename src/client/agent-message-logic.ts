export interface AgentResponseSection {
  title: string;
  body: string;
}

function headingTitle(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();
}

/**
 * Turns an agent response into digestible visual sections without changing the
 * Markdown itself. Prefer authored headings; fall back to top-level blocks for
 * older replies that arrived as unstructured prose.
 */
export function splitAgentResponse(body: string): AgentResponseSection[] {
  const lines = body.trim().split('\n');
  const sections: AgentResponseSection[] = [];
  let currentTitle = 'Brief';
  let currentLines: string[] = [];
  let inFence = false;

  const pushSection = () => {
    const content = currentLines.join('\n').trim();
    if (content) sections.push({ title: currentTitle, body: content });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,2}\s+\S/.test(line)) {
      pushSection();
      currentTitle = headingTitle(line);
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  pushSection();

  if (sections.length > 1) return sections;

  // A report without headings should still scan as individual beats instead
  // of one monolithic card. Blank lines outside fenced code are safe breaks.
  const blocks: string[] = [];
  let blockLines: string[] = [];
  inFence = false;
  const pushBlock = () => {
    const content = blockLines.join('\n').trim();
    if (content) blocks.push(content);
    blockLines = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && !line.trim()) {
      pushBlock();
      continue;
    }
    blockLines.push(line);
  }
  pushBlock();

  if (blocks.length < 2) return sections;
  return blocks.map((content, index) => ({ title: index === 0 ? 'Brief' : `Detail ${String(index + 1).padStart(2, '0')}`, body: content }));
}
