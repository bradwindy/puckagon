import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_MS,
  HOST_GRACE_MS,
  HOST_SILENT_MS,
  LOBBY_GRACE_MS,
  type MatchMsg,
  type RoomMsg,
  type SeatState,
  type ServerMsg,
} from '../src/shared/protocol';
import { Room, type RoomSnapshot } from '../src/worker/room';

function makeRoom() {
  const sent: ServerMsg[] = [];
  const direct: [string, ServerMsg][] = [];
  /** When each pid's socket last showed life. Unlisted sockets are always fresh. */
  const seen = new Map<string, number>();
  const clock = { now: 1_000_000 };
  let ids = 0;
  const room = new Room({
    send: (pid, msg) => {
      sent.push(msg);
      direct.push([pid, msg]);
    },
    broadcast: (msg) => sent.push(msg),
    newId: () => `id${ids++}`,
    seenAt: (pid) => seen.get(pid) ?? clock.now,
  });
  const lastRoom = () => sent.filter((m): m is RoomMsg => m.t === 'room').at(-1)!;
  return { room, sent, direct, seen, clock, lastRoom };
}

/** Joins each name as pid-0, pid-1, ... and has pid-0, the host, start a match. */
function startMatch(names: string[]) {
  const r = makeRoom();
  names.forEach((n, i) => r.room.join(`pid-${i}`, n));
  r.room.start('pid-0');
  return { ...r, ids: r.lastRoom().players.map((p) => p.id) };
}

const seat = (s: Partial<SeatState> = {}): SeatState => ({ score: 0, lives: 7, out: false, linked: true, ...s });

/** A host report for the match `room` shows. */
function report(room: RoomMsg, v: number, msg: Partial<MatchMsg> = {}): MatchMsg {
  const seats = Array.from({ length: room.seats }, () => seat());
  return { t: 'match', match: room.match, v, phase: 'playing', k: 180, timer: 0, seats, winner: null, ...msg };
}

