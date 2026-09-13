# MUKUT Dashboard — `agent-context.md`

Technical codebase map for AI coding agents working on this repository.
Companion documents (do not duplicate them; consult them when needed):

| Document | Role |
| :--- | :--- |
| `context.md` | **Authoritative product vision & spec.** Goals, scope control, dashboard requirements, telemetry contract rationale, definition of success. Read this before making product-level decisions. |
| `phasereport.md` | Phase status tracker (note: partially stale — see Gotchas) |
| `reports/phase_*.md` | Per-phase implementation & test reports |
| This file | **Technical code map.** How the code actually works: modules, APIs, protocols, config, conventions, gotchas. |

---

## 1. Project Snapshot

**Project:** MUKUT Smart Coal Miner Helmet — Real-Time Safety Dashboard & Telemetry System (`mukut-dashboard` v1.0.0).

An IoT safety-helmet monitoring system for underground coal mines: helmet + LoRa relay nodes (`NODE01`–`NODE03`) → gateway → Node.js backend → real-time web dashboard. Hackathon prototype: simulator-first architecture, hardware swappable behind a single telemetry contract.

**Status:** Phases 1–8 software-complete (Phase 7 = ML distance estimation, Phase 8 = temporal median filter, 2026-09-12). Live helmet hardware verified via Node1 WiFi (2026-09-12).

**Current runtime mode** (per `config/default.json`): `hardware.data_source = "node1"` — the backend runs the **Node1 WiFi Bridge**, polling the live surface gateway at `http://192.168.14.60/api/telemetry` every 1500 ms (helmet connected over WiFi). To return to the demo simulator, set `data_source` to `"simulator"` (or `"serial"` for USB COM7) and restart.

**Key design principle (from `context.md`):** build around telemetry, not hardware. All three data sources (simulator, USB serial, Node1 WiFi/HTTP) produce/consume the same MUKUT v1.0 JSON contract and feed the same `StateManager.processTelemetry()` entry point.

---

## 2. Repository Layout

```text
mukut-dashboard/                 (git repo, branch: main; workspace root is the parent folder)
├── package.json                 ESM ("type": "module"); scripts: start/dev/test
├── package-lock.json
├── config/
│   └── default.json             ALL runtime config: server, data source, helmet, network, thresholds
├── src/
│   ├── server/                  Node.js backend (ESM)
│   │   ├── server.js            Express + WebSocket entry point; route table; data-source selection
│   │   ├── stateManager.js      Core state machine: telemetry, alerts, routing engine, trajectory, watchdog, ML inference
│   │   ├── simulator.js         Scenario-driven telemetry, network & miner-journey simulator
│   │   ├── trajectoryEngine.js  Phase 5: dead reckoning + beacon fusion → live 2D route map
│   │   ├── calibrationEngine.js Phase 6: RSSI→distance model + calibration lock (display layer)
│   │   ├── mlEstimator.js       Phase 7: ONNX Random Forest (RSSI+SNR → distance), WASM backend
│   │   ├── signalFilter.js      Phase 8: per-link rolling median filter (spike rejection)
│   │   ├── schema.js            MUKUT v1.0 telemetry contract validator
│   │   ├── serialBridge.js      USB-serial ingestion (JSON or Node1 ASCII dashboard text)
│   │   └── node1Bridge.js       Node1 surface-gateway schema translator + HTTP poller
│   └── client/                  Vanilla HTML/CSS/JS frontend (no build step, no framework)
│       ├── index.html           Safety Overview dashboard      (+ js/app.js)
│       ├── network.html         Underground Network dashboard  (+ js/network.js)
│       ├── routing.html         Routing & Failover dashboard   (+ js/routing.js)
│       ├── route_map.html       Miner Route Map dashboard      (+ js/routeMap.js)
│       ├── css/style.css        Shared industrial dark theme
│       └── js/                  app.js | network.js | routing.js | routeMap.js (one IIFE per page)
├── hardware/                    Arduino/ESP32 firmware (C++ .ino)
│   ├── helmet_node/helmet_node.ino       Helmet transmitter (dummy sensors)
│   └── gateway_node/gateway_node.ino     Surface gateway receiver → serial JSON
├── test/                        Automated suites (phase1, phase2, phase2_e2e, phase4, phase5, phase6, ml_test, filter_validation, hardware_validation, e2e_integration)
├── test_phase3b.js              Phase 3B E2E demo-sequence verification (repo root!)
├── sniff_com7.mjs               Serial debug utility: prints 80 lines from COM7, exits
├── reports/                     phase_1, phase_2, phase_3a, phase_3b, phase_4 reports
├── phasereport.md               Phase status tracker
├── context.md                   Product vision & spec (see doc map above)
└── agent-context.md             This file
```

---

## 3. Tech Stack & Runtime Environment

**Backend:** Node.js, ES modules (`"type": "module"`). Dependencies: `express ^4.21.2`, `ws ^8.18.0`, `serialport ^13.0.0`. Uses global `fetch` + `AbortController` (node1Bridge) → **requires Node 18+**. No TypeScript, no linter, no formatter, no build step.

**Frontend:** Plain HTML/CSS/JS served statically by Express. No bundler, no framework, no npm deps. Each page = one IIFE in `src/client/js/` with a cached-DOM render loop over WebSocket state.

**Firmware:** Arduino C++ for ESP32 + RA-02 (SX1278) LoRa modules, 433 MHz.

**Host environment:** Windows (PowerShell 5.1). Repo lives under `C:\Users\Ayushman\OneDrive\Desktop\mukut\mukut-dashboard` (OneDrive-synced). Serial device is `COM7` @ 115200 baud (config).

---

## 4. Commands

```powershell
npm install                # first time (package-lock.json present)

npm start                  # = npm dev: node src/server/server.js
npm run dev                # same as start
npm test                   # runs ONLY test/phase1_test.js (see Gotcha G6)

# Individual suites:
node test/phase1_test.js           # unit: schema + StateManager + simulator
node test/phase2_test.js           # unit: network model, RSSI, routing
node test/phase4_test.js           # unit: config + Node1Bridge translation + telemetry endpoint
node test/phase5_test.js           # unit: trajectory engine, miner journey, route_map state
node test/phase6_test.js           # unit: calibration model, ceremony, lock/display layer
node test/phase2_e2e_test.js       # E2E: REST + WebSocket (needs server ALREADY RUNNING on :3000)
node test/e2e_integration_test.js  # E2E: pages + API + scenarios (needs server on :3000)
node test_phase3b.js               # E2E: routing demo sequence (needs server on :3000)

node sniff_com7.mjs        # debug: dump raw COM7 serial output (18 s / 80 lines)

# Server port override:
$env:PORT=3001; npm start  # (PowerShell; default port 3000 from config)
```

E2E suites talk to `http://localhost:3000` and do **not** boot the server themselves — run `npm start` in another terminal first.

**URLs served:**

| URL | Page |
| :--- | :--- |
| `/` , `/dashboard` | Safety Overview (`index.html`) |
| `/network` , `/dashboard/network` | Underground Network (`network.html`) |
| `/routing` , `/dashboard/routing` | Routing & Failover (`routing.html`) |
| `/routemap` , `/dashboard/routemap` | Miner Route Map (`route_map.html`) |

---

## 5. Architecture & Data Flow

```text
 DATA SOURCES (mutually exclusive per boot, chosen in server.js)
 ┌───────────────────────────────────────────────────────────────┐
 │ TelemetrySimulator   SerialBridge (USB)   Node1Bridge (HTTP)  │
 │ scenario-driven      COM7 JSON or        polls Node1 ESP32    │
 │ random-walk data     Node1 ASCII text    /api/telemetry       │
 └───────────────┬──────────────┬──────────────────┬─────────────┘
                 └──────────────┴──────────────────┘
                                  │  all converge on the SAME call:
                                  ▼
              StateManager.processTelemetry(v1.0 packet)
                                  │  (validate → update state → alerts/events
                                  │   → routing recalc → notifyListeners)
                                  ▼
              broadcast() to ALL open WebSocket clients
                                  ▼
       app.js / network.js / routing.js  →  renderState() → DOM
```

