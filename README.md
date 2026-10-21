# Puckagon

Neon air hockey for 2 to 12 players in the browser. The table has one side per player, each with a goal. Two players get a normal rectangle, three get a triangle, four a square, and so on up to a 12-gon.

Play at https://puckagon.bradwindy.workers.dev. Press Create party, send the link to your friends, and the host presses Start. No friends around? The host can add Easy, Medium or Hard bots to fill seats or play solo.

## How to play

- Move your mallet with the mouse, or drag with a finger on a phone.
- Your goal is always at the bottom of your screen.
- In "First to N" the last player to touch the puck scores when it goes into any goal. If you graze a shot on its way into your own goal, the point still goes to whoever touched it before you. It only counts as an own goal, worth nothing, when nobody else touched the puck since it was served. The default target is 7.
- In "Lives" everyone starts with N lives and loses one per goal conceded. At zero your goal turns into a wall. The last player standing wins.
- After a goal the player who conceded gets the puck, set down in front of their goal.

The host can change the scoring mode, the target, the mallet zone (your own slice of the table, or anywhere), puck speed, goal size and mallet size, and can add or remove bots. Anyone who joins mid-match watches and gets a seat next round. If your link to the host drops mid-match you have 15 seconds to get it back, by reloading if you need to, before your goal becomes a wall. Pressing Leave makes it a wall straight away.

The party host's browser runs the match, so the host keeps that tab open until the match ends. A laptop or desktop makes a good host, even with the tab in the background. A phone makes a poor one, because it stops running the page soon after the screen locks or you switch apps. During a match the game asks the browser to keep the screen on when the host is on a phone or tablet. If the host presses Leave, drops off for 5 seconds, or their page stops running for 20 seconds, the match ends and everyone goes back to the lobby with a new host.

Your ping to the host shows in the top bar, and everyone's shows beside their name in the lobby. The host's own ping is 0. Players at 150 ms or more get a red LAG tag on the table. A VPN often adds a lot.

Bots run in the host's browser along with the rest of the match. Easy bots move slowly, react late and aim loosely. Hard bots are quick, read where the puck is going and aim at other players' goals.

## How it works

The game is one Cloudflare Worker and the players' browsers. The party host's browser runs each match, and everyone else plays over a direct WebRTC link to it, so gameplay never goes through Cloudflare unless a network needs a relay.

- `src/client` is the browser game. It draws with Canvas 2D, synthesises sound with Web Audio, and needs no other libraries. `src/client/host.ts` is the host's side of the game links and `src/client/peer.ts` is one link.
- `src/host` is the match: physics, serving, scoring, lives and bots. The host's page runs it at 60 Hz in a Web Worker, whose timers keep time when the tab is in the background.
- `src/worker` holds the Worker and one Durable Object class, `Party`. Each party code maps to its own Durable Object through `getByName(code)`. It keeps the lobby (players, names, seats, settings, bots and who is host), relays WebRTC signalling between pages, hands out STUN and TURN servers, and mirrors the match state the host reports, so people who join mid-match see the scores. It runs no physics.
- `src/shared` holds code that more than one of them runs. That covers table geometry, physics, settings and the message protocol.

Every page keeps a WebSocket to its party. Each guest also opens a game link to the host: an `RTCPeerConnection` with two data channels that both ends make with fixed ids. `control` is reliable and ordered, and carries match state, goals, hit sounds and Leave. `state` is unordered and never resends, like UDP, and carries snapshots, inputs and pings. The guest always makes the offer and the host only answers. Links are made in the lobby, so a match starts with them up. A guest whose link fails, or doesn't open within 10 seconds, builds a new one.

The host's browser is authoritative. Players sample the pointer at 60 Hz and send each sample as it is taken. Each guest message repeats every sample the host hasn't acknowledged yet, so a lost message costs nothing, and the host skips the ones it already has. The host applies one sample per tick from a short queue. When a player's queue keeps a spare sample for 8 ticks, the host skips one, so the queue stays short. Each snapshot says which of your samples the host has applied. A snapshot that arrives after a newer one is dropped.

