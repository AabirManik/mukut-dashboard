# MUKUT Smart Coal Miner Helmet — Phase 3A Report
**Subject:** Dynamic Network Path Calculation and Failover Engine
**Date:** September 2026

## 1. What Was Built
Implemented a dynamic graph-based pathfinding engine in the backend (`stateManager.js`) that tracks the network topology of the underground LoRa network. The engine intelligently calculates the optimal communication route from the miner (`HELMET01`) to the `GATEWAY`, handling nodes going offline or restoring seamlessly.

## 2. Files Modified
- `config/default.json` - Added `NODE03 <-> NODE01` alternate link and `available` properties.
- `src/server/stateManager.js` - Integrated `findAllPaths`, `calculatePathCost`, and `recalculateRoute` into the state cycle.
- `src/server/simulator.js` - Expanded scenarios to trigger `NODE02_OFFLINE`, `NODE03_FAILURE`, `NO_ROUTE`, and `NODE02_RESTORE`.
- `task.md` - Phase 3A implementation checklist created and checked off.

## 3. Network Graph Architecture
The network is evaluated as a bidirectional graph consisting of `nodes` and `links`. A path is considered valid only if all traversed nodes are `ONLINE` and `available=true`, and all traversed links are `CONNECTED` and `available=true`.

## 4. Route Calculation Algorithm
We perform an exhaustive Breadth-First Search (BFS) to find all possible paths from `HELMET01` to `GATEWAY`. Since the prototype topology is a constrained mesh, this remains highly performant and deterministic. Once all paths are collected, we evaluate each using a structured cost function.

## 5. Route Cost/Selection Logic
Each path receives a cumulative "cost" score. The engine selects the path with the *lowest* overall cost.
- **Hop Base Cost:** `1` point per link (prefers fewer hops all else being equal).
- **Link Quality Weight:** 
  - `EXCELLENT` = 10 pts
  - `GOOD` = 50 pts
  - `FAIR` = 1000 pts
  - `WEAK` = 5000 pts

This explicitly forces the engine to strongly prefer strong, multi-hop routes (e.g., `HELMET01 -> NODE03 -> NODE02 -> NODE01 -> GATEWAY` = ~124 pts) over a shorter route that relies on degraded signals (e.g., `HELMET01 -> NODE03 -> NODE01 -> GATEWAY` = ~1023 pts), meeting the exact deterministic expectations of the prototype.

## 6. Failover Logic
When a node (like `NODE02`) goes `OFFLINE`:
1. The node and adjacent links are marked `available=false`.
2. `recalculateRoute()` executes.
3. The normal path is no longer valid, forcing selection of the alternate path (`NODE03 -> NODE01`).
4. Route state updates to `FAILOVER`, tracks the `failed_node`, stores `previous_route`, and fires a `ROUTE_CHANGED` event via WebSocket.

## 7. Recovery Logic
When a node (like `NODE02`) is returned `ONLINE`:
1. The node and links are marked `available=true` and `CONNECTED`.
2. `recalculateRoute()` executes.
3. The preferred primary route is restored due to lower weight cost.
4. Route state transitions back to `NORMAL`, resetting failover flags, and broadcasting the restored path.

## 8. NO_ROUTE Behavior
If a critical chokepoint fails (e.g. `NODE03` failing, or both `NODE01` and `NODE02` failing):
1. `findAllPaths()` returns no results.
2. `currentRoute` becomes `[]`.
3. `status` becomes `NO_ROUTE`.
4. A critical emergency event is broadcasted: `"Communication path unavailable!"`.

## 9. API & WebSocket Changes
Both REST (`/api/state`) and WebSockets emit the nested `route` object:
```json
"route": {
  "current_route": ["HELMET01", "NODE03", "NODE01", "GATEWAY"],
  "previous_route": ["HELMET01", "NODE03", "NODE02", "NODE01", "GATEWAY"],
  "status": "FAILOVER",
  "failover_active": true,
  "failed_node": "NODE02"
}
```

## 10. Known Limitations
- The current path cost ignores strict physical distance since link quality abstracts the RF reality effectively for the hackathon. 
- Disconnected networks don't automatically generate SOS, but they do properly sever network connectivity for the helmet watchdog.

## 11. Demonstration Steps
To verify routing logic via Simulator:
1. `POST /api/simulator/scenario` with `{"scenario": "NORMAL"}` -> Check state: Route is Normal (5-hop).
2. `POST /api/simulator/scenario` with `{"scenario": "NODE02_OFFLINE"}` -> Check state: Route is Failover (4-hop).
3. `POST /api/simulator/scenario` with `{"scenario": "NODE02_RESTORE"}` -> Check state: Route is Normal again.
4. `POST /api/simulator/scenario` with `{"scenario": "NODE03_FAILURE"}` -> Check state: `NO_ROUTE`.
