# MUKUT — Demo Day Guide (Live Hardware)

## 0. Before the judges arrive (5 min)

1. Power: NODE01 (gateway) → NODE02 → NODE03 → helmet, in that order (nodes run their 8 s boot calibration on power-up — give them 10 s before touching anything)
2. Laptop on the same WiFi as the gateway; verify `http://192.168.14.60/api/telemetry` responds in a browser
3. Start the dashboard: `npm start` → open `http://localhost:3000/dashboard/routemap`
4. Check: NODE02/NODE03 ONLINE, HELMET ONLINE, links CONNECTED

## 1. One-time calibration (~40 s, do once — it persists across restarts)

On the **ROUTE MAP** page toolbar:

| Step | Action | Status line shows |
|---|---|---|
| 1 | Hold helmet **exactly 1 m from NODE 2**, keep still → press **RANGE CAL · 1m** | `[ RANGE CAL — HOLD HELMET 1m FROM NODE 2 ]` |
| 2 | Hold helmet **exactly 3 m from NODE 2**, keep still → press **RANGE CAL · 3m** | `[ RANGE CURVE LOCKED — A … dBm · n … ]` |
| 3 | Nodes stationary → press **CALIBRATE MAP** (8 s) | `[ MAP LOCKED — N1↔N2 … · N2↔N3 … · N1↔N3 … ]` |
| 4 | Wear the helmet, face **into the tunnel** → press **SET HEADING 0°** | `[ HEADING ZERO SET … ]` |
| 5 | Press **START TRACKING** (if not already active) | `[ TRACKING ACTIVE ]` |

After this, every distance on every page is computed from the curve **fitted on your actual hardware** — walking visibly moves the numbers and the map dot. The route tracks live; when you walk near a node the position **snaps closer** to it (proximity lock).

## 2. The 3-minute demo script

1. **"This is the MUKUT safety dashboard."** Safety page: worker SAFE, helmet ONLINE, gases NORMAL, live temperature/humidity ticking.
2. **"Each anchor node measures the miner's distance live."** Network page: RSSI/SNR bars, distances. **Walk slowly toward a node — call out the distance dropping.**
3. **"The route map tracks the miner underground — no GPS."** Route map: follow the dot; waypoints drop as you walk; the heading arrow turns as you turn. **When you get close to a node, the dot snaps to the beacon — that's the proximity lock kicking in.**
4. **"If gas leaks…"** (trigger via your gas scenario/hardware) → dashboard flips to WARNING, event logged.
5. **"Miner in distress presses SOS."** → EMERGENCY banner, event timeline entry.
6. **"What if a relay dies?"** **Power off NODE02** → dashboard shows NODE02 OFFLINE within ~5 s, route flips to the bypass (HELMET → NODE03 → NODE01), **FAILOVER ACTIVE**.
7. **"We can pause and resume tracking anytime."** Press **STOP TRACKING** — path freezes. Walk to a new position. Press **START TRACKING** — tracking resumes from the current beacon fix, no jump.
8. **Power NODE02 back on** → network self-heals, route restored. **"Designed for unreliable underground communication."**

## 3. Backup plans

- Gateway unreachable → dashboard honestly shows all OFFLINE (no fake data — that's the design); fix WiFi, it auto-restores
- Distances look off → re-run step 1 (CLEAR CAL first if needed)
- Worst case → set `config/default.json` → `"data_source": "simulator"`, restart, use the scenario buttons — the full story still demos (failover, SOS, gas)
