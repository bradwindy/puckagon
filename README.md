# Puckagon

Neon air hockey for 2 to 12 players in the browser. The table has one side per player, each with a goal. Two players get a normal rectangle, three get a triangle, four a square, and so on up to a 12-gon.

Play at https://puckagon.bradwindy.workers.dev. Press Create party, send the link to your friends, and the host presses Start. No friends around? The host can add Easy, Medium or Hard bots to fill seats or play solo.

## How to play

- Move your mallet with the mouse, or drag with a finger on a phone.
- Your goal is always at the bottom of your screen.
- In "First to N" the last player to touch the puck scores when it goes into any goal. If you graze a shot on its way into your own goal, the point still goes to whoever touched it before you. It only counts as an own goal, worth nothing, when nobody else touched the puck since it was served. The default target is 7.
- In "Lives" everyone starts with N lives and loses one per goal conceded. At zero your goal turns into a wall. The last player standing wins.
- After a goal the player who conceded gets the puck, set down in front of their goal.

The host can change the scoring mode, the target, the mallet zone (your own slice of the table, or anywhere), puck speed, goal size and mallet size, and can add or remove bots. Anyone who joins mid-match watches and gets a seat next round. If your connection drops mid-match you have 15 seconds to rejoin before your goal becomes a wall. Pressing Leave makes it a wall straight away.

Bots run on the server like any other player. Easy bots move slowly, react late and aim loosely. Hard bots are quick, read where the puck is going and aim at other players' goals.

## How it works

The whole game is one Cloudflare Worker.

- `src/client` is the browser game. It draws with Canvas 2D, synthesises sound with Web Audio, and needs no other libraries.
- `src/worker` holds the Worker, one Durable Object class, `Party`, and the bot logic. Each party code maps to its own Durable Object through `getByName(code)`. It runs the physics at 60 Hz and sends snapshots at 30 Hz over WebSockets.
- `src/shared` holds code that both sides run. That covers table geometry, physics, settings and the message protocol.

The server is authoritative. Clients send their pointer position at up to 30 Hz, draw their own mallet straight from the pointer, and draw everything else about 75 ms behind the server so motion stays smooth.

Some details follow the current Cloudflare guidance:

- Sockets use the WebSocket Hibernation API, so an idle lobby costs nothing. The physics `setInterval` only exists while a match is running.
- Physics advances by a fixed 1/60 s per tick. `Date.now()` does not advance inside a Worker invocation, so wall-clock deltas would be wrong in production.
- Lobby state is written to the Durable Object's SQLite storage only when something changes, never per tick.
- The Worker checks the upgrade header, origin, party code and protocol version before a request reaches a Durable Object.
- Static assets are served without running the Worker. Only `/api/*` runs it.

## Development

Needs Node 22.13 or newer, 24, or 26 and up.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run check
```

`npm run dev` serves the game at http://localhost:5173 with the Worker and Durable Object running locally in `workerd`. `npm run check` runs the type check, lint and tests. The tests run inside the Workers runtime through `@cloudflare/vitest-plugin`. They include a two-player match over real WebSockets and a party that is put to sleep and woken up again.

After changing `wrangler.jsonc`, regenerate the binding types with `npm run types`.

## Deploying

Pushes to `main` deploy through Workers Builds, Cloudflare's Git integration. Branch pushes get a preview with their own Durable Objects. To deploy by hand from a machine signed in with `npx wrangler login`:

```bash
npm run deploy
```

Every deploy restarts the Durable Objects, so live games drop. Players reconnect into the lobby and keep their places.

The repo has no secrets. The Cloudflare account comes from the wrangler login or the `CLOUDFLARE_ACCOUNT_ID` environment variable, never from config.

## Licence

MIT