**Data-source selection logic (`server.js`):**

- `data_source` = `"hardware"` or `"serial"` → `SerialBridge` (port + baud from config).
- `data_source` = `"node1"` or `"node1_wifi"` → `Node1Bridge` (IP + poll interval from config).
- Anything else (e.g. `"simulator"`) → no bridge → `TelemetrySimulator` starts.
- `data_source` is the **single toggle**: the mere presence of `node1_ip` in config does NOT start the bridge (fixed 2026-09-12 — previously it force-started Node1Bridge and silently disabled the simulator).

**Update fan-out:** `StateManager.notifyListeners()` → single listener registered in `server.js` → `broadcast()` → every connected WS client. Message types: `STATE_UPDATE` (full state), `EVENT` (single event), `ROUTE_CHANGED` (route transition payload).

**Route mapping (Phase 5):** `processTelemetry()` also feeds `TrajectoryEngine` with the telemetry's `motion` / `orientation` / `anchors` blocks (beacon ranges — NOT network links); results ship as the `route_map` block of every state broadcast. See §6.7.

**Distance calibration (Phase 6):** every packet then passes the calibration display layer — distances become path-loss-model values from live RSSI (EMA-smoothed) or, after a calibration ceremony, frozen locked values. Links, spatial readouts and route-map beacon labels use display distances; the trajectory engine always consumes RAW telemetry. See §6.8.

---

## 6. Backend Module Reference

### 6.1 `src/server/server.js` — entry point

- Creates Express app + `http` server + `WebSocketServer` (`ws`, same port).
- Static-serves `src/client` (+ explicit `/dashboard/css`, `/dashboard/js` mounts).
- Instantiates `StateManager` (which loads `config/default.json`), `TelemetrySimulator`, and bridges per selection logic above.
- Defines REST routes and page routes (tables in §7).
- WS behavior: on connection, immediately pushes `INIT_STATE` (full state + simulator scenario). Accepts client actions `SET_SCENARIO`, `SET_NODE_STATUS`, `GET_STATE` (§8).
- `PORT` env var overrides `config.server.port` (default 3000, host `0.0.0.0`).
- Handles `EADDRINUSE` with a Windows `netstat` hint, then exits.
- Startup banner labels itself "Phase 4 Server" and prints active data sources.

### 6.2 `src/server/stateManager.js` — the core (single source of truth)

Class `StateManager`. Config loaded at **module level** from `config/default.json` (constructor accepts an override config — used by tests).

**Held state:** helmet id/online/lastSeen/status (`SAFE|WARNING|EMERGENCY`) + reason, `sos`, environment (temperature, humidity, methane, carbon_monoxide, smoke), per-gas status objects (value/status/percentage), temp/humidity status, events (capped at 50), listeners, `structuralHealth` (node2/node3: `STABLE|WARNING_SHIFT|CRITICAL_HAZARD` + level + online), `spatialPosition` (nearest_node, relative_slider_pct, dist_n2, dist_n3, fixed_dist), `activeAlerts`/`activeEmergencies` (from Node1), network state (nodes, links, health, connectedNode), route state (currentRoute, previousRoute, routeStatus, failoverActive, failedNode).

**Key methods:**

- `processTelemetry(t)` — the ingestion entry point for ALL sources. Updates helmet/lastSeen/online, environment (rounds via `toFixed`), evaluates gas/temp/humidity vs thresholds, computes overall status (SOS > CRITICAL gas/temp > WARNING > SAFE), raises transition events (incl. rich SOS dispatch event with closest rescue node), applies `t.network` (connected_node + links), then broadcasts `STATE_UPDATE`. Returns full state.
- `evaluateGasLevel(key, value)` / `evaluateRssi(rssi)` — threshold math; RSSI quality bands and percentage (§12).
- `calculateNetworkHealth()` — `OFFLINE` (helmet or NODE01 down) / `DEGRADED` (any node offline or weak/disconnected link) / `GOOD`.
- `findAllPaths` / `calculatePathCost` / `findRoute` / `recalculateRoute` — routing engine (§13).
- `updateNetworkTelemetry(linkUpdates)` — merge link RSSI/distance/status/availability by `id` or source+destination; unknown links are appended; triggers route recalc on topology change; broadcasts health events.
- `setNodeStatus(nodeId, status)` — ONLINE/OFFLINE toggle; cascades to that node's links (disconnect / reconnect-if-both-endpoints-online); events + route recalc. Used by simulator scenarios and REST/WS controls.
- `checkWatchdog()` — 1 s interval; if `lastSeen` older than `helmet.offline_timeout_ms` (10 s), helmet → OFFLINE, its links disconnected, route recalculated.
- `computeCasualtyAssessment()` — builds active-node list (NODE03/NODE02/NODE01) with distance/RSSI/hazard; picks closest (by distance, else RSSI); flags hazards; used for SOS/structural emergency dispatch messages and the client's rescue panel.
- `updateStructuralHealth(h)` / `updateSpatialPosition(p)` / `setNode1Alerts(a, e)` — Node1-bridge extensions.
- `addEvent(severity, message)` — severity `INFO|WARNING|EMERGENCY`; newest-first; cap 50; emits `EVENT` to listeners.
- `getFullState()` — canonical snapshot consumed by REST + WS + clients (includes `network.route`, counts, top-20 events, thresholds).
- `reset()` — restores nominal values + `initNetworkState()`; used by simulator RESET scenarios.
- `trajectoryEngine` (Phase 5) — dead-reckoning + beacon-fusion route map; updated inside `processTelemetry()` (guarded by try/catch), exposed as `route_map` in `getFullState()`, cleared by `reset()`. See §6.7.
- `calibrationEngine` (Phase 6) — RSSI→distance display layer + calibration lock; sampled in `processTelemetry()` before display overrides, exposed as `calibration` in `getFullState()`, cleared by `reset()`. See §6.8.

### 6.3 `src/server/simulator.js` — `TelemetrySimulator`

Ticks every `helmet.heartbeat_interval_ms` (2000 ms). Realistic random-walk (`walk()`) within per-scenario bounds.

Valid scenarios (`setScenario`, REST + WS): `NORMAL`, `NETWORK_NORMAL`, `GAS_WARNING`, `GAS_CRITICAL`, `SOS`, `HELMET_OFFLINE`, `WEAK_LINK`, `NODE02_OFFLINE`, `NODE03_FAILURE`, `NO_ROUTE`, `NODE02_RESTORE`, `RESET`, `RESET_NETWORK`, `MINER_WALK_IN`, `MINER_WALK_OUT`, `MINER_STATIONARY`.

Behavior notes:

- `GAS_WARNING` walks methane 320–450; `GAS_CRITICAL` 650–850 (ppm — matches thresholds 300/600).
- `HELMET_OFFLINE`: tick returns early → no telemetry → watchdog flips helmet OFFLINE after the 10 s timeout.
- `NODE02_OFFLINE` / `NODE03_FAILURE` / `NO_ROUTE` call `setNodeStatus(..., 'OFFLINE')` on the relevant node(s) and disconnect their links.
- `WEAK_LINK` drives helmet→NODE03 RSSI into −86…−89 dBm (WEAK band).
- `NORMAL`/`NETWORK_NORMAL`/`RESET`/`RESET_NETWORK`/`NODE02_RESTORE` restore baselines; `NODE02_RESTORE` explicitly sets NODE02 back ONLINE, others call `stateManager.reset()`.
- Emits the same 4 narrative links as the default config topology (helmet→N3, N3→N2, N2→N1, N3→N1 bypass); it never emits direct helmet→NODE02/NODE01 links — only the Node1 bridge adds those (§16 G10).
- Route mapping (Phase 5): a scripted miner walks the tunnel polyline (`sim_walk_speed_mps` with jitter + lateral sway); every packet carries `motion` / `orientation` / geometry-derived `anchors`, and `link_helmet_node03` distance + RSSI track the live position (RSSI derivation is skipped under `WEAK_LINK`). RESET restores the working-face baseline and clears the trajectory.

