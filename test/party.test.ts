import { abortAllDurableObjects, evictDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import {
  CLOSE,
  HOST_GRACE_MS,
  LOBBY_GRACE_MS,
  PROTOCOL_VERSION,
  type MatchMsg,
  type RoomMsg,
  type ServerMsg,
} from '../src/shared/protocol';
import { iceServers } from '../src/worker/party';
import { MAX_PLAYERS } from '../src/worker/room';

interface Client {
  ws: WebSocket;
  messages: ServerMsg[];
  closed: Promise<CloseEvent>;
  until<T extends ServerMsg>(match: (m: ServerMsg) => m is T, timeoutMs?: number): Promise<T>;
  send(msg: object): void;
}

type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
type Ice = Extract<ServerMsg, { t: 'ice' }>;
type Signal = Extract<ServerMsg, { t: 'signal' }>;

/** What Cloudflare's TURN API answers, port 53 URLs included. */
const TURN_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'test-user',
    credential: 'test-credential',
  },
  { urls: 'turn:turn.cloudflare.com:53' },
];

/** Answers a TURN credentials request for the made-up key in vitest.config.ts, and nothing else. */
function turnApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = 'https://rtc.live.cloudflare.com/v1/turn/keys/test-key-id/credentials/generate-ice-servers';
  const ok = req.method === 'POST' && req.url === url && req.headers.get('Authorization') === 'Bearer test-key-token';
  return Promise.resolve(ok ? Response.json({ iceServers: TURN_SERVERS }, { status: 201 }) : new Response('Not found', { status: 404 }));
}

// The Durable Object runs in this isolate, so this answers its outbound requests too.
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(turnApi);

const url = (code: string, v: string | number = PROTOCOL_VERSION) => `https://puckagon.test/api/party/${code}/ws?v=${v}`;

async function connect(code: string, v: string | number = PROTOCOL_VERSION): Promise<Client> {
  const res = await exports.default.fetch(url(code, v), { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data !== 'pong') messages.push(JSON.parse(e.data) as ServerMsg);
    for (const l of listeners) l();
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve));
  return {
    ws,
    messages,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    until<T extends ServerMsg>(match: (m: ServerMsg) => m is T, timeoutMs = 5000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          const found = messages.find(match);
          if (!found) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out. Got: ${messages.map((m) => m.t).join(',')}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
    },
  };
}

/** Connects and says hello, then waits for the party's welcome. */
async function join(code: string, pid: string, name: string): Promise<Client & { id: string }> {
  const c = await connect(code);
  c.send({ t: 'hello', pid, name });
  const { id } = await c.until(isWelcome);
  return { ...c, id };
}

const isRoom =
  (pred: (m: RoomMsg) => boolean = () => true) =>
  (m: ServerMsg): m is RoomMsg =>
    m.t === 'room' && pred(m);
const isWelcome = (m: ServerMsg): m is Welcome => m.t === 'welcome';
const isIce = (m: ServerMsg): m is Ice => m.t === 'ice';
const isSignal = (m: ServerMsg): m is Signal => m.t === 'signal';
const seats = (n: number) => Array.from({ length: n }, () => ({ score: 0, lives: 7, out: false, linked: true }));
const playing = (n: number): MatchMsg => ({ t: 'match', match: 1, v: 1, phase: 'playing', k: 180, timer: 0, seats: seats(n), winner: null });

describe('Worker routing', () => {
  it('rejects bad requests before they reach a Durable Object', async () => {
    expect((await exports.default.fetch(url('ABCDE'))).status).toBe(426);
    expect((await exports.default.fetch(url('nope!'), { headers: { Upgrade: 'websocket' } })).status).toBe(400);
    const cross = await exports.default.fetch(url('ABCDE'), { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await exports.default.fetch('https://puckagon.test/api/other')).status).toBe(404);
  });

  it('tells clients on an old protocol version to reload', async () => {
    const c = await connect('ABCDE', 0);
    expect((await c.closed).code).toBe(4001);
  });
});

