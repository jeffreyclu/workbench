/**
 * A refused Workbench action, carrying the exact HTTP status and body the REST
 * route sends. Actions are written once and shared by the REST API and the agent
 * MCP surface, so both refuse for the same reason with the same wording, and
 * neither surface can quietly gain or lose a capability the other has.
 */
export type ActionFailure = { status: number; body: { error: string; code?: string } & Record<string, unknown> };

export function isActionFailure(value: unknown): value is ActionFailure {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}