### 6.4 `src/server/schema.js` — `validateTelemetry(data)`

MUKUT v1.0 contract validator (returns `{ valid, errors }`). Required: `helmet_id` (string), `timestamp` (number), `environment` object with numeric `temperature`, `humidity`, `methane`, `carbon_monoxide`, `smoke`; `safety` object with boolean `sos`. Optional: `version` (string). Used by `POST /api/telemetry`.

### 6.5 `src/server/serialBridge.js` — `SerialBridge`

USB-serial ingestion (default COM7 @ 115200), newline-delimited via `ReadlineParser`. Auto-reconnect every 5 s on close/error/open-failure. Accepts three input formats, in order:

1. **Node1 JSON** (has `mesh_topology` / `miner` / `environment`) → `Node1Bridge.translate()`.
2. **MUKUT v1.0 JSON** (has `version` + `helmet_id` + `timestamp`) → direct `processTelemetry()`.
3. **Node1 ASCII dashboard text** (`parseAsciiLine`) — regex-parses the gateway's human-readable serial printout (banner line "KAVACH SURFACE CONTROL CENTER" triggers `flushAsciiState()`, which assembles a Node1-shaped object and translates it). Parsed fields: risk index, active route, proximity/last-known location, fixed distance N2–N3, per-node distances, miner status/SOS, Temp/Hum/LPG/CH4/H2, per-link online + RSSI, node2/node3 hazard statuses.

### 6.6 `src/server/node1Bridge.js` — `Node1Bridge`

Two roles:

- **`translate(node1Data)`** — pure-ish translation of the Node1 ESP32 schema (§10.2) into MUKUT v1.0. Side effects on `stateManager`: syncs NODE02/NODE03/HELMET01 online status, updates spatial position (dist/rssi per node, slider pct, fixed dist), pushes its 5-link set (the direct helmet→NODE02/NODE01 links are APPENDED to the graph if absent — they must not live in config, §16 G11), updates structural health, stores active alerts/emergencies. SOS = `miner.status === 'SOS EMERGENCY'`. `connected_node` derived from `tunnel_position.nearest_node`. Also maps miner fields into `motion` / `orientation` / `anchors` for the trajectory engine (NODE01 range = `total_distance_m`, NODE02/NODE03 = relay distances).
- **`poll()` / `start()` / `stop()`** — HTTP poller: `GET http://{node1_ip}/api/telemetry` with 4 s abort timeout, falls back to `/telemetry`; on JSON failure logs warnings (first 2 failures + once at 3rd) without crashing.

Fallback default IPs differ across files (`10.207.160.60` here, `10.251.147.60` in server.js) — the **config value always wins**; defaults only matter if config keys are absent.

### 6.7 `src/server/trajectoryEngine.js` — route mapping (Phase 5)

- `computeTunnelGeometry(config)` — derives the 2D map frame from node `map_pos` anchors + the tunnel polyline (N1→N2→N3 + `face_extension_m` working face). Exported; the simulator imports it so both sides share identical geometry (52/35/64 m link-consistent).
- `TrajectoryEngine.update(telemetry, stateManager)` — per packet: dead reckoning (heading + walked-distance delta) → Gauss-Newton trilateration over ≥3 `anchors` ranges → blended correction (`correction_strength`; hard resync past `resync_threshold_m` + event) → corridor clamp (`corridor_width_m` around the polyline) → waypoint every `waypoint_interval_m` (capped at `max_waypoints`).
- Milestone events: "Miner entered underground tunnel" / "Miner returned to surface" (`surface_threshold_m`); the anchor-based first fix is silent (no boot-time event spam).
- `getState()` → the `route_map` block (position, path, tunnel polyline, anchors, bounds, distance/speed readouts).
- Heading convention: degrees, 0° = +x (deeper), increasing CCW toward +y — hardware calibration via `heading_offset_deg` (G13).

### 6.8 `src/server/calibrationEngine.js` — distance calibration (Phase 6)

- Path-loss model: `d = 10^((A − RSSI)/(10·n))` with `A` (`ref_rssi_1m`, default −55 dBm @ 1 m) and `n` (`exponent_n`, default 2.8) from `config.calibration.path_loss`; distances clamped to 0.5–200 m.
- Display layer (`displayDistance` / `applyToLinks`): `LOCKED` → frozen calibrated value; `IDLE` → model(RSSI) with EMA smoothing (`smoothing_ema`, 0.25); trunk (`link_node02_node01`) always passes through untouched (G19).
- Calibration ceremony (`start()`): one sampling window per RSSI-bearing state link (`sample_window_s`, 5 s each), passively averaging raw RSSI from every telemetry packet → locked distance per link → status `LOCKED` + events. Re-press recalibrates; `clear()` / RESET scenario unlocks.
- `anchorDisplay()` maps helmet→node locks onto route-map beacon labels.
- IMPORTANT: the lock is a **display layer only** — `TrajectoryEngine` always receives RAW telemetry, so miner tracking keeps moving while distances are frozen (G18).

### 6.9 `src/server/mlEstimator.js` — ML distance estimator (Phase 7)

- ONNX Random Forest model (`models/mukut_distance_model.onnx`, 235 KB) trained on RSSI+SNR→distance data (range 1–20 m; 30 m excluded from training).
- **WASM backend**: uses `onnxruntime-web` (NOT `onnxruntime-node` — native binary incompatible with Node.js v24.11.1).
- `estimateDistance(rssi, snr)` → `{ distance, confidence, inRange, model_version }`.
- Default SNR fallback: `snr = rssi × 0.15 + 16.5` when hardware doesn't provide SNR (logged as `(default SNR)`).
- Input validation: rejects null/NaN/Infinity RSSI, RSSI outside [-150, -20] dBm range.
- Integrated into `stateManager.js` via async `processTelemetry()` — ML distances applied per-link before calibration display layer.
- `calibrationEngine.setMLDistances(linkId, distance)` → `displayDistance()` uses ML when available (G21).
- Test suite: `test/ml_test.js` (8 test groups, 30+ assertions).

### 6.10 `src/server/signalFilter.js` — temporal median filter (Phase 8)

- Per-link rolling median filter for RSSI spike rejection before ML inference.
- Configurable window size: `signal_filter.window_size` in `config/default.json` (default: 5 packets).
- `MedianFilter` class: `push(linkId, value)` → rolling buffer per link; `getFiltered(linkId)` → median of available samples; `getRaw(linkId)` → raw buffer.
- Cold-start: uses available samples (1–window_size) without waiting for full window.
- Applied in `stateManager.js` `processTelemetry()` before ONNX inference — filtered RSSI+SNR fed to ML.
- Trajectory engine still receives RAW telemetry (G18/G22).
- Test suite: `test/filter_validation.js` (25-packet comparison, raw vs filtered std dev).
- Pipeline validation: `test/hardware_validation.js` (25 packets, 75 inferences, 100% success, no NaN/negative/crashes).

---

## 7. REST API Reference

