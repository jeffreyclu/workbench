import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { PalmyraFunctionTool } from './providers/palmyra.js';

export interface PalmyraWorkbenchToolBridge {
  tools: PalmyraFunctionTool[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const rendered = blocks.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'resource_link') return `${block.name}: ${block.uri}`;
    if (block.type === 'resource') return 'text' in block.resource ? block.resource.text : `[binary resource: ${block.resource.uri}]`;
    if (block.type === 'image') return `[image: ${block.mimeType}]`;
    if (block.type === 'audio') return `[audio: ${block.mimeType}]`;
    return JSON.stringify(block);
  }).filter(Boolean);
  const body = rendered.join('\n');
  return `${result.isError ? 'Tool failed' : 'Tool succeeded'}${body ? `:\n${body}` : '.'}`;
}

/**
 * Palmyra uses the same loopback MCP surface as Codex and Claude. This keeps
 * permissions, audit logging, connected-source credentials, and mutations in
 * Workbench's canonical service layer instead of duplicating them in the
 * provider adapter.
 */
export async function connectPalmyraWorkbenchTools(
  url = process.env.WORKBENCH_MCP_URL?.trim() || 'http://localhost:5180/mcp',
): Promise<PalmyraWorkbenchToolBridge> {
  const client = new Client({ name: 'workbench-palmyra', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  const listed = await client.listTools();
  return {
    tools: listed.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? `Call the Workbench ${tool.name} operation.`,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    })),
    async call(name, args) {
      return resultText(await client.callTool({ name, arguments: args }));
    },
    async close() {
      await transport.close();
    },
  };
}
