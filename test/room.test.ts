import { describe, expect, it } from 'vitest';
import { COUNTDOWN_MS, LOBBY_GRACE_MS, RECONNECT_GRACE_MS, TICK_HZ, type RoomMsg, type ServerMsg } from '../src/shared/protocol';
import { resolveGoal } from '../src/shared/rules';
import { Room } from '../src/worker/room';

const STEP_MS = 1000 / TICK_HZ;

function makeRoom() {
  const sent: ServerMsg[] = [];
  let ids = 0;
  const room = new Room({
    send: (_pid, msg) => sent.push(msg),
    broadcast: (msg) => sent.push(msg),
    random: () => 0.5,
    newId: () => `id${ids++}`,
  });
  const clock = { now: 1_000_000 };
  const lastRoom = () => sent.filter((m): m is RoomMsg => m.t === 'room').at(-1)!;
  const tick = () => room.tick((clock.now += STEP_MS));
  const tickFor = (ms: number) => {
    for (let i = 0; i < Math.ceil(ms / STEP_MS) + 1; i++) tick();
  };
  /** Fires the puck from the centre straight into a seat's goal, as if `hitter` had just hit it. */
  const shootAt = (seat: number, hitter: number) => {
    for (let i = 0; i < 1000 && room.phase !== 'playing'; i++) tick();
    const w = room.world!;
    const side = w.layout.sides[w.layout.goalSide[seat]];
    w.puck = { x: 0, y: 0, vx: -side.normal.x * 2, vy: -side.normal.y * 2 };
    w.lastHitter = hitter;
    w.mallets = w.mallets.map(() => null);
    for (let i = 0; i < 300 && room.phase === 'playing'; i++) tick();
  };
  return { room, sent, lastRoom, clock, tickFor, shootAt };
}

function startMatch(names: string[], settings: object = {}) {
  const r = makeRoom();
  names.forEach((n, i) => r.room.join(`pid-${i}`, n));
  r.room.updateSettings('pid-0', settings);
  r.room.start('pid-0');
  r.tickFor(COUNTDOWN_MS);
  return r;
}

describe('resolveGoal', () => {
  it('credits the last hitter, and nobody for own goals or untouched pucks', () => {
    expect(resolveGoal('points', 2, 0)).toEqual({ scorer: 0, kind: 'score' });
    expect(resolveGoal('points', 2, 2)).toEqual({ scorer: -1, kind: 'own' });
    expect(resolveGoal('points', 2, -1)).toEqual({ scorer: -1, kind: 'none' });
    expect(resolveGoal('lives', 2, 2)).toEqual({ scorer: -1, kind: 'life' });
  });
});

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
});

describe('Room match', () => {
  it('gives the point to the last hitter and ends at the target', () => {
    const { shootAt, lastRoom } = startMatch(['Ann', 'Ben', 'Cat'], { target: 3 });
    expect(lastRoom().phase).toBe('playing');
    for (let i = 0; i < 3; i++) shootAt(1, 0);
    const end = lastRoom();
    expect(end.phase).toBe('over');
    expect(end.players.map((p) => p.score)).toEqual([3, 0, 0]);
    expect(end.winner).toBe(end.players[0].id);
  });

  it('does not score own goals', () => {
    const { shootAt, lastRoom } = startMatch(['Ann', 'Ben']);
    shootAt(1, 1);
    expect(lastRoom().players.map((p) => p.score)).toEqual([0, 0]);
  });

  it('in lives mode, closes the goal of a player who runs out and crowns the last one standing', () => {
    const { room, shootAt, lastRoom } = startMatch(['Ann', 'Ben', 'Cat'], { mode: 'lives', target: 3 });
    for (let i = 0; i < 3; i++) shootAt(2, 0);
    expect(lastRoom().players[2]).toMatchObject({ lives: 0, out: true });
    expect(room.world!.open[2]).toBe(false);
    for (let i = 0; i < 3; i++) shootAt(1, 0);
    expect(lastRoom()).toMatchObject({ phase: 'over', winner: lastRoom().players[0].id });
  });

  it('turns a dropped player into a wall after the grace period, and late joiners watch', () => {
    const { room, clock, tickFor, lastRoom } = startMatch(['Ann', 'Ben', 'Cat'], { target: 15 });
    room.join('late-joiner-pid', 'Late');
    expect(lastRoom().players.at(-1)!.seat).toBe(-1);

    room.leave('pid-1', clock.now);
    expect(room.world!.open[1]).toBe(true);
    tickFor(RECONNECT_GRACE_MS + 100);
    expect(room.world!.open[1]).toBe(false);
    expect(lastRoom().players[1]).toMatchObject({ out: true, connected: false });
    expect(lastRoom().phase).not.toBe('over');
  });

  it('lets a dropped player reclaim their seat within the grace period', () => {
    const { room, clock, tickFor, lastRoom } = startMatch(['Ann', 'Ben'], { target: 15 });
    room.leave('pid-1', clock.now);
    tickFor(2000);
    room.join('pid-1', 'Ben');
    tickFor(RECONNECT_GRACE_MS);
    expect(lastRoom().players[1]).toMatchObject({ seat: 1, out: false, connected: true });
  });

  it('play again returns everyone to a fresh lobby', () => {
    const { room, shootAt, lastRoom } = startMatch(['Ann', 'Ben'], { target: 3 });
    for (let i = 0; i < 3; i++) shootAt(1, 0);
    room.again('pid-0');
    expect(lastRoom()).toMatchObject({ phase: 'lobby', winner: null });
    expect(lastRoom().players.map((p) => p.score)).toEqual([0, 0]);
  });
});