| Method | Path | Body / Params | Purpose |
| :--- | :--- | :--- | :--- |
| GET | `/api/state` | — | Full state snapshot (`getFullState()`) |
| GET | `/api/config` | — | Runtime config (client uses it for the DATA SOURCE badge) |
| GET | `/api/events` | — | Event list |
| GET | `/api/network` | — | Network sub-state (nodes, links, route) |
| POST | `/api/network/node` | `{ nodeId, status }` | Force node ONLINE/OFFLINE |
| POST | `/api/network/telemetry` | `{ links: [...] }` | Merge link updates (rssi/distance/status/available) |
| POST | `/api/telemetry` | MUKUT v1.0 packet | **Hardware ingestion contract** (validated by schema.js) |
| POST | `/api/simulator/scenario` | `{ scenario }` | Set simulator scenario |
| GET | `/api/simulator/status` | — | Current scenario + values |
| POST | `/api/calibrate` | `{ action?: "start" \| "clear" }` | Start (default) or clear the distance-calibration ceremony |
| GET | `/api/calibrate` | — | Calibration status / progress / locked distances |

---

## 8. WebSocket Protocol

Same port as HTTP (`ws://localhost:3000`). Broadcast goes to ALL clients.

**Server → client** (`{ type, payload, timestamp }`):

| `type` | Payload | When |
| :--- | :--- | :--- |
| `INIT_STATE` | full state + `simulator` scenario | once, on connection |
| `STATE_UPDATE` | full state | after any processed telemetry / node status / link change / watchdog flip |
| `EVENT` | single event object | every `addEvent()` |
| `ROUTE_CHANGED` | `{ route, previous_route, status, failed_node }` | route transitions |

**Client → server** (`{ action, ... }`): `SET_SCENARIO` (`scenario`), `SET_NODE_STATUS` (`nodeId`, `status`), `GET_STATE` (replies `STATE_UPDATE` to that client only). Note: the current clients trigger scenarios via REST (`POST /api/simulator/scenario`), not WS actions.

Clients auto-reconnect after 2 s and re-render full state on every `STATE_UPDATE` (simple full re-render, no diffing).

---

## 9. Telemetry Contract (MUKUT v1.0)

### 9.1 Canonical packet (what `processTelemetry` consumes)

```json
{
  "version": "1.0",
  "helmet_id": "HELMET01",
  "timestamp": 1725230000,
  "environment": {
    "temperature": 32.4,
    "humidity": 71.2,
    "methane": 0.21,
    "carbon_monoxide": 18,
    "smoke": 120
  },
  "safety": { "sos": false },
  "motion": { "moving": true, "step_count": 1234, "distance_walked_m": 512.3 },
  "orientation": { "heading": 132 },
  "anchors": [
    { "id": "NODE01", "distance": 75.9 },
    { "id": "NODE02", "distance": 53.0 },
    { "id": "NODE03", "distance": 18.0 }
  ],
  "network": {
    "connected_node": "NODE03",
    "links": [
      { "id": "link_helmet_node03", "source": "HELMET01", "destination": "NODE03",
        "rssi": -61, "distance": 18, "status": "CONNECTED", "available": true }
    ]
  }
}
```

Units note: gas values are **ppm on a 0–1000 scale** for real hardware (thresholds 300/600). The simulator's `NORMAL` baseline uses legacy small values (~0.2) — harmless because they are far below warning. The `motion` / `orientation` / `anchors` blocks (Phase 5) are optional in the validator but always emitted by the simulator and node1Bridge; `anchors` are trajectory beacon ranges only — never network links (G14).

### 9.2 Node1 ESP32 schema (translated by `node1Bridge.translate`)

```json
{
  "system": { "active_route": "...", "overall_risk_index": "LOW" },
  "miner": { "worker_id": "MINER 01", "status": "SAFE | SOS EMERGENCY | ...",
             "motion_state": "STATIONARY", "heading_deg": 0,
             "direction_cardinal": "NORTH", "step_count": 0, "total_distance_m": 9.8 },
  "environment": { "temperature_c": 25.2, "humidity_pct": 53.0,
                   "mq4_methane_ppm": 136, "mq6_lpg_ppm": 150, "mq8_hydrogen_ppm": 153 },
  "mesh_topology": {
    "node2_relay": { "online": true, "rssi_dbm": -47, "hazard_status": "STABLE",
                     "hazard_level": 0, "distance_to_helmet_m": 9.8, "distance_to_node3_m": 3.5 },
    "node3_relay": { "online": true, "rssi_dbm": -44, "hazard_status": "STABLE",
                     "hazard_level": 0, "distance_to_helmet_m": 2.7 },
    "helmet_direct": { "online": true, "rssi_dbm": -46 },
    "tunnel_position": { "nearest_node": "NODE03", "relative_slider_pct": 50.0 }
  },
  "active_alerts": [], "active_emergencies": []
}
```

Mapping: mq4→methane, mq6→carbon_monoxide (LPG), mq8→smoke (H2); `miner.status === "SOS EMERGENCY"` → `safety.sos`. Links constructed: n2–n1 (trunk, `hide_metrics`), n3–n2, helmet–n3, helmet–n2, helmet–n1.

---

## 10. Client Dashboards

All four pages share the same pattern (copy-paste evolved, not shared module): IIFE, cached `elements` DOM map, `setStatusClass()` color mapping, relative-time ticker, WS connect with 2 s reconnect, `INIT_STATE`/`STATE_UPDATE` → render, `EVENT` → prepend to local list, REST `/api/state` fallback fetch, scenario toolbar wired to `POST /api/simulator/scenario`, and a DATA SOURCE badge fetched from `/api/config` (LIVE HARDWARE / LIVE NODE1 WiFi / SIMULATOR).

| Page | JS | Focus | Scenario buttons |
| :--- | :--- | :--- | :--- |
| `index.html` Safety Overview | `app.js` | Worker status hero card (CODE 00/02/99), env + gas bars, SOS, spatial slider (N2↔N3), structural hazard pills, casualty/rescue dispatch panel, alert banners, event table | `NORMAL`, `GAS_WARNING`, `GAS_CRITICAL`, `SOS`, `HELMET_OFFLINE`, `RESET` |
| `network.html` Underground Network | `network.js` | Topology view, link table with 4-bar RSSI mini-graphics + quality labels, network health banner, diagnostics strip, distance/hazard panels, CALIBRATE DISTANCES control + lock chip (Phase 6) | `NETWORK_NORMAL`, `WEAK_LINK`, `NODE02_OFFLINE`, `NODE03_FAILURE`, `RESET_NETWORK` |
| `routing.html` Routing & Failover | `routing.js` (largest) | Route hero card (NORMAL/FAILOVER/NO_ROUTE + node chain + previous route), animated 2D canvas tunnel map, route transition flash banner, routing table + event list | `NORMAL`, `NODE02_OFFLINE`, `NODE02_RESTORE`, `NODE03_FAILURE`, `RESET_NETWORK` |
| `route_map.html` Miner Route Map | `routeMap.js` | Calm light theme (`.rm-light` on body — page-only, others stay default); interactive canvas: stable fit-to-tunnel viewport (no per-waypoint refit), drag-pan + wheel-zoom + FIT VIEW / FOLLOW MINER controls, `ResizeObserver` sizing; breadcrumb path, beacon nodes + live ranges, heading arrow, START / WORKING FACE markers, metre grid; journey readout hero, anchor table, event log | `MINER_WALK_OUT`, `MINER_WALK_IN`, `MINER_STATIONARY`, `RESET` |

`routing.js` maintains a `tunnelMap` canvas state (physical positions in metres along the tunnel axis, animated helmet marker, per-link distances).

`network.js` hides any hardcoded `.topology-link-connector` block whose link id is absent from the current state, so the topology diagram always matches the active data source (4 links in simulator mode; 6 in Node1 hardware mode).

