# MUKUT Smart Coal Miner Helmet — Phase 2 Implementation Report

**Project:** MUKUT Smart Coal Miner Helmet (Hackathon Prototype)  
**Phase:** Phase 2 — Underground Network Monitoring & Telemetry  
**Status:** Completed & Validated (100% Tests Passed)  
**Date:** September 2026  

---

## 1. Executive Summary

Phase 2 of the MUKUT software system implements the **Underground Network Monitoring Dashboard** (`/dashboard/network`). It visualizes the multi-hop underground communication path between `HELMET01`, relay stations (`NODE03`, `NODE02`, `NODE01`), and the `SURFACE GATEWAY`.

In strict compliance with the **Black + White + Minimal + Technical + Industrial** design system from Phase 1, the network topology serves as the primary visual element, showing live RSSI signal strength, discrete signal meters, estimated distances, node statuses, and overall network health.

---

## 2. Files Created and Modified

```
Dashboard/
├── config/
│   └── default.json                # [MODIFIED] Added network node definitions, links, and RSSI threshold brackets
├── src/
│   ├── server/
│   │   ├── stateManager.js         # [MODIFIED] Added network state model, RSSI quality evaluations, health logic
│   │   ├── simulator.js            # [MODIFIED] Added network link telemetry generation and Phase 2 scenario modes
│   │   └── server.js               # [MODIFIED] Added /dashboard/network routes and /api/network endpoints
│   └── client/
│       ├── index.html              # [MODIFIED] Added top navigation tabs between Safety and Network views
│       ├── network.html            # [NEW] Dedicated Underground Network Monitoring layout
│       ├── css/
│       │   └── style.css           # [MODIFIED] Added topology node boxes, connectors, signal meters, and tables
│       └── js/
│           ├── app.js              # [MODIFIED] Preserved Phase 1 functionality with shared nav support
│           └── network.js          # [NEW] WebSocket client, live topology renderer, RSSI meters, and demo dock
├── test/
│   ├── phase1_test.js              # Unit tests for Phase 1 Safety features (100% Passed)
│   ├── phase2_test.js              # [NEW] Unit tests for Network model, RSSI calculations, and scenarios (100% Passed)
│   ├── e2e_integration_test.js     # End-to-end WebSocket tests for Phase 1 (100% Passed)
│   └── phase2_e2e_test.js          # [NEW] End-to-end REST & WebSocket tests for Phase 2 (100% Passed)
├── reports/
│   ├── phase_1_report.md           # Phase 1 Report
│   └── phase_2_report.md           # [NEW] Phase 2 Report
└── phasereport.md                  # [MODIFIED] Root phase tracker updated
```

---

## 3. Network Architecture & Data Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     SURFACE LORA GATEWAY                        │
│                     Status: ONLINE                              │
└───────────────────────────────▲─────────────────────────────────┘
                                │  [Link 4] RSSI: -58 dBm | Est. 85 m (EXCELLENT)
┌───────────────────────────────┴─────────────────────────────────┐
│                     NODE01 (Shaft Relay 1)                      │
│                     Status: ONLINE                              │
└───────────────────────────────▲─────────────────────────────────┘
                                │  [Link 3] RSSI: -68 dBm | Est. 52 m (GOOD)
┌───────────────────────────────┴─────────────────────────────────┐
│                     NODE02 (Tunnel Relay 2)                     │
│                     Status: ONLINE                              │
└───────────────────────────────▲─────────────────────────────────┘
                                │  [Link 2] RSSI: -72 dBm | Est. 37 m (GOOD)
┌───────────────────────────────┴─────────────────────────────────┐
│                     NODE03 (Stope Access Node)                  │
│                     Status: ONLINE                              │
└───────────────────────────────▲─────────────────────────────────┘
                                │  [Link 1: ACTIVE HELMET LINK] RSSI: -61 dBm | Est. 18 m (EXCELLENT)
