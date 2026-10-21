import { describe, expect, it } from 'vitest';
import { COUNTDOWN_MS, LOBBY_GRACE_MS, RECONNECT_GRACE_MS, TICK_HZ, type RoomMsg, type ServerMsg } from '../src/shared/protocol';
import { resolveGoal } from '../src/shared/rules';
import { Room } from '../src/worker/room';

const STEP_MS = 1000 / TICK_HZ;

/** Small seeded generator, so bot matches play out the same way on every run. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

function makeRoom(random: () => number = () => 0.5) {
  const sent: ServerMsg[] = [];
  let ids = 0;
  const room = new Room({
    send: (_pid, msg) => sent.push(msg),
    broadcast: (msg) => sent.push(msg),
    random,
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
    w.touches = [hitter];
    w.mallets = w.mallets.map(() => null);
    for (let i = 0; i < 300 && room.phase === 'playing'; i++) tick();
  };
  return { room, sent, lastRoom, clock, tick, tickFor, shootAt };
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
  it('credits the last toucher other than the conceder, and nobody for own goals or untouched pucks', () => {
    expect(resolveGoal('points', 2, [0])).toEqual({ scorer: 0, kind: 'score' });
    expect(resolveGoal('points', 2, [2, 0, 1])).toEqual({ scorer: 0, kind: 'score' });
    expect(resolveGoal('points', 2, [2])).toEqual({ scorer: -1, kind: 'own' });
    expect(resolveGoal('points', 2, [])).toEqual({ scorer: -1, kind: 'none' });
    expect(resolveGoal('lives', 2, [2, 1])).toEqual({ scorer: 1, kind: 'life' });
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

  it('never credits a player who has been knocked out with a later goal', () => {
    const { room, clock, tickFor, shootAt, lastRoom } = startMatch(['Ann', 'Ben', 'Cat'], { target: 3 });
    for (let i = 0; i < 2; i++) shootAt(1, 2);
    for (let i = 0; i < 300 && room.phase !== 'playing'; i++) tickFor(STEP_MS);
    const w = room.world!;
    // Cat's parked mallet touches the puck, then Cat's grace runs out while the puck is held still.
    w.touches = [2];
    w.lastHitter = 2;
    w.frozen = true;
    room.leave('pid-2', clock.now);
    tickFor(RECONNECT_GRACE_MS + 100);
    expect(lastRoom().players[2].out).toBe(true);
    const side = w.layout.sides[w.layout.goalSide[0]];
    w.puck = { x: 0, y: 0, vx: -side.normal.x * 2, vy: -side.normal.y * 2 };
    w.mallets = w.mallets.map(() => null);
    w.frozen = false;
    tickFor(1500);
    expect(lastRoom().players[2].score).toBe(2);
    expect(lastRoom().phase).not.toBe('over');
  });

  it('keeps the match going when everyone drops at once, as long as they come back in time', () => {
    const { room, clock, tickFor, lastRoom } = startMatch(['Ann', 'Ben'], { target: 15 });
    room.leave('pid-0', clock.now);
    room.leave('pid-1', clock.now);
    tickFor(1000);
    room.join('pid-0', 'Ann');
    room.join('pid-1', 'Ben');
    expect(lastRoom()).toMatchObject({ phase: expect.stringMatching(/playing|scored/) });
    expect(lastRoom().players.map((p) => p.id)).toEqual(['id0', 'id1']);
  });

  it('forgets the party once everyone has gone for good', () => {
    const { room, clock, tickFor } = startMatch(['Ann', 'Ben'], { target: 15 });
    room.leave('pid-0', clock.now);
    room.leave('pid-1', clock.now);
    tickFor(RECONNECT_GRACE_MS + 100);
    expect(room.players).toEqual([]);
    expect(room.phase).toBe('lobby');
  });

  it('lets a dropped player reclaim their seat within the grace period', () => {
    const { room, clock, tickFor, lastRoom } = startMatch(['Ann', 'Ben'], { target: 15 });
    room.leave('pid-1', clock.now);
    tickFor(2000);
    room.join('pid-1', 'Ben');
    tickFor(RECONNECT_GRACE_MS);
    expect(lastRoom().players[1]).toMatchObject({ seat: 1, out: false, connected: true });
  });

  it('gives people who watched a seat ahead of everyone else at play again', () => {
    const r = makeRoom();
    for (let i = 0; i < 13; i++) r.room.join(`pid-${i}`, `P${i}`);
    r.room.updateSettings('pid-0', { target: 3 });
    r.room.start('pid-0');
    r.tickFor(COUNTDOWN_MS);
    for (let i = 0; i < 3; i++) r.shootAt(1, 0);
    r.room.again('pid-0');
    const seats = Object.fromEntries(r.lastRoom().players.map((p) => [p.name, p.seat]));
    expect(seats.P12).toBe(0);
    expect(Object.values(seats).filter((s) => s < 0)).toHaveLength(1);
  });

  it('play again returns everyone to a fresh lobby', () => {
    const { room, shootAt, lastRoom } = startMatch(['Ann', 'Ben'], { target: 3 });
    for (let i = 0; i < 3; i++) shootAt(1, 0);
    room.again('pid-0');
    expect(lastRoom()).toMatchObject({ phase: 'lobby', winner: null });
    expect(lastRoom().players.map((p) => p.score)).toEqual([0, 0]);
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

  it('bots of each level play a full match to the end without a person touching the puck', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const r = makeRoom(seeded(7));
      r.room.join('pid-0', 'Idle');
      r.room.addBot('pid-0', level);
      r.room.addBot('pid-0', level);
      r.room.updateSettings('pid-0', { target: 3 });
      r.room.start('pid-0');
      for (let i = 0; i < 5 * 60 * TICK_HZ && r.room.phase !== 'over'; i++) r.tick();
      expect(r.room.phase).toBe('over');
      const goals = r.sent.filter((m) => m.t === 'goal');
      expect(goals.filter((g) => g.t === 'goal' && g.kind === 'score').length).toBeGreaterThanOrEqual(3);
    }
  });
});