All four page headers carry a `DIST: LIVE / CALIBRATING… / DIST: LOCKED` badge (Phase 6) driven by `state.calibration.status`.

CSS: single shared `css/style.css` (industrial dark theme; status classes `status-normal` / `status-warning` / `status-critical` / `status-offline`, SOS-active and hazard-pill styles).

---

## 11. Configuration Reference (`config/default.json`)

| Key | Value (current) | Meaning |
| :--- | :--- | :--- |
| `server.port` / `server.host` | `3000` / `0.0.0.0` | HTTP + WS listen (PORT env overrides) |
| `hardware.data_source` | `"simulator"` | **Single source toggle**: `simulator` / `serial` or `hardware` / `node1` or `node1_wifi` — see §5 |
| `hardware.node1_ip` | `192.168.14.60` | Node1 surface gateway poll target |
| `hardware.node1_poll_interval_ms` | `1500` | Poll cadence |
| `hardware.serial_port` / `baud_rate` | `COM7` / `115200` | SerialBridge settings |
| `helmet.default_id` | `HELMET01` | Helmet identity |
| `helmet.heartbeat_interval_ms` | `2000` | Simulator tick rate |
| `helmet.offline_timeout_ms` | `10000` | Watchdog offline threshold |
| `network.rssi_thresholds` | excellent −65, good −75, fair −85, min −110, max −40 (dBm) | Quality bands + percentage normalization |
| `network.nodes` | NODE01 (gateway/surface), NODE02 (mid-tunnel relay), NODE03 (deep-tunnel/working-face relay), HELMET01 (wearable) | Initial node list + roles |
| `network.default_links` | 4 narrative links: helmet→N03, N03→N02, N02→N01 trunk (`hide_metrics`, rssi null), N03→N01 bypass | Initial topology. Do NOT add direct helmet→N01/N02 links here — they break the demo narrative (§13, §16 G11); the Node1 bridge appends them at runtime in hardware modes |
| `network.nodes[].map_pos` | N01 (0, 0), N02 (52, 0), N03 (53.61, 34.96) | Phase 5 2D map frame — geometry consistent with the 52/35/64 m link distances |
| `trajectory` | stride 0.75 m; waypoint every 2 m (cap 600); correction 0.15; resync 25 m; corridor 8 m; surface threshold 10 m; face extension 18 m; sim walk 1.5 m/s | Route-mapping engine + simulator journey tuning |
| `calibration` | window 5 s/link; A −55 dBm @ 1 m; n 2.8; EMA 0.25 | Phase 6 RSSI→distance model + ceremony tuning (G20) |
| `thresholds.methane` / `.carbon_monoxide` / `.smoke` | warning 300 / critical 600 ppm, max_scale 1000 | Gas safety thresholds |
| `thresholds.temperature` | warning 38 / critical 45 °C | |
| `thresholds.humidity` | warning 85 / critical 95 % | |

Config is read ONCE at boot (module-level in stateManager.js). Edits require a server restart.

---

## 12. RSSI & Threshold Semantics

- **RSSI:** closer to 0 dBm = stronger. Quality: `EXCELLENT ≥ −65` > `GOOD ≥ −75` > `FAIR ≥ −85` > `WEAK`. Bar percentage = linear map of clamped RSSI onto [−110, −40] dBm. Never treat a more-negative number as stronger.
- **Gas/temp/humidity:** `value ≥ critical` → CRITICAL; `value ≥ warning` → WARNING; else NORMAL. Percentage vs `max_scale` (gases). Overall worker status escalates through any CRITICAL gas/temp; WARNING gas/temp/humidity → WARNING status.

---

## 13. Routing & Failover Engine (stateManager.js)

- **Graph:** nodes + links from config (links are bidirectional for pathfinding; a link is usable only if `available` and status not `DISCONNECTED`/`OFFLINE`, and both endpoint nodes ONLINE).
- **`findAllPaths('HELMET01','NODE01')`:** BFS enumeration of all simple paths.
- **`calculatePathCost(path)`:** per hop `1 + quality penalty` — EXCELLENT +10, GOOD +50, FAIR +1000, WEAK +5000 → best (lowest-cost) route deterministically prefers strong links.
- **`recalculateRoute(reason)`:** on any change (node status, link availability, helmet online/offline). Route transitions:
  - No path → `routeStatus: NO_ROUTE` + EMERGENCY event.
  - Equals hardcoded primary route `"HELMET01->NODE03->NODE02->NODE01"` → `NORMAL` (+ "restored" event).
  - Anything else → `FAILOVER` + `failoverActive: true` + detected `failedNode` + WARNING event + `ROUTE_CHANGED` broadcast.
- **Typical demo:** kill NODE02 → helmet reroutes via the `link_node03_node01` bypass (HELMET01→NODE03→NODE01); kill NODE03 → helmet is fully isolated → `NO_ROUTE` + EMERGENCY event; restore → back to primary route.
- **Topology invariant:** the default graph must contain ONLY the 4 narrative links. A strong direct helmet→NODE01 link wins on hop count (boot route = HELMET01→NODE01 → system starts in FAILOVER and the NODE02-failure demo does nothing); a weak one marks network health DEGRADED at boot. The Node1 bridge appends the direct links dynamically instead (fixed 2026-09-12 — they had been copied into config during Node1 integration and broke this).
- Hardcoded endpoints: route always solves HELMET01 → NODE01; primary route string is fixed (Gotcha G2).

---

## 14. Hardware / Firmware

**Target kit:** 2× ESP32 + 2× RA-02 (SX1278) LoRa @ 433 MHz, sync word `0xF3`, 3.3 V logic.

**Wiring (both sketches):** NSS/ss 16, RESET 17, DIO0 26, SCK 18, MISO 19, MOSI 23.

- `hardware/helmet_node/helmet_node.ino` — transmitter, ID `HELMET01` (logically attaches to NODE03). Sends MUKUT v1.0 JSON over LoRa. **Sensor values are DUMMY/simulated in firmware** (temp ~30.5 °C randomized, humidity ~65 %, methane 0.20, CO 15, smoke 50, sos false) — real sensors not yet wired (commented pin placeholders TEMP_PIN 32, MQ2_PIN 33, SOS_BTN 34).
- `hardware/gateway_node/gateway_node.ino` — receiver (role NODE01 root relay). Reads LoRa packet, captures RSSI, string-splices a `network` block (single link `HELMET01→NODE03` with **real RSSI**, hardcoded distance 18 m) before the final `}`, prints newline-delimited JSON to USB serial. Emits `GATEWAY_STARTUP` / `GATEWAY_ERROR` JSON status lines. Physically 2 devices; logically mapped into the multi-node graph.
- **`hardware/ino/node1.ino`** — ACTIVE surface gateway (WiFi `Jayjit` / AP `KAVACH_MASTER`, serves the embedded web page + `/api/telemetry`). v2: `everHeard` boot guard, STATION heartbeat parsing, exposes `helmet_link` / `helmet_rssi_db` / `helmet_snr_db` (+ `peer_rssi_db` / `peer_snr_db` on node3_relay) in the JSON — `null` when never measured.
- **`hardware/ino/node2.ino`** — mid-tunnel relay. v2: appends true helmet-link RSSI/SNR to N2 relay packets (fields 18/19), transmits `N2,STATION,...` heartbeats every 3 s after 4 s of helmet silence, N2↔N3 RSSI lock 0.99→0.85.
- **`hardware/ino/node3.ino`** — working-face relay. v2: appends helmet + peer measurements to N3 relay packets (fields 15–18), transmits `N3,STATION,...` heartbeats, N2 peer RSSI lock 0.99→0.85.
- **Physically verified:** serial JSON ingestion path (software). **NOT verified:** actual ESP32→RA-02→gateway radio chain. See `reports/phase_4_report.md` §7/§17.

