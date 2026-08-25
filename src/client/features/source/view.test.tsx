// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrokerConnection } from '../../../shared/contracts';
import { getToasts, toast } from '../../toast-store';
import { SourcesDialog } from './view';

const figmaConnection: BrokerConnection = {
  id: 'figma',
  name: 'Figma',
  state: 'connected',
  host: 'managed_connector',
  capabilities: ['resolve_links', 'search'],
  detail: 'Connected via MCP',
  configurable: true,
  lastError: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderDialog(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SourcesDialog onClose={() => {}} /></QueryClientProvider>);
  return client;
}

afterEach(() => {
  cleanup();
  act(() => toast.clear());
  vi.unstubAllGlobals();
});

describe('SourcesDialog disconnect', () => {
  it('asks for confirmation before disconnecting a connected source', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/source-connections') return jsonResponse({ connections: [figmaConnection] });
      if (url === '/api/source-connections/figma/scope') return jsonResponse({ roots: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDialog(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: /^Disconnect$/ }));

    expect(await screen.findByRole('dialog', { name: 'Disconnect Figma?' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/source-connections/figma', expect.anything());
  });

  it('toasts and keeps the prompt open when the disconnect request fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/source-connections' && (!init || init.method === undefined)) return jsonResponse({ connections: [figmaConnection] });
      if (url === '/api/source-connections/figma/scope') return jsonResponse({ roots: [] });
      if (url === '/api/source-connections/figma' && init?.method === 'DELETE') return jsonResponse({ error: 'Provider unreachable.' }, 500);
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDialog(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: /^Disconnect$/ }));
    await screen.findByRole('dialog', { name: 'Disconnect Figma?' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).slice(-1)[0]);

    await waitFor(() => expect(getToasts().map((entry) => entry.message)).toContain('Could not disconnect Figma.'));
    expect(await screen.findByText('Could not disconnect: Provider unreachable.')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'Disconnect Figma?' })).toBeTruthy();
  });

  it('closes the prompt once the disconnect succeeds', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/source-connections/figma' && init?.method === 'DELETE') return jsonResponse(null);
      if (url === '/api/source-connections') return jsonResponse({ connections: [figmaConnection] });
      if (url === '/api/source-connections/figma/scope') return jsonResponse({ roots: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDialog(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: /^Disconnect$/ }));
    await screen.findByRole('dialog', { name: 'Disconnect Figma?' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).slice(-1)[0]);

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog', { name: 'Disconnect Figma?' })).toBeNull();
  });
});

describe('SourcesDialog Figma scope', () => {
  it('reports a failed Figma scope save without discarding the entered URL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/source-connections') return jsonResponse({ connections: [figmaConnection] });
      if (url === '/api/source-connections/figma/scope' && !init?.method) return jsonResponse({ roots: [] });
      if (url === '/api/source-connections/figma/scope' && init?.method === 'PUT') return jsonResponse({ error: 'Figma is unavailable.' }, 503);
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDialog(fetchMock);

    const scope = await screen.findByLabelText(/Discovery scope/);
    fireEvent.change(scope, { target: { value: 'https://www.figma.com/design/example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scope' }));

    await waitFor(() => expect(getToasts().map((entry) => entry.message)).toContain('Could not save the Figma scope.'));
    expect((scope as HTMLTextAreaElement).value).toBe('https://www.figma.com/design/example');
    expect(await screen.findByText('Could not save Figma scope: Figma is unavailable.')).toBeTruthy();
  });
});

describe('SourcesDialog connection loading', () => {
  it('reserves connection-card space while connections are loading', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    renderDialog(fetchMock);

    expect(screen.getAllByTestId('connection-card-skeleton')).toHaveLength(2);
    expect(screen.queryByText('Linear')).toBeNull();
  });

  it('explains a failed connections request and retries it', async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/source-connections') throw new Error(`Unexpected request: ${String(input)}`);
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse({ error: 'Network unavailable.' }, 500)
        : jsonResponse({ connections: [figmaConnection] });
    });
    renderDialog(fetchMock);

    expect(await screen.findByText('Could not load connections. Check your network and try again.')).toBeTruthy();
    expect(screen.queryByText('Linear')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Linear')).toBeTruthy();
    expect(await screen.findByText('Figma')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/source-connections')).toHaveLength(2);
  });
});