Everything in a match is drawn in your own time, the way Rocket League and Haxball do it (`src/client/predict.ts`). Each frame your browser runs the shared physics forward from the newest snapshot, with the samples the host hasn't applied yet and with other mallets carrying on as they last moved. Your hits react when your mallet meets the puck, and the puck moves at a steady speed. When an opponent's real move differs from the guess, the correction fades out over about 80 ms. Spectators and knocked-out players see the host's view a little in the past, with a delay that adapts to how much the connection jitters. Add `?ahead=40` to the page URL to draw a match at most 40 ms ahead of the host instead: other players' hits correct less, and your mallet trails your hand by the difference.

Most pairs of browsers can connect directly, with Cloudflare's free STUN server telling each one its public address. Some networks block that, so the party also gives every page a Cloudflare TURN relay, which is anycast and also listens on TLS port 443. Only relayed traffic uses the TURN allowance. Pages get the TURN credential over their party WebSocket, never from an open endpoint. A party asks Cloudflare for one valid for 12 hours and gives the same one to every page that connects in the next 6, then asks for a new one. Without the TURN key (local dev and branch previews) pages get STUN only, so players behind strict networks can't connect there. Add `?relay=1` to the page URL to send your game links only through the relay, to try the path strict networks need. Where no relay is set up, the page says so.

Some details follow the current Cloudflare guidance:

- Sockets use the WebSocket Hibernation API, so an idle lobby costs nothing. During a match a timer keeps the Durable Object awake to notice a host that has gone.
- Pages ping the party every 5 seconds, and the runtime's automatic `ping`/`pong` reply answers without waking the Durable Object. The party reads the time of the host's last reply to tell a frozen host page from a live one. While hosting, the page also pings on a beat from its match worker, whose timers keep time in a background tab.
- The match advances by a fixed 1/60 s per tick. The loop is a `setTimeout` chain that aims at each tick boundary and runs the ticks the clock says are due. A plain `setInterval(fn, 1000 / 60)` runs at 62.5 Hz, because the delay is rounded down to whole milliseconds.
- The host reports the match state only when it changes (a serve, a goal, a knockout, a link going up or down, the end), and lobby state is written to the Durable Object's SQLite storage only when something changes.
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

`npm run dev` serves the game at http://localhost:5173 with the Worker and Durable Object running locally in `workerd`. Open it in two browser tabs to try a host and a guest on one machine. `npm run check` runs the type check, lint and tests. The tests run inside the Workers runtime through `@cloudflare/vitest-plugin`. They cover the lobby and its signalling relay over real WebSockets, a party that restarts mid-match, and the host's match rules tick by tick.

```bash
npm run e2e
```

`npm run e2e` starts the dev server and uses Playwright to play a whole match between two browser windows, a host with a bot and a guest who joins by the party link. It checks that the guest's game link carried data both ways and that no snapshot or input went over the party WebSocket. It runs on your installed Google Chrome and never downloads Playwright's own browsers.

To feel a slow connection, add `?lag=250` to the page URL, and `&jitter=30` for an unsteady one. Everything the page sends and receives, on the party socket and the game link, is then held back by half the lag each way. Jitter can reorder snapshots and inputs, as a real network does. It works on the live site too.

After changing `wrangler.jsonc`, regenerate the binding types with `npm run types`.

## Deploying

Pushes to `main` deploy through Workers Builds, Cloudflare's Git integration. Pushes to any other branch upload a preview version with its own Durable Objects, without touching the live site. To deploy by hand from a machine signed in with `npx wrangler login`:

```bash
npm run deploy
```

Every deploy restarts the Durable Objects, so every party socket drops and reconnects, and players keep their places. Matches run in the host's browser and the game links don't go through the Durable Object, so a match in play carries on if the host's page is back within 5 seconds. A deploy that bumps `PROTOCOL_VERSION` tells every page to reload, which ends the matches in play.

The repo has no secrets. The Cloudflare account comes from the wrangler login or the `CLOUDFLARE_ACCOUNT_ID` environment variable, never from config.

The TURN key is the one secret, and it lives only in Cloudflare as two Worker secrets. Create a TURN key in the Cloudflare dashboard under Realtime, then set its ID and API token on the Worker:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Deploys keep secrets. Branch previews have their own secret settings, so without them a preview hands out STUN only. Locally, the dev server runs without a TURN key.

## Licence

MIT