---

## 15. Tests & Verification

| File | Style | Covers |
| :--- | :--- | :--- |
| `test/phase1_test.js` | unit (imports modules) | Schema validator; StateManager safety engine, alerts, watchdog; simulator scenarios |
| `test/phase2_test.js` | unit | Network model init, RSSI evaluation, link/node status, routing |
| `test/phase4_test.js` | unit | Config shape (nodes/links/failover links/node1 keys); Node1Bridge translation (raw-ppm passthrough, SOS, offline cascades); telemetry endpoint; failover narrative (chain route → NODE02 failover → restore). Exits cleanly (`sm.destroy()`) |
| `test/phase5_test.js` | unit | Tunnel geometry vs link distances; trajectory engine (trilateration first fix, dead reckoning, correction blend, resync, corridor clamp, reset); simulator journey + route_map state integration; node1Bridge motion/orientation/anchors. Exits cleanly |
| `test/phase6_test.js` | unit | Path-loss model math; calibration ceremony (phases, averaging, lock, clear); display layer (locked/EMA/trunk passthrough/anchor display); full pipeline (model distances in state, frozen across ticks, trajectory moves while locked, RESET unlocks). Exits cleanly |
| `test/ml_test.js` | unit | ONNX model loading; valid input inference; default SNR fallback; input validation; out-of-range detection; calibrationEngine ML integration; full pipeline integration; metadata validation |
| `test/filter_validation.js` | unit | Per-link rolling median filter: raw vs filtered comparison (25 packets), spike rejection, cold-start behavior |
| `test/hardware_validation.js` | integration | Simulated pipeline validation: 25 packets, 75 inferences, 100% success rate, no NaN/negative/crashes |
| `test/v2_bridge_check.js` | unit | v2 network truth: station-alive semantics, relay-only helmet liveness, true helmet-link/peer RSSI+SNR mapping, old-firmware fallback, poll-failure demote/restore, v2.1 anti-flicker (EMA/sticky/ML smoothing) (32 assertions) |
| `test/v3_routemap_test.js` | unit | v3 route mapping: ML anchor enrichment (valid/out-of-range/failed/empty), 2-anchor circle-intersection solve + convergence, IMU dead reckoning (clockwise heading, step fallback), SET HEADING calibration, NODE01 real-range anchor, full ML-stubbed pipeline (22 assertions) |
| `test/v4_mapcal_test.js` | unit | v4 dynamic map calibration: geometry from measured inter-node distances (triangle build, capped face ext), 8 s lock-in ceremony (averages, events, persist hook), failure path + clear, persistence across StateManager restarts, bridge mesh_geometry (firmware fields + static fallback), helmet tracking accuracy on the measured layout (25 assertions) |
| `test/phase2_e2e_test.js` | E2E (**needs live server**) | REST endpoints + WebSocket stream + scenario reactions |
| `test/e2e_integration_test.js` | E2E (**needs live server**) | Page delivery, `/api/state`, WS connect, scenario triggers (header mislabeled "Phase 1") |
| `test_phase3b.js` (root) | E2E (**needs live server**) | All 3 pages up; full failover demo sequence via scenario API |

No CI, no coverage tooling. `npm test` runs only `phase1_test.js` (Gotcha G6). All unit suites (phase 1/2/4/5/6/7/8) were 100% green as of 2026-09-12 (phase4 realigned to the raw-ppm contract, 4-link topology restored, phase5 route mapping, phase6 distance calibration, phase7 ML estimation, phase8 median filter); the E2E suites are deferred to the hardware-integration phase.

---

## 16. Conventions & Gotchas

**Conventions**

- ESM everywhere (`import`/`export`); run files directly with `node <file>`.
- Backend modules export classes; client code is one IIFE per page (no shared client module — expect deliberate duplication between app.js / network.js / routing.js).
- All state flows through `StateManager`; UI never computes safety logic (thresholds come from config and are shipped inside `getFullState()`).
- Events: severity `INFO|WARNING|EMERGENCY`, newest-first, cap 50 in memory; clients get top 20 via state, live ones via `EVENT` messages.
- Comments are sparse; code is self-documenting — match existing style, keep it hackathon-simple per `context.md` scope control.

**Gotchas**

