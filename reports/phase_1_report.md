# MUKUT Smart Coal Miner Helmet — Phase 1 Implementation Report

**Project:** MUKUT Smart Coal Miner Helmet (Hackathon Prototype)  
**Phase:** Phase 1 — Safety Overview Dashboard & Live Telemetry Engine  
**Status:** Completed & Validated (100% Tests Passed)  
**Date:** September 2026  

---

## 1. Executive Summary

Phase 1 of the MUKUT software system has been implemented. It establishes the live **Safety Overview Dashboard**, real-time **Node.js Express + WebSocket backend**, the standardized **Telemetry Data Contract (`v1.0`)**, and an interactive multi-scenario **Telemetry Simulator**.

The user interface adheres strictly to the **Black + White + Minimal + Technical + Professional** aesthetic, designed like an industrial control-room console with high contrast and zero visual clutter.

---

## 2. Files Created

```
Dashboard/
├── package.json                    # Project configuration, dependencies (express, ws), and scripts
├── config/
│   └── default.json                # Centralized thresholds (gas, temp, humidity), timeouts, and network defaults
├── src/
│   ├── server/
│   │   ├── schema.js               # Telemetry v1.0 schema validator
│   │   ├── stateManager.js         # Core state, threshold evaluation, alert engine & watchdog
│   │   ├── simulator.js            # Realistic telemetry generator with 6 controllable scenarios
│   │   └── server.js               # Express HTTP & WebSocket server + REST API
│   └── client/
│       ├── index.html              # Industrial Safety Overview Dashboard HTML5 layout
│       ├── css/
│       │   └── style.css           # Technical minimalist B&W styling (Inter & JetBrains Mono)
│       └── js/
│           └── app.js              # Real-time WebSocket streaming, dynamic DOM renderer, relative timer
├── test/
│   ├── phase1_test.js              # Unit tests for schema, state manager, thresholds, and simulator
│   └── e2e_integration_test.js     # End-to-end WebSocket, REST API, and scenario transition tests
├── reports/
│   └── phase_1_report.md           # Phase 1 technical and analytical report
└── phasereport.md                  # Project root phase tracker report
```

---

