import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type RoomMsg, type ServerMsg, type SnapMsg } from '../src/shared/protocol';

interface Client {
  ws: WebSocket;
  messages: ServerMsg[];
  closed: Promise<CloseEvent>;
  until<T extends ServerMsg>(match: (m: ServerMsg) => m is T, timeoutMs?: number): Promise<T>;
  send(msg: object): void;
}

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

const isRoom =
  (pred: (m: RoomMsg) => boolean = () => true) =>
  (m: ServerMsg): m is RoomMsg =>
    m.t === 'room' && pred(m);
const isSnap = (m: ServerMsg): m is SnapMsg => m.t === 's';

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
  it('runs a lobby and a match for two players over real WebSockets', async () => {
    const host = await connect('HKY23');
    host.send({ t: 'hello', pid: 'host-player-token-1', name: 'Host' });
    await host.until(isRoom((m) => m.players.length === 1));

    const guest = await connect('HKY23');
    guest.send({ t: 'hello', pid: 'guest-player-token-1', name: '  Guest\u0000  ' });
    const both = await guest.until(isRoom((m) => m.players.length === 2));
    expect(both.players.map((p) => [p.name, p.seat])).toEqual([
      ['Host', 0],
      ['Guest', 1],
    ]);
    expect(both.host).toBe(both.players[0].id);

    guest.send({ t: 'settings', s: { target: 3 } });
    host.send({ t: 'settings', s: { speed: 'chaos', zone: 'free' } });
    const changed = await guest.until(isRoom((m) => m.settings.speed === 'chaos'));
    expect(changed.settings).toMatchObject({ target: 7, zone: 'free' });

    host.send({ t: 'start' });
    await guest.until(isRoom((m) => m.phase === 'countdown'));
    await guest.until(isRoom((m) => m.phase === 'playing'), 6000);

    guest.messages.length = 0;
    guest.send({ t: 'p', x: 0.3, y: -0.6 });
    const moved = await guest.until((m): m is SnapMsg => isSnap(m) && Array.isArray(m.m[1]) && Math.abs(m.m[1][0] - 0.3) < 0.01);
    expect(moved.m[1]).toEqual([expect.closeTo(0.3, 2), expect.closeTo(-0.6, 2)]);

    host.ws.close(1000);
    guest.ws.close(1000);
  }, 20000);

  it('hands the seat back to a player who reconnects with the same token', async () => {
    const a = await connect('RJN45');
    a.send({ t: 'hello', pid: 'rejoin-player-token', name: 'Ann' });
    const first = await a.until((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');

    const b = await connect('RJN45');
    b.send({ t: 'hello', pid: 'rejoin-player-token', name: 'Ann' });
    const second = await b.until((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    expect(second.id).toBe(first.id);
    expect((await a.closed).code).toBe(4000);
    b.ws.close(1000);
  });
});