describe('Party Durable Object', () => {
  it('welcomes a page, shows it the room, then gives it TURN servers without port 53', async () => {
    const c = await connect('TRN23');
    c.send({ t: 'hello', pid: 'ice-player-token-01', name: 'Ann' });
    const ice = await c.until(isIce);
    expect(c.messages.map((m) => m.t)).toEqual(['welcome', 'room', 'ice']);
    expect(ice.servers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'test-user',
        credential: 'test-credential',
      },
    ]);
    c.ws.close(CLOSE.left);
  });

  it('gives every page in a party the TURN servers from one request', async () => {
    const before = fetchSpy.mock.calls.length;
    const a = await join('TRN34', 'shared-ice-token-01', 'Ann');
    const b = await join('TRN34', 'shared-ice-token-02', 'Ben');
    const [first, second] = await Promise.all([a.until(isIce), b.until(isIce)]);
    expect(second.servers).toEqual(first.servers);
    expect(first.servers.some((s) => s.username === 'test-user')).toBe(true);
    expect(fetchSpy.mock.calls.length - before).toBe(1);
    a.ws.close(CLOSE.left);
    b.ws.close(CLOSE.left);
  });

  it('hands out Cloudflare STUN alone, without a request, when the TURN key is unset', async () => {
    const before = fetchSpy.mock.calls.length;
    expect(await iceServers({})).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it('falls back to Cloudflare STUN when TURN fails, and keeps handling messages while it waits', async () => {
    fetchSpy.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(new Response('', { status: 500 })), 300)));
    try {
      const c = await connect('STN23');
      c.send({ t: 'hello', pid: 'stun-player-token-1', name: 'Ann' });
      c.send({ t: 'settings', s: { target: 3 } });
      const ice = await c.until(isIce);
      expect(ice.servers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
      const changed = c.messages.findIndex((m) => m.t === 'room' && m.settings.target === 3);
      expect(changed).toBeGreaterThan(-1);
      expect(changed).toBeLessThan(c.messages.indexOf(ice));
      c.ws.close(CLOSE.left);
    } finally {
      fetchSpy.mockImplementation(turnApi);
    }
  });

  it("relays signals between people in the party with the sender's id, and drops the rest", async () => {
    const host = await join('SGN23', 'signal-host-token-1', 'Host');
    const guest = await join('SGN23', 'signal-guest-token-1', 'Guest');
    host.send({ t: 'addBot', level: 'easy' });
    const bot = (await guest.until(isRoom((m) => m.players.length === 3))).players[2];
    const other = await join('SGN23', 'signal-other-token-1', 'Other');

    const offer = { sdp: { type: 'offer', sdp: 'v=0 offer' } };
    guest.send({ t: 'signal', to: host.id, l: 7, d: offer, from: 'forged' });
    expect(await host.until(isSignal)).toEqual({ t: 'signal', from: guest.id, l: 7, d: offer });

    host.messages.length = 0;
    const dropped = [
      { to: guest.id, l: 7, d: offer },
      { to: other.id, l: 7, d: offer },
      { to: bot.id, l: 7, d: offer },
      { to: 'nobody', l: 7, d: offer },
      { to: host.id, l: '7', d: offer },
      { to: host.id, l: 7, d: { sdp: { type: 'pranswer', sdp: 'v=0' } } },
      { to: host.id, l: 7, d: { ...offer, candidate: null } },
      { to: host.id, l: 7, d: { candidate: { candidate: 5 } } },
      { to: host.id, l: 7, d: 'offer' },
    ];
    for (const s of dropped) guest.send({ t: 'signal', ...s });
    guest.send({ t: 'signal', to: host.id, l: 7, d: { candidate: null } });
    const end = await host.until(isSignal);
    expect(host.messages.filter(isSignal)).toEqual([{ t: 'signal', from: guest.id, l: 7, d: { candidate: null } }]);
    expect(end.d).toEqual({ candidate: null });

    // An answer and a burst of candidates fit in one second, well past the 90 a second other messages get.
    for (let i = 0; i < 200; i++) {
      host.send({ t: 'signal', to: guest.id, l: 7, d: { candidate: { candidate: `candidate:${i}`, sdpMid: '0', sdpMLineIndex: 0 } } });
    }
    const last = { candidate: { candidate: 'candidate:199', sdpMid: '0', sdpMLineIndex: 0 } };
    await guest.until((m): m is Signal => isSignal(m) && JSON.stringify(m.d) === JSON.stringify(last));
    expect(guest.messages.filter(isSignal)).toHaveLength(200);

    // Another message dressed as a signal with a repeated key gets neither the signal budget nor handled.
    host.ws.send('{"t":"signal","t":"settings","s":{"target":3}}');
    host.send({ t: 'settings', s: { target: 4 } });
    await guest.until(isRoom((m) => m.settings.target === 4));
    expect(guest.messages.some((m) => m.t === 'room' && m.settings.target === 3)).toBe(false);
    expect(other.messages.filter(isSignal)).toEqual([]);
    for (const c of [host, guest, other]) c.ws.close(CLOSE.left);
  });

  it("mirrors the host's reports to everyone, and keeps the match over a restart", async () => {
    const host = await join('MTC23', 'match-host-token-01', 'Host');
    const guest = await join('MTC23', 'match-guest-token-1', 'Guest');
    host.send({ t: 'start' });
    await guest.until(isRoom((m) => m.phase === 'countdown' && m.match === 1 && m.v === 0));

    guest.send({ ...playing(2), v: 5 });
    host.send(playing(2));
    expect(await guest.until(isRoom((m) => m.v > 0))).toMatchObject({ phase: 'playing', match: 1, v: 1, k: 180 });

    // A deploy restart drops every socket, and the pages reconnect.
    await abortAllDurableObjects();
    await host.closed;
    const back = await join('MTC23', 'match-host-token-01', 'Host');
    expect(back.id).toBe(host.id);
    expect(await back.until(isRoom())).toMatchObject({ phase: 'playing', match: 1, v: 1, k: 180, host: host.id });
    back.ws.close(CLOSE.left);
  });

  it('ends the match HOST_GRACE_MS after the host drops, even when a guest dropped first', async () => {
    const host = await join('HGR23', 'grace-host-token-01', 'Host');
    const away = await join('HGR23', 'grace-away-token-01', 'Away');
    const stays = await join('HGR23', 'grace-stays-token-1', 'Stays');
    host.send({ t: 'start' });
    host.send(playing(3));
    await stays.until(isRoom((m) => m.v === 1));

    away.ws.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const droppedAt = Date.now();
    host.ws.close(1000);
    const lobby = await stays.until(isRoom((m) => m.phase === 'lobby' && m.match === 1), LOBBY_GRACE_MS);
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(HOST_GRACE_MS);
    expect(Date.now() - droppedAt).toBeLessThan(LOBBY_GRACE_MS - 1000);
    expect(lobby.host).toBe(stays.id);
    stays.ws.close(CLOSE.left);
  }, 15000);

  it('hands the seat back to a player who reconnects with the same token', async () => {
    const a = await connect('RJN45');
    a.send({ t: 'hello', pid: 'rejoin-player-token', name: 'Ann' });
    const first = await a.until(isWelcome);

    const b = await connect('RJN45');
    b.send({ t: 'hello', pid: 'rejoin-player-token', name: 'Ann' });
    const second = await b.until(isWelcome);
    expect(second.id).toBe(first.id);
    expect((await a.closed).code).toBe(4000);
    b.ws.close(1000);
  });

  it('still runs the leave path when a socket closes after the party went to sleep', async () => {
    const host = await connect('SNPPY');
    host.send({ t: 'hello', pid: 'sleepy-host-token-1', name: 'Host' });
    await host.until(isRoom((m) => m.players.length === 1));
    const guest = await connect('SNPPY');
    guest.send({ t: 'hello', pid: 'sleepy-guest-token-1', name: 'Guest' });
    const first = await guest.until(isWelcome);
    await host.until(isRoom((m) => m.players.length === 2));

    await evictDurableObject(env.PARTY.getByName('SNPPY'));
    host.messages.length = 0;
    guest.ws.close(1000);
    const away = await host.until(isRoom((m) => m.players.some((p) => p.name === 'Guest' && !p.connected)));
    expect(away.host).toBe(away.players[0].id);

    const back = await connect('SNPPY');
    back.send({ t: 'hello', pid: 'sleepy-guest-token-1', name: 'Guest' });
    const again = await back.until(isWelcome);
    expect(again.id).toBe(first.id);
    host.ws.close(CLOSE.left);
    back.ws.close(CLOSE.left);
  });

  it("shows everyone a player's reported ping, even after the party went to sleep", async () => {
    const host = await connect('PNG23');
    host.send({ t: 'hello', pid: 'ping-host-token-01', name: 'Host' });
    await host.until(isRoom((m) => m.players.length === 1));
    const guest = await connect('PNG23');
    guest.send({ t: 'hello', pid: 'ping-guest-token-1', name: 'Guest' });
    await host.until(isRoom((m) => m.players.length === 2));

    guest.send({ t: 'rtt', ms: 87 });
    const seen = await host.until(isRoom((m) => m.players[1]?.ping === 87));
    expect(seen.players.map((p) => p.ping)).toEqual([-1, 87]);

    await evictDurableObject(env.PARTY.getByName('PNG23'));
    host.send({ t: 'settings', s: { target: 3 } });
    const woken = await host.until(isRoom((m) => m.settings.target === 3));
    expect(woken.players.map((p) => p.ping)).toEqual([-1, 87]);
    host.ws.close(CLOSE.left);
    guest.ws.close(CLOSE.left);
  });

  it('turns new players away once the party is full', async () => {
    const clients: Client[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const c = await connect('FHVVV');
      c.send({ t: 'hello', pid: `full-party-player-${String(i).padStart(4, '0')}`, name: `P${i}` });
      clients.push(c);
    }
    await clients[0].until(isRoom((m) => m.players.length === MAX_PLAYERS));
    const late = await connect('FHVVV');
    late.send({ t: 'hello', pid: 'full-party-player-late', name: 'Late' });
    expect((await late.closed).code).toBe(CLOSE.full);
    for (const c of clients) c.ws.close(CLOSE.left);
  }, 20000);
});