┌───────────────────────────────┴─────────────────────────────────┐
│                     HELMET01 (Miner Wearable)                   │
│                     Status: ONLINE                              │
└─────────────────────────────────────────────────────────────────┘
```

### JSON Network State Contract
```json
{
  "network": {
    "health": "GOOD",
    "connected_node": "NODE03",
    "nodes": [
      { "id": "GATEWAY", "name": "Surface Gateway", "status": "ONLINE" },
      { "id": "NODE01", "name": "Shaft Relay 1", "status": "ONLINE" },
      { "id": "NODE02", "name": "Tunnel Relay 2", "status": "ONLINE" },
      { "id": "NODE03", "name": "Stope Access 3", "status": "ONLINE" },
      { "id": "HELMET01", "name": "Miner Wearable", "status": "ONLINE" }
    ],
    "links": [
      { "id": "link_helmet_node03", "source": "HELMET01", "destination": "NODE03", "rssi": -61, "distance": 18, "quality": "EXCELLENT", "status": "CONNECTED" },
      { "id": "link_node03_node02", "source": "NODE03", "destination": "NODE02", "rssi": -72, "distance": 37, "quality": "GOOD", "status": "CONNECTED" },
      { "id": "link_node02_node01", "source": "NODE02", "destination": "NODE01", "rssi": -68, "distance": 52, "quality": "GOOD", "status": "CONNECTED" },
      { "id": "link_node01_gateway", "source": "NODE01", "destination": "GATEWAY", "rssi": -58, "distance": 85, "quality": "EXCELLENT", "status": "CONNECTED" }
    ],
    "summary": {
      "online_nodes_count": 5,
      "total_nodes_count": 5,
      "active_links_count": 4,
      "helmet_connected": true
    }
  }
}
```

---

## 4. Reusable RSSI & Quality Interpretation

All RSSI evaluations are centralized in the backend configuration (`config/default.json`):

| RSSI Range (dBm) | Quality Level | Signal Bar | Interpretation |
| :--- | :--- | :--- | :--- |
| $\ge -65\text{ dBm}$ | **`EXCELLENT`** | `████` (4/4) | Strong direct LoRa line-of-sight |
| $-66\text{ to }-75\text{ dBm}$ | **`GOOD`** | `███░` (3/4) | Normal underground tunnel propagation |
| $-76\text{ to }-85\text{ dBm}$ | **`FAIR`** | `██░░` (2/4) | Moderate attenuation around bends |
| $< -85\text{ dBm}$ | **`WEAK`** | `█░░░` (1/4) | Severe attenuation / degraded signal |

---

## 5. UI Features on `/dashboard/network`

1. **Top Navigation Tabs:**
   * Instant switching between `[ SAFETY OVERVIEW ]` (`/dashboard`) and `[ UNDERGROUND NETWORK ]` (`/dashboard/network`).
2. **Hero Network Topology Section:**
   * Clean vertical node cards for Gateway, Relays, Access Station, and Helmet.
   * Inter-node link connectors displaying live RSSI, Est. Distance, Quality badge, and discrete signal meters.
   * Prominently highlighted `[ACTIVE LINK]` between `HELMET01` and `NODE03`.
3. **Inter-Node Link Metrics Table:**
   * Tabular breakdown of all segments with live RSSI, signal bars, estimated distance, quality, and connection status.
4. **System Diagnostics Panel:**
   * Compact metrics showing Nodes Online count, Target Node, LoRa Frequency (433 MHz RA-02), and Propagation Health.
5. **Phase 2 Simulator Controls Dock:**
   * `[NETWORK NORMAL]`: Resets network links to nominal values.
   * `[WEAK LINK (-86 dBm)]`: Degrades `NODE03 -> NODE02` link to WEAK and sets Network Health to `DEGRADED`.
   * `[NODE02 OFFLINE]`: Sets `NODE02` to `OFFLINE` and severs links without automatic rerouting (in compliance with Phase 2 scope limits).
   * `[RESET NETWORK]`: Restores all nodes to `ONLINE`.

---

## 6. Verification Results

All 4 test suites passed with **100% success**:

```
✓ Phase 1 Unit Tests: Schema, Thresholds, State Manager, Alerts (100% Pass)
✓ Phase 2 Unit Tests: Network Model, RSSI Brackets, Health Degradation (100% Pass)
✓ Phase 1 E2E Tests: Safety WebSocket Streaming & Scenario Ingestion (100% Pass)
✓ Phase 2 E2E Tests: Route delivery, Link Degradation, Node Offline, Zero Regressions (100% Pass)
```

---

## 7. How to Run and Access

```bash
# 1. Run all test suites
npm test; node test/phase2_test.js; node test/phase2_e2e_test.js

# 2. View in Browser
# Safety Overview:
http://localhost:3000/dashboard

# Underground Network Monitoring:
http://localhost:3000/dashboard/network
```

---

## 8. Readiness for Phase 3 (Routing & Failover)

* **Phase 2 Scope Complete:** Network visibility, node health, link metrics, and signal strength are fully operational.
* **Phase 3 Foundation Ready:** When a node (such as `NODE02`) drops out in Phase 3, the backend will calculate the alternative path (`NODE03 ──► NODE01`), flag `FAILOVER ACTIVE`, and animate the failover packet pathing seamlessly.
