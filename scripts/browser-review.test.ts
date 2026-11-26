import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startBrowserReview } from './browser-review';

let server: Awaited<ReturnType<typeof startBrowserReview>>;
beforeAll(async () => { server = await startBrowserReview(); });
afterAll(() => server?.stop(true));
const get = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);
const requests = '/api/hosts/alpha/requests';

test('serves bundled product pages, scripts and styles, not the design reference', async () => {
  for (const path of ['/', '/add-host', '/workstation', '/install']) {
    const page = await get(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    const urls = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(m => m[1]!);
    expect(urls.some(url => url.endsWith('.js'))).toBe(true);
    expect(urls.some(url => url.endsWith('.css'))).toBe(true);
    for (const url of urls) {
      const asset = await get(url);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toMatch(/javascript|css/);
    }
  }
});

test('a real decision write is denied and the populated snapshot stays byte-identical', async () => {
  const path = requests + '?view=current';
  const before = await (await get(path)).text();
  const { requests: rows } = JSON.parse(before);
  expect(rows.some((r: {projectId?: string}) => !r.projectId)).toBe(true);
  expect(rows.some((r: {status: string}) => r.status === 'resolved')).toBe(true);
  const owned = rows.find((r: {projectId?: string; status: string}) => r.projectId === 'Atlas' && r.status === 'open');
  expect(owned.id).toBeTruthy();
  const denied = await get(`${requests}/${owned.id}/resolve`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ response:'approve', expectedRevision:owned.revision }) });
  expect(denied.status).toBe(405);
  expect(denied.headers.get('allow')).toBe('GET');
  expect(await (await get(path)).text()).toBe(before);
  for (const method of ['PUT','PATCH','DELETE','OPTIONS','HEAD']) expect((await get('/', { method })).status).toBe(405);
});

test('unknown reads and foreign origins cannot reach fixture data', async () => {
  expect((await get('/api/hosts')).status).toBe(200);
  expect((await get('/api/hosts/unknown/sessions')).status).toBe(404);
  expect((await get('/api/hosts', { headers: { Origin:'https://other.invalid' } })).status).toBe(403);
  expect((await get('/api/hosts', { headers: { Host:'other.invalid' } })).status).toBe(403);
});

test('both viewers replay binary output and reject text or binary input without echo', async () => {
  const { sessions } = await (await get('/api/hosts/alpha/sessions')).json();
  expect(sessions.length).toBe(2);
  for (const [index, session] of sessions.entries()) {
    expect(session.running).toBe(true);
    const url = new URL(`/api/hosts/alpha/sessions/${session.name}/terminal`, server.url);
    url.protocol = 'ws:';
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    const frames: string[] = [];
    try {
      const closed = await new Promise<CloseEvent>((resolve, reject) => {
        ws.onerror = () => reject(Error('Fixture websocket failed'));
        ws.onclose = resolve;
        ws.onmessage = event => {
          if (!(event.data instanceof ArrayBuffer)) return reject(Error('Expected binary terminal frame'));
          frames.push(new TextDecoder().decode(event.data));
          ws.send(index ? new Uint8Array([42]) : 'forbidden');
        };
      });
      expect(closed.code).toBe(1008);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toContain(`Synthetic replay: ${session.name}`);
    } finally { ws.close(); }
  }
});