describe('Room lobby', () => {
  it('seats players in join order and grows the table', () => {
    const { room, lastRoom } = makeRoom();
    room.join('pid-a', 'Ann');
    expect(lastRoom().seats).toBe(2);
    room.join('pid-b', 'Ben');
    room.join('pid-c', 'Cat');
    expect(lastRoom().seats).toBe(3);
    expect(lastRoom().players.map((p) => p.seat)).toEqual([0, 1, 2]);
  });

  it('keeps a reloading host in place, and hands host on once their grace runs out', () => {
    const { room, lastRoom, clock } = makeRoom();
    room.join('pid-a', 'Ann');
    room.join('pid-b', 'Ben');
    room.join('pid-c', 'Cat');
    const annId = lastRoom().players[0].id;

    room.leave('pid-a', clock.now);
    room.join('pid-a', 'Ann');
    expect(lastRoom()).toMatchObject({ host: annId, seats: 3 });
    expect(lastRoom().players[0]).toMatchObject({ seat: 0, connected: true });

    room.leave('pid-a', clock.now);
    expect(room.purge(clock.now + LOBBY_GRACE_MS - 1)).toBe(false);
    expect(room.purge(clock.now + LOBBY_GRACE_MS)).toBe(true);
    const after = lastRoom();
    expect(after.players.map((p) => [p.name, p.seat])).toEqual([
      ['Ben', 0],
      ['Cat', 1],
    ]);
    expect(after.host).toBe(after.players[0].id);
  });

  it('seats twelve and lets the rest watch', () => {
    const { room, lastRoom } = makeRoom();
    for (let i = 0; i < 14; i++) room.join(`pid-${i}`, `P${i}`);
    expect(lastRoom().seats).toBe(12);
    expect(lastRoom().players.filter((p) => p.seat < 0)).toHaveLength(2);
  });

  it('treats pressing Leave as leaving at once, and hands host on straight away', () => {
    const { room, lastRoom, clock } = makeRoom();
    room.join('pid-a', 'Ann');
    room.join('pid-b', 'Ben');
    room.leave('pid-a', clock.now, true);
    expect(lastRoom().players.map((p) => p.name)).toEqual(['Ben']);
    expect(lastRoom().host).toBe(lastRoom().players[0].id);
  });

  it('refuses to start while the only other player is away, and says so', () => {
    const { room, lastRoom, clock, sent } = makeRoom();
    room.join('pid-a', 'Ann');
    room.join('pid-b', 'Ben');
    room.leave('pid-b', clock.now);
    const before = sent.length;
    room.start('pid-a');
    expect(sent.length).toBe(before + 1);
    expect(lastRoom()).toMatchObject({ phase: 'lobby' });
    expect(lastRoom().players[1]).toMatchObject({ name: 'Ben', connected: false, seat: 1 });
    room.join('pid-b', 'Ben');
    expect(lastRoom().players[1]).toMatchObject({ name: 'Ben', connected: true, seat: 1 });
  });

  it('ignores settings and start from anyone but the host', () => {
    const { room, lastRoom } = makeRoom();
    room.join('pid-0', 'Host');
    room.join('pid-1', 'Guest');
    room.updateSettings('pid-1', { target: 3 });
    room.start('pid-1');
    expect(lastRoom().settings.target).toBe(7);
    expect(lastRoom().phase).toBe('lobby');
    room.updateSettings('pid-0', { target: 99, speed: 'warp' });
    expect(lastRoom().settings).toMatchObject({ target: 15, speed: 'normal' });
  });

  it('keeps the seat and id of a person who drops and says hello again within the grace, in the lobby and mid-match', () => {
    const { room, sent, lastRoom, clock } = makeRoom();
    ['Ann', 'Ben', 'Cat'].forEach((n, i) => room.join(`pid-${i}`, n));
    const before = lastRoom().players.map((p) => [p.id, p.seat]);
    const rejoin = () => {
      room.leave('pid-1', clock.now);
      room.purge(clock.now + LOBBY_GRACE_MS - 1);
      room.join('pid-1', 'Ben');
      expect(sent.filter((m) => m.t === 'welcome').at(-1)).toEqual({ t: 'welcome', id: before[1][0] });
      expect(lastRoom().players.map((p) => [p.id, p.seat])).toEqual(before);
      expect(lastRoom().players[1].connected).toBe(true);
    };
    rejoin();
    room.start('pid-0');
    rejoin();
    expect(lastRoom().phase).toBe('countdown');
  });

  it('forgets the party once everyone has gone for good, even mid-match', () => {
    const { room, clock } = startMatch(['Ann', 'Ben']);
    room.leave('pid-0', clock.now);
    room.leave('pid-1', clock.now);
    room.purge(clock.now + LOBBY_GRACE_MS);
    expect(room.players).toEqual([]);
    expect(room.phase).toBe('lobby');
  });
});

