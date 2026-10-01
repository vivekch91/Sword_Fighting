# ⚔ Sword Arena

A small, real-time, **3-player free-for-all sword fighting game** that runs in the browser. It's a 2D top-down game with a server-authoritative Node.js backend, WebSockets, client-side prediction and snapshot interpolation. There are no accounts, no database and nothing for players to install.

- **Stack:** TypeScript · HTML5 Canvas · Node.js 20+ · `ws` (the only runtime dependency)
- **Match:** 3 players in a room → best of 3 (first to 2 round wins) → rematch

---

## Install

```bash
npm install
```

Requires Node.js **20 or newer**.

## Local play (development)

```bash
npm run dev
```

Then open <http://localhost:3000> in **three browser tabs** (or three browsers):

1. In tab 1, enter a name and click **Create room**. You get a room code (e.g. `K7QPX`), and **Copy invite link** copies a link that pre-fills it.
2. In tabs 2 and 3, enter a name and the code, then click **Join**.
3. Everyone clicks **Ready**. The match starts when all 3 are ready. For quick testing, the host can click **Start with 2 players** when only 2 have joined.

`npm run dev` rebuilds the client on file changes (refresh the browser after editing) and restarts the server when server/shared code changes.

### Simulated latency

```bash
npm run dev:lag                                  # ~100 ms RTT + up to 30 ms jitter each way
npm run dev -- --lag 200 --jitter 50             # custom values
node dist/server.js --lag 100 --jitter 30        # against a production build
```

The server delays every inbound and outbound message by `lag/2 + random(0..jitter)` while keeping message order, the same way TCP does. The ping indicator (top-right) shows the resulting round trip.

## LAN play (same Wi-Fi / network)

```bash
npm run start
```

`start` builds the project and then serves the client and the WebSocket on **one port** (default `3000`, override with `PORT=8080` or `--port 8080`). On startup it prints the addresses to share:

```
⚔  Sword Arena server running
   Local:   http://localhost:3000
   LAN:     http://192.168.1.23:3000
```

Other players open the **LAN** URL in their browser. If they can't connect, allow Node.js through the host machine's firewall (on Windows, accept the prompt on first run).

## Internet play (Render, free tier)

> ⚠️ **Untested from the build environment.** The config and steps below follow Render's documented Blueprint format, but they were not deployed during development.

The repo includes `render.yaml` (a Render Blueprint):

1. Push this repo to GitHub (or GitLab).
2. On <https://dashboard.render.com>, click **New → Blueprint**, pick the repo, and confirm. Render reads `render.yaml`:
   - build: `npm ci --include=dev && npm run build`
   - start: `node dist/server.js` (Render injects `PORT`)
   - health check: `/healthz`
3. When the deploy finishes, open `https://<your-service>.onrender.com` and share that URL.

To do it manually instead: **New → Web Service**, runtime *Node*, with the same build and start commands and the *Free* instance type. WebSockets work on Render web services with no extra setup.

**No hard-coded hosts:** the client builds its WebSocket URL from the page origin (`wss://<host>/ws` on HTTPS, `ws://<host>/ws` on HTTP), so the same build works on localhost, on a LAN IP and on Render.

**Free-tier note:** Render spins free services down after ~15 minutes without traffic. The first visit afterwards takes ~30–60 s to wake the server. A spin-down also ends any rooms in progress.

---

## Controls

| Input | Action |
|---|---|
| **W A S D** (or arrows) | Move |
| **Mouse** | Aim (your fighter faces the cursor) |
| **Left click** | Light attack: fast, 10 dmg, 12 stamina |
| **Hold right click (~0.5 s)** | Heavy attack: telegraphed red wind-up, 30 dmg, 30 stamina. Releasing early cancels it for free |
| **Shift (hold)** | Block: −80% damage from the front (140° arc), drains stamina, slows you to 45% speed |
| **Space** | Dodge roll: short dash with invulnerability frames, 22 stamina, ~0.8 s cooldown |

Rules:

