/** Shared HTTP transport for Workbench client domain clients. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const body = (await response.text()).replace(/\s+/g, ' ').trim();
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}): ${body || response.statusText || 'The API endpoint is unavailable.'}`);
    }
    throw new Error('The API returned an invalid response. Refresh the preview and try again.');
  }
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}
