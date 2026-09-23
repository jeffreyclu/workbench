import { setApplicationRequestTestAdapter } from '../data/request';

setApplicationRequestTestAdapter(async (path, init) => {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const binary = !contentType.includes('application/json') && !contentType.startsWith('text/');
  const body = binary
    ? btoa(String.fromCharCode(...new Uint8Array(await response.arrayBuffer())))
    : await response.text();
  return { status: response.status, contentType, body, encoding: binary ? 'base64' : 'utf8' };
});