## 3. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                 MUKUT TELEMETRY SIMULATOR                   │
│   (or Physical ESP32 + RA-02 LoRa Gateway in Phase 4)       │
│                                                             │
│   - Natural Brownian drift (temp, hum, gas)                 │
│   - 6 Demo Scenarios (Normal, Warn, Crit, SOS, Offline)    │
└──────────────────────────────┬──────────────────────────────┘
                               │ JSON Telemetry Contract v1.0
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    MUKUT BACKEND SERVER                     │
│                                                             │
│   [Schema Validator] ──► [Central Config / Thresholds]     │
│                                  │                          │
│                                  ▼                          │
│   [State Manager]                                           │
│   - Worker Safety Evaluation (SAFE / WARNING / EMERGENCY)   │
│   - Atmospheric Gas Analysis (CH4, CO, Smoke)               │
│   - Watchdog / Last-Seen Heartbeat (Online / Offline)       │
│   - Chronological Event Log Engine                          │
└──────────────────────────────┬──────────────────────────────┘
                               │ WebSocket Live Push (ws://)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              SAFETY OVERVIEW CONSOLE (CLIENT)               │
│                                                             │
│   - MUKUT Brand Header & Live "Last Update" Timer           │
│   - Dominant Worker Safety Card (SAFE / WARN / EMRG)        │
│   - Temperature (°C), Humidity (%), Emergency SOS Cards     │
│   - Gas Monitoring Panel with Scaled Progress Trackers      │
│   - Live Audit Event Timeline Log                           │
│   - Bottom Simulator Scenario Demo Toolbar                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Telemetry Contract (`v1.0`)

All telemetry adheres to the standard schema:

```json
{
  "version": "1.0",
  "helmet_id": "HELMET01",
  "timestamp": 1725230000,
  "environment": {
    "temperature": 32.4,
    "humidity": 71.2,
    "methane": 0.21,
    "carbon_monoxide": 18.0,
    "smoke": 120.0
  },
  "safety": {
    "sos": false
  }
}
```

---

## 5. UI & Interaction Design Highlights

1. **Strict Minimalist Industrial Aesthetic:**
   * Pure light background (`#ffffff` / `#f8f9fa`) with dark charcoal typography (`#09090b`).
   * Clean monospaced technical figures using **JetBrains Mono** and **Inter**.
   * Crisp structural borders without glowing cards, gradients, or AI-generated visual noise.

2. **Dominant Worker Safety Banner:**
   * **`SAFE`**: Clean green accent border and label: `Nominal conditions — No emergency detected`.
   * **`WARNING`**: Amber border and warning code: `WARNING — Environmental parameters elevated`.
   * **`EMERGENCY`**: Inverted high-contrast black/crimson hazard styling: `EMERGENCY — SOS alert manually activated by miner`.

3. **Atmospheric Gas Meters:**
   * Real-time progress bars with explicit Warning and Critical threshold tick marks for **Methane (CH₄)**, **Carbon Monoxide (CO)**, and **Smoke (PM)**.

4. **Live Event Log:**
   * Real-time chronological audit trail of telemetry events, threshold excursions, and connection heartbeats.

5. **Integrated Simulator Demo Toolbar:**
   * Docked bottom toolbar with 1-click scenario triggers: `[NORMAL]`, `[GAS WARNING]`, `[GAS CRITICAL]`, `[SOS EMERGENCY]`, `[HELMET OFFLINE]`, and `[RESET SYSTEM]`.

---

## 6. Verification & Test Results

### 6.1 Unit & Schema Tests (`npm run test`)
```
[TEST GROUP 1] Schema Validator Tests:
  ✓ Valid telemetry payload passes schema
  ✓ Incomplete payload caught 3 validation errors

[TEST GROUP 2] StateManager & Alert Logic Tests:
  ✓ Nominal telemetry yields SAFE status and NORMAL atmosphere
  ✓ Elevated methane (>0.8% vol) triggers WARNING status and events
  ✓ Critical methane (>1.5% vol) triggers EMERGENCY status
  ✓ Hardware SOS active immediately forces EMERGENCY state
  ✓ Event log populated (8 events logged)

[TEST GROUP 3] Telemetry Simulator Tests:
  ✓ Simulator generates valid schema packet for NORMAL scenario
  ✓ GAS_WARNING scenario generated Methane=0.93% vol (Warning threshold >= 0.8)
  ✓ GAS_CRITICAL scenario generated Methane=1.67% vol (Critical threshold >= 1.5)
  ✓ SOS scenario generated sos=true

ALL PHASE 1 AUTOMATED TESTS PASSED (100%)
```

### 6.2 End-to-End WebSocket & REST Tests
```
✓ 1. Dashboard HTML route /dashboard serves valid Phase 1 structure
✓ 2. GET /api/state returns current system state
✓ 3. WebSocket client connected successfully to live server
✓ 4. Received initial messages from WebSocket
✓ 5. Triggered GAS_WARNING -> State is WARNING, Gas is WARNING
✓ 6. Triggered GAS_CRITICAL -> State is EMERGENCY, Gas is CRITICAL
✓ 7. Triggered SOS -> State is EMERGENCY, SOS is true
✓ 8. Triggered RESET -> State returned to SAFE, Gas is NORMAL
✓ 9. POST /api/telemetry ingested valid hardware packet successfully
```

---

## 7. How to Run the System

```bash
# 1. Install dependencies (if not already installed)
npm install

# 2. Run automated tests
npm test

# 3. Start the live server and dashboard
npm start

# 4. Open in browser
http://localhost:3000/dashboard
```

---

## 8. Definition of Done Checklist (Phase 1)

### Dashboard
- [x] MUKUT branding with subtitle
- [x] Helmet ID (`HELMET01`)
- [x] Real-time Online / Offline status badge
- [x] Dominant Worker Safety Status (`SAFE` / `WARNING` / `EMERGENCY`)
- [x] Temperature reading with threshold status
- [x] Humidity reading with threshold status
- [x] Methane gas level, meter, and state
- [x] Carbon monoxide level, meter, and state
- [x] Smoke level, meter, and state
- [x] Emergency SOS status indicator
- [x] Live Event Timeline feed
- [x] Zero-refresh real-time WebSocket updates

### Backend
- [x] Standard Telemetry Ingestion endpoint (`POST /api/telemetry`)
- [x] Telemetry schema validator (`v1.0`)
- [x] In-memory State Manager
- [x] Last-seen tracking and offline watchdog timer
- [x] Configurable gas and environmental threshold engine
- [x] SOS emergency processor
- [x] Event generation and logging
- [x] WebSocket broadcast engine

### Simulator
- [x] Continuous realistic drift generator
- [x] Normal mode
- [x] Gas Warning mode
- [x] Gas Critical mode
- [x] SOS Panic mode
- [x] Helmet Offline mode
- [x] Reset to nominal mode

---

## 9. Known Limitations & Phase 2 Planning

* **Intentionally Excluded in Phase 1 (Per Specification):**
  * Underground multi-node network graph (NODE01, NODE02, NODE03).
  * Node-to-node RSSI and distance meters.
  * Automatic mesh failover visualizer.
  * Physical serial hardware ingestion port.
* **Ready for Phase 2:**
  * The backend architecture and WebSocket state pipeline are fully modular and ready to incorporate network link telemetry, RSSI calculations, and multi-node topology when Phase 2/3 is approved.
