export function humanizeRunOutput(output: string): string {
  const seen = new Set<string>();
  return output.split(/\n\n+/).flatMap((block) => {
    const trimmed = block.trim();
    if (!trimmed || trimmed === 'Starting Claude…') return [];
    const legacyTool = trimmed.match(/^Using ([^:]+):\s*([\s\S]+)$/);
    if (legacyTool) {
      try {
        const input = JSON.parse(legacyTool[2]) as Record<string, unknown>;
        const description = typeof input.description === 'string' ? input.description : `Using ${legacyTool[1]}`;
        const event = `● ${description.charAt(0).toUpperCase()}${description.slice(1)}`;
        if (seen.has(event)) return [];
        seen.add(event);
        return [event];
      } catch { /* Preserve non-JSON agent prose. */ }
    }
    if (seen.has(trimmed)) return [];
    seen.add(trimmed);
    return [trimmed];
  }).join('\n\n');
}

export function hideWorkbenchControlBlocks(output: string): string {
  return output.replace(/\s*<workbench-plan>[\s\S]*?(?:<\/workbench-plan>|$)/g, '').trim();
}