- HP is 100. Stamina regenerates after a short pause. Every action needs its full stamina cost.
- Each hit applies brief hit-stun and knockback.
- If you hit a **blocking** player from the front with a **heavy**, *you* are staggered (light attacks don't stagger).
- A round ends when one fighter is left standing. Eliminated players spectate. The scoreboard shows round wins, the next round starts after 3 s, and the first to 2 round wins takes the match. Everyone then votes **Rematch**.

HUD: your HP and stamina bars and dodge status (bottom-left), name and HP above other fighters, round number and score pips (top), ping and FPS (top-right).

---

## Tuning gameplay

All gameplay and network constants are in **`shared/constants.ts`**. The server and the client prediction both import this file, so any change applies to both. Restart `npm run dev` (or rebuild) after editing.

| Constant | What it controls |
|---|---|
| `MOVE_SPEED`, `*_SPEED_MULT` | Walk speed and slow-downs while blocking or attacking |
| `LIGHT`, `HEAVY` | `cost`, `damage`, `windup`/`charge`, `active`, `recovery` (in ticks; 30 ticks = 1 s), `range`, `arc` (radians), `knockback`, `stun` |
| `BLOCK_DAMAGE_MULT`, `BLOCK_ARC`, `BLOCK_DRAIN`, `STAGGER_TICKS` | Blocking |
| `DODGE` | `cost`, `duration`, `iframes`, `speed`, `cooldown` |
| `MAX_HP`, `MAX_STAMINA`, `STAMINA_REGEN`, `STAMINA_REGEN_DELAY` | Stats |
| `ROUNDS_TO_WIN`, `ROUND_END_TICKS`, `REJOIN_WINDOW_MS` | Match flow |
| `OBSTACLES`, `SPAWNS`, `ARENA_W/H` | Arena layout |
| `TICK_RATE`, `INTERP_DELAY_MS`, `MAX_INPUTS_PER_TICK` | Netcode |

---

## Architecture

```
shared/   constants.ts  types.ts (state + message schemas)
          sim.ts        deterministic stepPlayer(): movement, collisions, stamina, action state machine
          combat.ts     arc hitbox, block check, i-frames, damage/knockback/stagger resolution
server/   index.ts      HTTP static server + 30 Hz fixed-timestep loop + LAN URL printout
          net.ts        WebSocket gateway, message validation, rate limit, latency simulation
          rooms.ts      room codes, name sanitising, cleanup
          room.ts       lobby → playing → roundEnd → matchEnd, input queues, hit resolution, rejoin reservations
client/   main.ts       lobby UI, connection/reconnect, fixed 30 Hz input loop, render loop
          game.ts       prediction + reconciliation (own fighter), 100 ms interpolation (others)
          input.ts      keyboard/mouse sampling with a short press buffer
          render.ts     Canvas renderer + HUD
          static/       index.html, style.css
```

**Server authority.** Clients send only input intents: a move direction (−1/0/1), aim angle, and button flags with a sequence number. The server keeps a short input queue per player and consumes **at most 2 inputs per tick**, so sending more inputs can't make you move faster. Each input is applied with the fixed `DT`, and speed comes only from server-side constants. Cooldowns, stamina, hit detection and damage are evaluated on the server only. Messages are size-limited (4 KB), rate-limited (120/s) and validated: malformed inputs are dropped, axes are clamped, the aim angle is normalised, and replayed sequence numbers are ignored.

**Prediction.** The client runs the same `stepPlayer()` on its own inputs right away. Each snapshot carries `ack`, the last input the server processed. The client resets its fighter to the server's state and replays the inputs the server hasn't processed yet. Any remaining correction (usually from being hit) is blended out visually over ~80 ms. In testing at 100 ms + jitter, plain movement produced **zero** corrections.

**Interpolation.** Snapshots are stamped with the server tick. The client estimates a clock offset and draws other players 100 ms in the past, interpolating between the two snapshots around that time. Hit effects are delayed to match that timeline.

### Message protocol (JSON over `/ws`)

| Direction | Message |
|---|---|
| C→S | `create{name}` · `join{code,name}` · `ready{ready}` · `start2` · `input{seq,mx,my,aim,light,heavy,block,dodge}` · `rematch` · `leave` · `ping{ct}` |
| S→C | `joined{you,code,rejoined}` · `lobby{room}` (players, ready, colours, wins, host, phase) · `error{msg}` · `snap{tick,ack,phase,round,phaseTicks,roundWinner,matchWinner,players[],events[]}` (30 Hz) · `pong{ct}` |

### Disconnects

- **Lobby:** the player is removed right away and host passes to the next player.
- **Mid-match:** the fighter is removed from the arena and the slot is held for **30 s**. Joining again with the **same name and code** restores the player's score, colour and fighter (or spectating until the next round if the round has changed). The client reconnects automatically.
- If fewer than 2 players remain connected, the match ends and the remaining player is declared the winner.
- Empty rooms are deleted. Joining a full room returns *"Room is full (3/3)"*, and joining a room mid-match returns *"Match already in progress in this room."*

---

## Testing & quality

```bash
npm run build      # tsc --noEmit (strict) + esbuild bundles → dist/
npm run lint       # ESLint (typescript-eslint)
npm test           # vitest: 33 tests
```

- `test/combat.test.ts`: hit arc (range, cone, behind), one hit per swing, wind-up has no hitbox, heavy charge/cancel, block reduction (front vs back), heavy-blocked stagger, block slow and drain, dodge i-frames and cooldown, stamina gating and regen, input sanitising and speed bound.
- `test/room.test.ts`: full/duplicate/in-progress rejection, ready start, host-only start-with-2, input flood cap, replayed sequence numbers, acks, rounds → match → rematch, rejoin within 30 s, reservation expiry, fewer than 2 players ends the match, cleanup.
- `test/gateway.test.ts`: a real WebSocket round trip, malformed messages, unknown room, empty-room cleanup.

Optional browser end-to-end scripts (not part of `npm test`; they need `npm i -D playwright && npx playwright install chromium`):

- `scripts/e2e/e2e.cjs <url>`: 3 bot-driven tabs play a full match. It checks 4th-player and in-progress rejection, rematch, and close-tab → rejoin, and saves screenshots.
- `scripts/e2e/lag.cjs <url>`: measures prediction corrections and remote-player smoothness. Run it against a server started with `--lag 100 --jitter 30`.

Results in the build environment (headless Chromium, software rendering):

- The full best-of-3 match, rematch and rejoin all completed.
- At ~137 ms measured RTT: 0 px prediction error while moving, and remote players never moved faster than the 620 px/s dodge speed between frames (no teleporting).
- A single tab ran at 60 FPS with ~0.4 ms average draw time.

---

## Decisions

These are the places where the spec was ambiguous or contradictory. In each case the simpler option was chosen:

1. **"Best of 3" with 3 players** can't always be settled in 3 rounds (A, B and C could each win one). The match is therefore **first to 2 round wins**. A simultaneous KO counts as a draw round, and nobody scores.
2. **Inputs are sampled at the 30 Hz simulation rate**, not every render frame. Every input maps to exactly one fixed simulation step, which keeps prediction deterministic and lets the server cap the input rate. Rendering still runs at the display rate.
3. **Heavy attack:** pressing right-click starts a visible wind-up. You have to keep holding for 0.5 s for the swing to fire. Releasing early cancels it at no cost, and stamina is charged when the swing fires.
4. **Stamina gating:** an action needs its *full* cost, which is stricter than "unavailable at 0". Blocking needs stamina above 0. Blocked hits also drain stamina, and reaching 0 breaks the guard.
5. **Input buffering:** a light-attack or dodge press is remembered for 5 ticks (~170 ms), so it fires as soon as the current action ends.
6. **No player-vs-player body collision.** Fighters can overlap. This keeps the client's prediction exactly in line with the server.
7. **No lag compensation (rewind) for hits.** Swings are resolved against current server positions, and the generous melee arcs absorb typical latency. Swords also pass through obstacles (no line-of-sight check).
8. **Rejoin identity is name + room code**, as specified. There's no authentication, so anyone who knows both can take a reserved slot within the 30 s window.
9. **Start with 2** is host-only and available whenever 2 players are in the lobby. It doesn't require Ready.
10. **Rematch** starts as soon as every connected player has voted (at least 2). Slots still reserved for disconnected players are dropped at that point.
11. Latency simulation is a **server-side flag** (`--lag/--jitter`), so it affects every client the same way and needs no client changes.

## Known limitations

- The Render deployment is **untested** from the build environment, and the free tier has cold starts (see above).
- Verified only in headless Chromium. Firefox, Safari and Edge use standard APIs (Canvas 2D, WebSocket, ES2020) but were not run.
- Desktop only: there are no touch controls.
- No lag compensation, so at high ping, hits can feel like they land slightly behind where the target is drawn.
- Rooms live in memory, so restarting the server ends all rooms.
- Placeholder art: circles, lines and wedges.
