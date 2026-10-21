import { normalizeCode, PROTOCOL_VERSION } from '../shared/protocol';

export { Party } from './party';

const SOCKET_PATH = /^\/api\/party\/([^/]+)\/ws$/;

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  });
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Tells an out-of-date client to reload, over a socket it can read the close code from. */
function outdated(): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(4001, 'Puckagon was updated. Reload the page.');
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(SOCKET_PATH);
    if (!match) return text('Not found', 404);
    if (request.method !== 'GET') return text('Method not allowed', 405);
    if (request.headers.get('Upgrade') !== 'websocket') return text('Expected a WebSocket upgrade', 426);

    const origin = request.headers.get('Origin');
    if (origin && originHost(origin) !== url.host) return text('Cross-origin connections are not allowed', 403);

    const code = normalizeCode(match[1]);
    if (!code) return text('Unknown party code', 400);
    if (url.searchParams.get('v') !== String(PROTOCOL_VERSION)) return outdated();

    try {
      return await env.PARTY.getByName(code).fetch(request);
    } catch (err) {
      console.error(JSON.stringify({ event: 'party_fetch_failed', code, error: String(err) }));
      return text('The party is busy. Try again in a moment.', 503);
    }
  },
} satisfies ExportedHandler<Env>;
