import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeWithPalmyra, isPalmyraConfigured, palmyraModel } from './palmyra.js';
import { createOutboundFetch } from '../outbound-policy.js';
import { parseTaskDraftResponse } from '../fast-task-draft-ai.js';

const originalKey = process.env.WRITER_API_KEY;
const originalModel = process.env.WORKBENCH_PALMYRA_MODEL;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(response: Response | (() => Response)): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

beforeEach(() => { process.env.WRITER_API_KEY = 'test-key'; delete process.env.WORKBENCH_PALMYRA_MODEL; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.WRITER_API_KEY; else process.env.WRITER_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.WORKBENCH_PALMYRA_MODEL; else process.env.WORKBENCH_PALMYRA_MODEL = originalModel;
});

describe('palmyra client', () => {
  it('posts to the Writer chat endpoint with bearer auth and the configured model', async () => {
    const stub = stubFetch(jsonResponse({ choices: [{ message: { content: '  hello  ' } }] }));
    const content = await completeWithPalmyra({ messages: [{ role: 'user', content: 'hi' }] }, stub.fetch);

    expect(content).toBe('hello');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe('https://api.writer.com/v1/chat');
    expect(stub.calls[0].init.method).toBe('POST');
    expect((stub.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(stub.calls[0].init.body))).toMatchObject({
      model: 'palmyra-x5',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('honors the model override', async () => {
    process.env.WORKBENCH_PALMYRA_MODEL = 'palmyra-x6';
    const stub = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await completeWithPalmyra({ messages: [{ role: 'user', content: 'hi' }] }, stub.fetch);

    expect(palmyraModel()).toBe('palmyra-x6');
    expect(JSON.parse(String(stub.calls[0].init.body)).model).toBe('palmyra-x6');
  });

  it('reports configuration state from WRITER_API_KEY', async () => {
    expect(isPalmyraConfigured()).toBe(true);
    process.env.WRITER_API_KEY = '   ';
    expect(isPalmyraConfigured()).toBe(false);
    await expect(completeWithPalmyra({ messages: [] }, stubFetch(jsonResponse({})).fetch)).rejects.toThrow(/WRITER_API_KEY/);
  });

  it('surfaces a non-2xx response with its status', async () => {
    const stub = stubFetch(() => new Response('invalid api key', { status: 401 }));
    await expect(completeWithPalmyra({ messages: [] }, stub.fetch)).rejects.toThrow(/Palmyra request failed \(401\)\. invalid api key/);
  });

  it('rejects an empty completion instead of returning a blank draft', async () => {
    const stub = stubFetch(jsonResponse({ choices: [{ message: { content: '' } }] }));
    await expect(completeWithPalmyra({ messages: [] }, stub.fetch)).rejects.toThrow(/empty completion/);
  });
});

describe('task drafts parsed from a Palmyra reply', () => {
  it('accepts raw JSON with surrounding prose', () => {
    const draft = parseTaskDraftResponse('Here you go: {"title":"fix the login redirect","description":"Redirect loops after SSO."} done', 'login is broken');
    expect(draft.title).toBe('Fix the login redirect');
    expect(draft.description).toBe('Redirect loops after SSO.');
  });

  it('falls back to the original prompt when the description is blank', () => {
    const draft = parseTaskDraftResponse('{"title":"Investigate flake","description":"  "}', 'the suite flakes');
    expect(draft.description).toBe('the suite flakes');
  });

  it('rejects a reply with no JSON object', () => {
    expect(() => parseTaskDraftResponse('I cannot help with that.', 'x')).toThrow(/no JSON/);
  });
});

describe('palmyra outbound policy', () => {
  const stubs = {
    resolve: async () => [{ address: '203.0.113.10', family: 4 as const }],
    audit: () => undefined,
  };

  it('approves the Writer chat endpoint', async () => {
    let requested = '';
    const gated = createOutboundFetch('palmyra-api', {
      ...stubs,
      transport: async (input) => { requested = String(input); return new Response('{}', { status: 200 }); },
    });
    await gated('https://api.writer.com/v1/chat', { method: 'POST' });
    expect(requested).toBe('https://api.writer.com/v1/chat');
  });

  it('blocks any other path or host on the same policy', async () => {
    const gated = createOutboundFetch('palmyra-api', {
      ...stubs,
      transport: async () => new Response('{}', { status: 200 }),
    });
    await expect(gated('https://api.writer.com/v1/graphs')).rejects.toThrow(/not approved/);
    await expect(gated('https://evil.example.com/v1/chat')).rejects.toThrow(/not approved/);
  });
});