describe('Room matches', () => {
  it('opens each match in its countdown with a new number and no report yet', () => {
    const { room, lastRoom, ids } = startMatch(['Ann', 'Ben']);
    expect(lastRoom()).toMatchObject({ phase: 'countdown', match: 1, v: 0, k: 0, timer: COUNTDOWN_MS, winner: null });
    room.report('pid-0', report(lastRoom(), 1, { phase: 'over', winner: ids[0] }));
    room.again('pid-0');
    room.start('pid-0');
    expect(lastRoom()).toMatchObject({ phase: 'countdown', match: 2, v: 0, winner: null });
  });

  it("mirrors the host's newer reports, shows seated players' links as connected, and ends at over", () => {
    const { room, lastRoom, ids } = startMatch(['Ann', 'Ben', 'Cat']);
    const seats = [seat({ score: 2 }), seat({ linked: false }), seat({ lives: 6, out: true })];
    room.report('pid-0', report(lastRoom(), 1, { phase: 'scored', k: 400, timer: 1600, seats }));
    expect(lastRoom()).toMatchObject({ phase: 'scored', v: 1, k: 400, timer: 1600 });
    expect(lastRoom().players.map((p) => [p.score, p.lives, p.out, p.connected])).toEqual([
      [2, 7, false, true],
      [0, 7, false, false],
      [0, 6, true, true],
    ]);

    room.report('pid-0', report(lastRoom(), 2, { phase: 'over', winner: ids[2] }));
    expect(lastRoom()).toMatchObject({ phase: 'over', v: 2, winner: ids[2] });
    room.report('pid-0', report(lastRoom(), 3));
    expect(lastRoom()).toMatchObject({ phase: 'over', v: 2 });
  });

  it('ignores reports from anyone but the host, for another match, that are not newer, or that are malformed', () => {
    const { room, sent, lastRoom } = startMatch(['Ann', 'Ben', 'Cat']);
    room.join('pid-3', 'Dan');
    room.report('pid-0', report(lastRoom(), 2));
    const shown = lastRoom();
    const before = sent.length;
    const ignored: [string, MatchMsg][] = [
      ['pid-1', report(shown, 3)],
      ['pid-0', report(shown, 3, { match: 2 })],
      ['pid-0', report(shown, 2)],
      ['pid-0', report(shown, 1)],
      ['pid-0', report(shown, 3.5)],
      ['pid-0', report(shown, 3, { seats: [seat(), seat()] })],
      ['pid-0', report(shown, 3, { seats: [seat(), seat(), { score: 1, lives: 7, out: false } as SeatState] })],
      ['pid-0', report(shown, 3, { timer: NaN })],
      ['pid-0', report(shown, 3, { phase: 'lobby' as MatchMsg['phase'] })],
      ['pid-0', report(shown, 3, { phase: 'over', winner: shown.players[3].id })],
      ['pid-0', report(shown, 3, { phase: 'over', winner: 'nobody' })],
    ];
    expect(shown.players[3]).toMatchObject({ name: 'Dan', seat: -1 });
    for (const [pid, msg] of ignored) room.report(pid, msg);
    expect(sent.length).toBe(before);
  });

  it('ends the match when the host aborts it, without the players who left for good', () => {
    const { room, lastRoom, clock, ids } = startMatch(['Ann', 'Ben', 'Cat']);
    room.report('pid-0', report(lastRoom(), 1, { seats: [seat({ score: 3 }), seat(), seat()] }));
    room.leave('pid-2', clock.now, true);
    expect(lastRoom().players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cat']);

    room.abort('pid-1', 1);
    room.abort('pid-0', 2);
    expect(lastRoom().phase).toBe('playing');
    room.abort('pid-0', 1);
    expect(lastRoom()).toMatchObject({ phase: 'lobby', host: ids[0] });
    expect(lastRoom().players.map((p) => [p.name, p.seat, p.score])).toEqual([
      ['Ann', 0, 0],
      ['Ben', 1, 0],
    ]);
  });

  it('keeps a seated player who drops listed and in the match, and drops a watcher who leaves at once', () => {
    const { room, lastRoom, clock } = startMatch(['Ann', 'Ben', 'Cat']);
    room.report('pid-0', report(lastRoom(), 1));
    room.join('pid-3', 'Dan');
    room.leave('pid-3', clock.now);
    room.leave('pid-1', clock.now);
    room.purge(clock.now + LOBBY_GRACE_MS);
    expect(lastRoom().phase).toBe('playing');
    expect(lastRoom().players.map((p) => [p.name, p.seat, p.out])).toEqual([
      ['Ann', 0, false],
      ['Ben', 1, false],
      ['Cat', 2, false],
    ]);
  });

  it('tells the host when a seated player presses Leave mid-match, but not for a watcher or in the lobby', () => {
    const { room, direct, lastRoom, clock, ids } = startMatch(['Ann', 'Ben', 'Cat']);
    const left = () => direct.filter(([, m]) => m.t === 'left');
    room.join('pid-3', 'Dan');
    room.leave('pid-3', clock.now, true);
    room.leave('pid-1', clock.now, true);
    expect(left()).toEqual([['pid-0', { t: 'left', id: ids[1] }]]);

    room.report('pid-0', report(lastRoom(), 1, { phase: 'over', winner: ids[0] }));
    room.again('pid-0');
    room.leave('pid-2', clock.now, true);
    expect(left()).toHaveLength(1);
  });

  it("ends the match HOST_GRACE_MS after the host's socket drops and passes host on, unless they come back in time", () => {
    const { room, lastRoom, clock, ids } = startMatch(['Ann', 'Ben', 'Cat']);
    room.report('pid-0', report(lastRoom(), 1));
    room.leave('pid-2', clock.now);
    clock.now += 1000;
    room.leave('pid-0', clock.now);
    expect(room.nextPurgeAt()).toBe(clock.now + HOST_GRACE_MS);

    room.join('pid-0', 'Ann');
    expect(room.purge(clock.now + HOST_GRACE_MS)).toBe(false);
    expect(lastRoom()).toMatchObject({ phase: 'playing', host: ids[0] });

    room.leave('pid-0', clock.now);
    expect(room.purge(clock.now + HOST_GRACE_MS - 1)).toBe(false);
    expect(room.purge(clock.now + HOST_GRACE_MS)).toBe(true);
    expect(lastRoom()).toMatchObject({ phase: 'lobby', host: ids[1] });
    expect(lastRoom().players.map((p) => [p.name, p.connected])).toEqual([
      ['Ann', false],
      ['Ben', true],
      ['Cat', false],
    ]);
  });

  it('ends the match at once when the host presses Leave', () => {
    const { room, lastRoom, clock, ids } = startMatch(['Ann', 'Ben']);
    room.report('pid-0', report(lastRoom(), 1));
    room.leave('pid-0', clock.now, true);
    expect(lastRoom()).toMatchObject({ phase: 'lobby', host: ids[1] });
    expect(lastRoom().players.map((p) => p.name)).toEqual(['Ben']);
  });

  it("ends the match when the host's open socket goes quiet for HOST_SILENT_MS", () => {
    const { room, seen, lastRoom, clock, ids } = startMatch(['Ann', 'Ben']);
    room.report('pid-0', report(lastRoom(), 1));
    seen.set('pid-0', clock.now);
    expect(room.nextPurgeAt()).toBe(clock.now + HOST_SILENT_MS);
    expect(room.purge(clock.now + HOST_SILENT_MS - 1)).toBe(false);
    expect(room.purge(clock.now + HOST_SILENT_MS)).toBe(true);
    expect(lastRoom()).toMatchObject({ phase: 'lobby', host: ids[1] });
  });

  it('carries a match over a restart, and ends it when the host does not come back', () => {
    const before = startMatch(['Ann', 'Ben']);
    before.room.report('pid-0', report(before.lastRoom(), 3, { k: 500 }));
    const snap = JSON.parse(JSON.stringify(before.room.snapshot())) as RoomSnapshot;

    const { room, lastRoom, clock } = makeRoom();
    room.restore(snap, new Set(['pid-1']), clock.now, new Map());
    expect(room.roomMsg()).toMatchObject({ phase: 'playing', match: 1, v: 3, k: 500, host: before.ids[0] });
    room.purge(clock.now + HOST_GRACE_MS);
    expect(lastRoom()).toMatchObject({ phase: 'lobby', host: before.ids[1] });
  });

  it('play again returns everyone to a fresh lobby, without the people who dropped', () => {
    const { room, lastRoom, clock, ids } = startMatch(['Ann', 'Ben', 'Cat']);
    room.leave('pid-2', clock.now);
    const seats = [seat({ score: 4, lives: 3 }), seat({ score: 2, lives: 0, out: true }), seat({ linked: false })];
    room.report('pid-0', report(lastRoom(), 1, { phase: 'over', winner: ids[0], seats }));
    room.again('pid-0');
    expect(lastRoom()).toMatchObject({ phase: 'lobby', winner: null, seats: 2, timer: 0 });
    expect(lastRoom().players.map((p) => [p.name, p.seat, p.score, p.lives, p.out])).toEqual([
      ['Ann', 0, 0, 7, false],
      ['Ben', 1, 0, 7, false],
    ]);
  });

  it('gives people who watched a seat ahead of everyone else at play again', () => {
    const r = makeRoom();
    for (let i = 0; i < 13; i++) r.room.join(`pid-${i}`, `P${i}`);
    r.room.start('pid-0');
    r.room.report('pid-0', report(r.lastRoom(), 1, { phase: 'over', winner: r.lastRoom().players[0].id }));
    r.room.again('pid-0');
    const seats = Object.fromEntries(r.lastRoom().players.map((p) => [p.name, p.seat]));
    expect(seats.P12).toBe(0);
    expect(Object.values(seats).filter((s) => s < 0)).toHaveLength(1);
    expect(r.lastRoom()).toMatchObject({ phase: 'lobby', winner: null });
  });
});

describe('Room pings', () => {
  it('shows pings to everyone, keeps them out of storage, and only rebroadcasts real changes', () => {
    const { room, sent, lastRoom, clock } = makeRoom();
    room.join('pid-a', 'Ann');
    room.join('pid-b', 'Ben');
    room.addBot('pid-a', 'easy');
    const broadcasts = () => sent.filter((m) => m.t === 'room').length;
    const pings = () => lastRoom().players.map((p) => p.ping);

    const before = broadcasts();
    room.reportPing('pid-b', 100.4);
    expect(pings()).toEqual([-1, 100, -1]);
    room.reportPing('pid-b', 119);
    room.reportPing('pid-b', 120);
    room.reportPing('pid-b', 143);
    room.reportPing('pid-b', 144);
    expect(broadcasts()).toBe(before + 3);
    expect(pings()).toEqual([-1, 144, -1]);
    expect(room.snapshot().players[1]).not.toHaveProperty('ping');

    room.leave('pid-b', clock.now);
    room.join('pid-b', 'Ben');
    expect(pings()).toEqual([-1, -1, -1]);
  });
});

describe('Room bots', () => {
  it('lets only the host add and remove bots, up to the twelve seats', () => {
    const { room, lastRoom } = makeRoom();
    room.join('pid-0', 'Host');
    room.join('pid-1', 'Guest');
    room.addBot('pid-1', 'easy');
    room.addBot('pid-0', 'impossible');
    expect(lastRoom().players).toHaveLength(2);

    room.addBot('pid-0', 'hard');
    expect(lastRoom().players[2]).toMatchObject({ bot: 'hard', seat: 2, connected: true });
    for (let i = 0; i < 12; i++) room.addBot('pid-0', 'medium');
    expect(lastRoom().players).toHaveLength(12);

    const bot = lastRoom().players[2];
    room.removeBot('pid-1', bot.id);
    room.removeBot('pid-0', bot.id);
    expect(lastRoom().players.some((p) => p.id === bot.id)).toBe(false);
    expect(lastRoom().seats).toBe(11);
  });

  it('lets one person start a match against a bot, and forgets the bots when the person leaves', () => {
    const { room, lastRoom, clock } = makeRoom();
    room.join('pid-0', 'Solo');
    room.addBot('pid-0', 'easy');
    room.start('pid-0');
    expect(lastRoom().phase).toBe('countdown');
    room.leave('pid-0', clock.now, true);
    expect(room.players).toEqual([]);
  });
});