- **G1 — data_source is the single source toggle (fixed 2026-09-12):** historically the Node1 bridge started whenever `hardware.node1_ip` was present, silently disabling the simulator even with `data_source: "simulator"`. `server.js` now starts bridges strictly per `data_source`; `node1_ip` can safely remain in config at all times. Changing modes = edit one key + restart.
- **G2 — Hardcoded identities:** `HELMET01`, `NODE01`…`NODE03`, and the primary route string `HELMET01->NODE03->NODE02->NODE01` are hardcoded in `stateManager.js` (route endpoints, casualty assessment, normal-route check). Renaming nodes requires config + code edits.
- **G3 — Missing dependency:** `@serialport/parser-readline` is imported by `serialBridge.js` and `sniff_com7.mjs` but is NOT in `package.json` — it currently resolves as a transitive dep of `serialport`. A clean install could break; fix by `npm install @serialport/parser-readline` when touched.
- **G4 — Stale links:** `phasereport.md` still lists Phase 4 as "Pending" and its report links point to `file:///c:/Users/KAMANASIS/...` (another machine). `reports/phase_4_report.md` (COMPLETE) and `test/phase4_test.js` are the current truth.
- **G5 — Divergent default IPs:** `192.168.14.60` (config, wins) vs `10.251.147.60` (server.js fallback) vs `10.207.160.60` (node1Bridge default). Always set `hardware.node1_ip`.
- **G6 — `npm test` partial:** only runs phase 1. Run other suites explicitly (§4).
- **G7 — Windows/COM specifics:** serial port `COM7` assumed; `EADDRINUSE` handler prints a `netstat` recipe; server host `0.0.0.0`.
- **G8 — OneDrive path:** repo is inside OneDrive sync — occasional file-lock/sync noise on Windows is possible.
- **G9 — Timestamps:** telemetry `timestamp` is seconds; internal `lastSeen`/events use `Date.now()` ms. Don't mix them.
- **G10 — Link set differs by source (by design):** simulator + config use the 4 narrative links; the Node1 bridge appends helmet→NODE02 and helmet→NODE01 at runtime (6 links in hardware modes). `network.js` hides topology blocks for links absent from state.
- **G11 — Keep direct helmet→NODE01/NODE02 links OUT of `network.default_links`:** a strong direct helmet→NODE01 link beats the chain on routing cost (boot route = HELMET01→NODE01 → FAILOVER at startup, NODE02-failure demo becomes a no-op); a weak one degrades network health at boot. The Node1 bridge injects them dynamically in hardware modes (fixed 2026-09-12).
- **G12 — `link_node02_node01` has `rssi: null` on purpose:** `evaluateRssi(null)` JS-coerces null→0 → EXCELLENT/100%, keeping the trunk hop cheap in route cost. "Fixing" the null handling changes route economics — don't touch without recalculating costs.
- **G13 — Heading convention (Phase 5):** map frame is metres, x = deeper into the tunnel, y = lateral; heading 0° = +x, increasing CCW toward +y. Compass headings from real hardware (node1 `heading_deg`) use a different reference — calibrate via `trajectory.heading_offset_deg` before trusting hardware-driven paths.
- **G14 — `anchors` are NOT network links:** the telemetry `anchors` block carries trajectory beacon ranges only. Never merge them into `network.links` — direct helmet links break the routing narrative (G11).
- **G15 — StateManager constructor order:** `trajectoryEngine` must be constructed BEFORE `initNetworkState()` — the boot-time route calculation broadcasts a full state snapshot and `getFullState()` reads `route_map`.
- **G16 — Simulator RSSI derivation vs WEAK_LINK:** the simulator derives `link_helmet_node03` RSSI from live miner distance, EXCEPT under `WEAK_LINK` (whose purpose is a manually weakened signal).
- **G17 — Always give MUKUT canvases layout CSS (`width`/`height`):** an unstyled canvas sizes itself from its own `width` attribute, so the dpr-resize loop (`c.width = c.offsetWidth * dpr`) compounds its size on every resize — the route map shipped briefly like this (glitchy canvas, fixed 2026-09-12). `#routeMapCanvas` and `#tunnelMapCanvas` must keep explicit CSS dimensions; `routeMap.js` also uses a `ResizeObserver` + changed-size guard + `setTransform` reset.
- **G18 — Calibration lock is a DISPLAY layer only:** locked distances freeze link/spatial/beacon-label values everywhere, but `TrajectoryEngine` always consumes raw telemetry — FOLLOW MINER and the plotted path keep moving while distances are frozen. Never feed display distances into the trajectory.
- **G19 — Trunk guard is by link ID:** the simulator emits trunk (`link_node02_node01`) RSSI −68 WITHOUT the `hide_metrics` flag (only the config/state link carries it), so `calibrationEngine.displayDistance` skips the trunk by id — the same convention the client renderers use.
- **G20 — Path-loss constants are bench-tuned, not geometry-tuned:** with defaults (A −55, n 2.8), simulator-mode model distances (≈1.6/3.4/7.3 m) intentionally differ from the narrative geometry (18/35/64 m). Tune `calibration.path_loss` per environment; the lock freezes whatever the model says.
- **G21 — ML distances go through calibration display layer:** `calibrationEngine.setMLDistances(linkId, distance)` stores ML results; `displayDistance()` returns ML when available, otherwise falls back to path-loss model. Trajectory engine always gets RAW telemetry (G18).
- **G22 — Median filter before ML, RAW to trajectory:** `signalFilter` runs before ONNX inference in `processTelemetry()` — filtered RSSI+SNR fed to ML. Trajectory engine still receives unfiltered telemetry (G18).
- **G23 — ONNX via WASM:** `onnxruntime-node` is incompatible with Node.js v24.11.1 (`CPUExecutionProvider` not found). Use `onnxruntime-web` with WASM backend instead.
- **G24 — Default SNR fallback:** when hardware doesn't provide SNR, use `snr = rssi × 0.15 + 16.5`. Logged as `(default SNR)`. This is a placeholder until real hardware provides SNR.
- **G25 — processTelemetry is now async:** callers must `await` the result. Simulator `tick()` is fire-and-forget (acceptable). Tests updated accordingly.
- **G26 — Gateway-unreachable demotion:** after 3 consecutive poll failures `node1Bridge._demoteAllNodes()` marks ALL nodes OFFLINE + ALL links DISCONNECTED (gated by `demoted`, fires once per outage). The next successful `translate()` auto-restores. Without this, failed polls left the dashboard showing config-default ONLINE nodes + static distances (the "phantom ONLINE / hardcoded distance" display).
- **G27 — Firmware boot false-positive:** `millis() - 0 < OFFLINE_TIMEOUT` is TRUE for the first 5 s after power-on, so `lastXTime = 0` initialization made every node report `online: true` with zero packets. node1.ino v2 gates all online checks with `everHeard` flags — any NEW online check must include the everHeard guard (API handler, serial dashboard, and any future one).
- **G28 — v2 packet field map (backward compatible):** N2 relay packet: 18=helmet SNR, 19=helmet RSSI (a relay packet implies `helmet_link=true`). N3 relay packet: 15=helmet SNR, 16=node2 SNR, 17=helmet RSSI, 18=node2 RSSI. STATION heartbeats carry NO helmet payload — node1 MUST `return` before its generic helmet-field parsing or `dWorker`/`dStatus`/sensors get corrupted by heartbeat fields. Missing fields parse as 0 → gateway emits JSON `null` → bridge falls back to trunk values.
- **G29 — Trunk vs helmet-link telemetry:** gateway `node2_relay/node3_relay.rssi_dbm`+`snr_db` are the N2→N1 / N3→N1 trunk values heard by node1's own radio (via `LoRa.packetRssi/Snr`), NOT the helmet-link values. The true helmet-link measurements are `helmet_rssi_db`/`helmet_snr_db` (feature-detected in `node1Bridge.translate()`; absent on old firmware → trunk fallback). `link_node03_node02` uses node3's `peer_rssi_db`/`peer_snr_db` (node3's radio view of node2) when present.
- **G30 — Station heartbeats (demo semantics):** node2/node3 transmit `N2/N3,STATION,...` every 3 s after 4 s of helmet silence → powered stations stay ONLINE on the dashboard while helmet links show DISCONNECTED. HELMET01 is ONLINE when heard directly OR any relay reports `helmet_link: true` (deep-tunnel relay-only operation keeps the helmet "alive").
- **G31 — N2↔N3 RSSI lock was 0.99 (frozen):** the near-total smoothing lock froze the N2↔N3 distance at its first value ("hardcoded distance" symptom). Now 0.85 on both node2 (rssiNode3) and node3 (rssiNode2); the peer link stays fresh via STATION heartbeats even without helmet traffic. The bypass link `link_node03_node01` is maintained by node1Bridge (status/available follow node3 station liveness; config-layer metrics untouched).
- **G32 — v2.1 anti-flicker (three layers):** (a) `calibrationEngine.displayDistance()` EMA-smooths the ML output using the SAME `this.ema[link.id]` state as path-loss — raw RF values step between tree-leaf averages every poll (flicker) and the shared state also removes the jump when the active source switches; ML returns 2 decimals, path-loss 1 (ml_test asserts exact 4.87 first-call passthrough). (b) `node1Bridge._ema()` (α 0.45) smooths the true relay-measured helmet/peer RSSI+SNR — the gateway copies them raw from packets with no node1-side smoothing. (c) `node1Bridge._stickyDist()` holds the last valid relay distance for 3 s on momentary gaps (link still up) so the display doesn't alternate between relay distance and ML/path-loss. Anchors stay RAW for the trajectory engine (G18).
- **G33 — ML distances drive the route map (v3):** `processTelemetry` now runs ML inference BEFORE `trajectoryEngine.update`, and `enrichAnchorsWithML` replaces anchor ranges with the ML-calculated distances (only when `method==='ml'` and `inRange !== false`; raw relay range stays the per-anchor fallback). Enrichment applies in LIVE hardware modes only (`node1|node1_wifi|hardware|serial`) — in simulator mode the synthetic RSSI saturates the model at 1–2 m and would collapse the demo's narrative anchors. G18 is now: DR inputs (steps/heading) always raw; anchor ranges are ML-calculated in live modes. NODE01 anchor = `helmet_direct.distance_to_helmet_m` (real RSSI range) — NEVER `miner.total_distance_m` (step odometry); odometry feeds DR only. Trajectory anchor ranges are EMA-smoothed per anchor id (α 0.35).
- **G34 — Tunnel-relative CLOCKWISE heading (v3):** 0° = deeper into the tunnel (+x), 90° = right turn (+y) — matches the helmet's compass-style QMC5883L output read against the tunnel axis (the cos/sin DR formula was already correct for this convention; the old doc comment said CCW and was wrong). SET HEADING runtime calibration: miner faces tunnel-forward, `POST /api/trajectory/heading-zero` sets `headingOffset = (360 − lastRawHeading) % 360` (route_map exposes `heading_offset_deg` + `raw_heading_deg`; config `heading_offset_deg` remains the boot default). The UI button lives in the route-map toolbar.
- **G35 — 2-anchor solve + helmet display offsets:** `solveAnchors` trilaterates 3+ ranges and circle-intersects exactly 2 (`solveTwoAnchors`: corridor-preferred candidate for the first fix, nearest-to-current for corrections; non-intersecting circles fall back along the line of centres) — the deep-tunnel norm is only N2+N3 ranges live. `calibrationEngine.applyHelmetOffset` (added inter-session, bench-tuned) subtracts hard-coded 2/3/5 m from helmet-link DISPLAY distances (NODE01/02/03) — display-only, never fed into the trajectory; its comment says "1 m less" but the values are 2/3/5. Tests pin through it (phase6 ×2, ml_test ×1); `v2_bridge_check` S5c asserts the pre-offset core `_displayDistanceRaw` directly.
- **G36 — v4 dynamic map geometry (CALIBRATE MAP):** the map layout is no longer locked to preset `config.network.nodes[].map_pos` — `buildGeometryFromDistances(d12, d23, d13)` builds NODE01 at origin / NODE02 on +x / NODE03 trilaterated to +y from the MEASURED inter-node distances, with the working-face extension capped to the real scale (`min(face_extension_m, max(2, (d12+d23)/2))`). The 8 s ceremony (`trajectory.map_calibration_ms`, default 8000 — matches the firmware ANCHOR_CAL_SILENCE_MS boot window) samples `telemetry.mesh_geometry` (bridge-built: N2↔N3 firmware-calibrated; N1↔N2/N1↔N3 from the new firmware `distance_to_node1_m` fields with a `staticLinkDistance` fallback mirroring node1.ino's static profile), averages ONCE, rebuilds `trajectoryEngine.geo`, resets the trajectory (fresh fix in the new frame), locks, and persists to `config/map_geometry.json` (override: `trajectory.map_geometry_file`) — restored on boot, survives resets; CLEAR MAP reverts to preset. Trigger: route-map toolbar button → `POST /api/trajectory/calibrate-map` {action: start|clear}. Node markers render from `route_map.geometry.nodes` (always present); the beacon table still uses `rm.anchors` (telemetry-dependent). Firmware note: node1.ino now emits `distance_to_node1_m` per relay — re-flash required for best accuracy (static fallback works meanwhile).

---

## 17. Current Status & Next Steps

- Software Phases 1–11 complete and regression-tested (schema/safety, network, routing/failover, hardware ingestion, route mapping, distance calibration, ML distance estimation, temporal median filter, v2 network truth, v3 ML-driven route mapping, v4 dynamic map calibration).
- **Phase 11 (2026-09-13): v4 dynamic map calibration** — the map geometry is now MEASURED, not preset: `buildGeometryFromDistances` places nodes from the real inter-node distances; the CALIBRATE MAP 8 s ceremony samples `mesh_geometry` (firmware `distance_to_node1_m` + static fallback), averages once, locks, persists to `config/map_geometry.json` (restored on boot), and CLEAR MAP reverts to preset. UI: CALIBRATE MAP / CLEAR MAP toolbar buttons + live geometry status; node markers from `route_map.geometry.nodes`. Helmet tracking then runs ML anchor distances against the real layout (verified: exact positions on a 2 m/1.5 m/1.8 m triangle). `test/v4_mapcal_test.js` 25/25; all 11 suites 100% green. node1.ino re-flash recommended (adds `distance_to_node1_m`).
- **Phase 10 (2026-09-13): v3 route mapping** — ML-calculated distances now drive the mapped position: inference runs before the trajectory update and `enrichAnchorsWithML` swaps anchor ranges (live hardware modes only; simulator keeps raw anchors). NODE01 anchor fixed to the gateway's real direct range (was step odometry — corrupted every trilateration). Helmet IMU properly fused: accelerometer step odometry + magnetometer heading with the tunnel-relative clockwise convention documented, plus a SET HEADING runtime calibration (`POST /api/trajectory/heading-zero` + route-map toolbar button). 2-anchor circle-intersection fallback for the deep-tunnel N2+N3-only case; per-anchor EMA. `test/v3_routemap_test.js` 22/22; all 10 suites 100% green (three pre-existing assertions updated for the inter-session `applyHelmetOffset` display offsets).
- **Phase 9 (2026-09-13): v2 network truth** — killed the phantom-ONLINE display: `node1Bridge` poll-failure demotion (3 strikes → all OFFLINE, auto-restore), NODE01 status sync, helmet relay-liveness (ONLINE via direct OR relay `helmet_link`), true helmet-link/peer RSSI+SNR mapping (feature-detected, old-firmware fallback), bypass-link maintenance. Firmware v2 (requires re-flash of node1/2/3): `everHeard` boot guard, STATION heartbeats every 3 s (stations stay ONLINE without helmet), v2 relay packet fields, N2↔N3 RSSI lock 0.99→0.85 (unfroze the "hardcoded" distance). `test/v2_bridge_check.js` 28/28; all 8 unit suites 100% green.
- Live mode: node1 WiFi — helmet hardware connected via the surface gateway (`192.168.14.60`), verified 2026-09-12; switch back to the demo simulator with `data_source: "simulator"` + restart.
- **2026-09-12 session:** switched to simulator mode; made `data_source` the single source toggle in `server.js`; restored the 4-link narrative topology in config (Node1 bridge re-appends its direct links at runtime); `network.js` now hides absent topology blocks; phase2/phase4 tests realigned (link count ≥4, raw-ppm passthrough, clean exit). All unit suites 100% green; server verified live on localhost:3000 (NORMAL scenario, chain route, health GOOD).
- **Phase 5 (2026-09-12):** miner route mapping implemented — `trajectoryEngine.js` (dead reckoning + Gauss-Newton beacon fusion + corridor clamp), simulator journey scenarios (`MINER_WALK_IN/OUT/STATIONARY`), 4th dashboard tab `/dashboard/routemap`, `route_map` state block, node1Bridge motion/orientation/anchors mapping. All unit suites (1/2/4/5) 100% green.
- **Phase 6 (2026-09-12):** RSSI distance calibration — `calibrationEngine.js` (path-loss model, EMA live distances, 5 s/link sampling ceremony, lock), `POST/GET /api/calibrate`, CALIBRATE DISTANCES control on the network page, `DIST: LIVE/LOCKED` badges on all four dashboards; display-layer-only lock (trajectory stays raw). All unit suites (1/2/4/5/6) 100% green.
- **Phase 7 (2026-09-12):** ML distance estimation — `mlEstimator.js` (ONNX Random Forest via WASM, RSSI+SNR→distance, MAE 0.51m, R² 0.97), integration in `stateManager.js` (async `processTelemetry`), ML branch in `calibrationEngine.displayDistance()`, SNR extraction in `node1Bridge.js`, SNR in simulator/config. All unit suites (1/2/4/5/6/7) 100% green.
- **Phase 8 (2026-09-12):** temporal median filter — `signalFilter.js` (per-link rolling median, configurable window size), applied before ONNX inference in `stateManager.js`, `test/filter_validation.js` (25-packet comparison), `test/hardware_validation.js` (25 packets, 75 inferences, 100% success). All unit suites (1/2/4/5/6/7/8) 100% green.
- E2E suites (phase2_e2e, e2e_integration, test_phase3b) intentionally deferred until the hardware-integration phase — run them against a live server then.
- Next up: hardware validation with live LoRa packets; frontend display of ML distance (separate from theoretical); NODE03 anchor distance is 0.0 from gateway until firmware reports valid range.
- Outstanding: compass→map heading calibration (`trajectory.heading_offset_deg`) before trusting hardware-driven paths; gateway payload contains stray non-ASCII chars in `worker_id`/`status` (displays as-is, SOS parsing unaffected).
- Product scope guardrails (no auth, no cloud, no ML, etc.) live in `context.md` §22 — respect them.
