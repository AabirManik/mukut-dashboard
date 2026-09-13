// v6 Tracking Session + Proximity Pull — START/STOP TRACKING control,
// mismatch-gated beacon proximity snapping, motion-agnostic path growth,
// anchor EMA step detection, adaptive (motion-agnostic) correction strength.
// Run: node test/v6_tracking_test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StateManager } from '../src/server/stateManager.js';
import { TrajectoryEngine } from '../src/server/trajectoryEngine.js';
import { isolate } from './helpers/isolated_config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/default.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// Preset-geometry node positions (config/default.json map_pos)
const N1 = { x: 0, y: 0 };
const N2 = { x: 52, y: 0 };
const N3 = { x: 53.61, y: 34.96 };
const distTo = (p, n) => Math.hypot(p.x - n.x, p.y - n.y);

// ─── GROUP 1: session lifecycle ─────────────────────────────────────────────
console.log('\n[GROUP 1] Session lifecycle (START / STOP TRACKING):');
{
  const eng = new TrajectoryEngine(baseConfig);
  const events = [];
  const stub = { addEvent: (sev, msg) => events.push({ sev, msg }) };

  check('session active by default', eng.getState().session.active === true);

  // First fix at (20, 5) from three consistent beacons
  const H = { x: 20, y: 5 };
  const trueAnchors = () => [
    { id: 'NODE01', distance: distTo(H, N1) },
    { id: 'NODE02', distance: distTo(H, N2) },
    { id: 'NODE03', distance: distTo(H, N3) }
  ];
  eng.update({ anchors: trueAnchors(), motion: {}, orientation: { heading: 0 } }, stub);
  const fixed = eng.getState().position;
  check('first fix from beacons', approx(fixed.x, H.x, 0.7) && approx(fixed.y, H.y, 0.7), `(${fixed.x}, ${fixed.y})`);

  // STOP → trajectory frozen despite movement + shifting beacons
  eng.stopTracking();
  check('stopTracking deactivates session', eng.getState().session.active === false);
  const posBefore = { ...eng.getState().position };
  const wpBefore = eng.getState().waypoint_count;
  for (let i = 0; i < 3; i++) {
    eng.update({
      anchors: [
        { id: 'NODE01', distance: distTo(H, N1) - 3 * (i + 1) },
        { id: 'NODE02', distance: distTo(H, N2) - 3 * (i + 1) },
        { id: 'NODE03', distance: distTo(H, N3) - 3 * (i + 1) }
      ],
      motion: { moving: true, distance_walked_m: 10 * (i + 1) },
      orientation: { heading: 0 }
    }, stub);
  }
  const frozen = eng.getState();
  check('position frozen while paused', frozen.position.x === posBefore.x && frozen.position.y === posBefore.y,
    `(${frozen.position.x}, ${frozen.position.y})`);
  check('path frozen while paused', frozen.waypoint_count === wpBefore, `${frozen.waypoint_count} waypoints`);
  check('moving flag suppressed while paused', frozen.moving === false);

  // Heading capture + odometer baseline keep running while paused
  eng.update({ anchors: trueAnchors(), motion: { distance_walked_m: 50 }, orientation: { heading: 132 } }, stub);
  check('heading captured while paused', eng.getState().raw_heading_deg === 132);
  check('SET HEADING usable while paused', eng.setHeadingZero().success === true);

  // START → fresh session: path cleared, position re-fixes, no odometer jump
  const startRes = eng.startTracking();
  check('startTracking reactivates session', startRes.active === true && eng.getState().session.active === true);
  check('startTracking clears the breadcrumb', eng.getState().path.length === 0);
  eng.update({ anchors: trueAnchors(), motion: {}, orientation: { heading: 0 } }, stub);
  const refixed = eng.getState().position;
  check('position re-fixes from beacons after START', approx(refixed.x, H.x, 0.7) && approx(refixed.y, H.y, 0.7),
    `(${refixed.x}, ${refixed.y})`);
  // walked 51 → only 1 m of DR (baseline tracked through the pause), no 50 m jump
  eng.update({ anchors: trueAnchors(), motion: { distance_walked_m: 51 }, orientation: { heading: 0 } }, stub);
  const afterStep = eng.getState().position;
  check('no odometer jump on resume', afterStep.x > 19 && afterStep.x < 23, `x=${afterStep.x}`);
}

// ─── GROUP 2: proximity pull ────────────────────────────────────────────────
console.log('\n[GROUP 2] Proximity pull (signal vs map disagreement):');
{
  const eng = new TrajectoryEngine(baseConfig);
  const events = [];
  const stub = { addEvent: (sev, msg) => events.push({ sev, msg }) };

  // First fix at (20, 5) — far from every node
  const H = { x: 20, y: 5 };
  eng.update({
    anchors: [
      { id: 'NODE01', distance: distTo(H, N1) },
      { id: 'NODE02', distance: distTo(H, N2) },
      { id: 'NODE03', distance: distTo(H, N3) }
    ],
    motion: {}, orientation: { heading: 0 }
  }, stub);
  check('baseline fix far from nodes', approx(eng.getState().position.x, 20, 0.7));
  check('no proximity engaged far from nodes', eng.getState().proximity === null);

  // Miner walks to NODE02: only the N02 link survives with a STRONG signal
  // (2 m). The single range cannot trilaterate — the proximity pull must drag
  // the map to the beacon even with zero accelerometer data.
  for (let i = 0; i < 6; i++) {
    eng.update({ anchors: [{ id: 'NODE02', distance: 2 }], motion: {}, orientation: { heading: 0 } }, stub);
  }
  const st = eng.getState();
  const dToN2 = Math.hypot(st.position.x - N2.x, st.position.y - N2.y);
  check('position snapped toward NODE02', dToN2 < 5, `${dToN2.toFixed(2)} m from N2 (${st.position.x}, ${st.position.y})`);
  check('proximity lock exposed in state', st.proximity && st.proximity.id === 'NODE02',
    st.proximity ? `signal ${st.proximity.distance_m} m, pull ${st.proximity.pull}` : 'null');
  check('proximity event fired exactly once (de-dup)',
    events.filter(e => e.msg.includes('Proximity lock')).length === 1,
    `${events.filter(e => e.msg.includes('Proximity lock')).length} events`);
  check('path drew itself toward the beacon', st.waypoint_count >= 5, `${st.waypoint_count} waypoints`);
  check('moving flag raised from map displacement', st.moving === true);
}

// ─── GROUP 3: consistent anchors → NO pull (mismatch gate guard) ────────────
console.log('\n[GROUP 3] Accurate trilateration untouched (mismatch gate):');
{
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const eng = new TrajectoryEngine(cfg);
  eng.applyLockedGeometry({ n1_n2_m: 2, n2_n3_m: 1.5, n1_n3_m: 1.8 }, Date.now());
  const n = Object.fromEntries(eng.getState().geometry.nodes.map(a => [a.id, a]));

  const H = { x: 1.0, y: 0.6 };
  eng.update({
    anchors: [
      { id: 'NODE01', distance: distTo(H, n.NODE01) },
      { id: 'NODE02', distance: distTo(H, n.NODE02) },
      { id: 'NODE03', distance: distTo(H, n.NODE03) }
    ],
    motion: {}, orientation: {}
  }, null);
  const pos = eng.getState().position;
  check('accurate fix stays exact (no proximity yank)', Math.hypot(pos.x - H.x, pos.y - H.y) < 0.3, `(${pos.x}, ${pos.y})`);
  check('proximity NOT engaged when signal agrees with map', eng.getState().proximity === null);
}

// ─── GROUP 4: motion-agnostic path growth ───────────────────────────────────
console.log('\n[GROUP 4] Motion-agnostic tracking (no accelerometer data):');
{
  const eng = new TrajectoryEngine(baseConfig);
  const stub = { addEvent: () => {} };

  // Packets carry NO motion block at all — the miner "walks" from (20, 5)
  // toward (40, 5); only the beacon ranges move. (The anchor EMA lags ~2 m
  // behind a sustained walk and the correction blend adds ~2 m more — the
  // position trails the truth by ~4 m but follows at walking pace.)
  for (let i = 0; i <= 20; i++) {
    const H = { x: 20 + i, y: 5 };
    eng.update({
      anchors: [
        { id: 'NODE01', distance: distTo(H, N1) },
        { id: 'NODE02', distance: distTo(H, N2) },
        { id: 'NODE03', distance: distTo(H, N3) }
      ],
      orientation: { heading: 0 }
      // NOTE: no `motion` key — motionAbsent path
    }, stub);
  }
  const st = eng.getState();
  check('position follows beacon-driven movement', st.position.x > 30 && st.position.x < 40, `x=${st.position.x}`);
  check('moving flag derived from map displacement', st.moving === true);
  check('breadcrumb grows without step data', st.waypoint_count >= 5, `${st.waypoint_count} waypoints`);
}

// ─── GROUP 5: adaptive correction + EMA step detection ──────────────────────
console.log('\n[GROUP 5] Adaptive correction & EMA step detection:');
{
  // 5.1: stationary correction is more assertive than the walking blend,
  // but still a blend (not a snap) — regression guard for the k=0.35 path
  const eng = new TrajectoryEngine(baseConfig);
  for (let i = 0; i <= 9; i++) {
    eng.update({ motion: { moving: i > 0, distance_walked_m: i * 2.4 }, orientation: { heading: 0 } }, null);
  }
  const driftX = eng.getState().position.x;
  eng.update({
    motion: { moving: false, distance_walked_m: 21.6 },
    orientation: { heading: 0 },
    anchors: [
      { id: 'NODE01', distance: 10 },
      { id: 'NODE02', distance: 42 },
      { id: 'NODE03', distance: Math.hypot(10 - N3.x, N3.y) }
    ]
  }, null);
  const correctedX = eng.getState().position.x;
  check('stationary correction blends (not snaps)', correctedX > 12 && correctedX < 21,
    `${driftX.toFixed(1)} → ${correctedX.toFixed(1)}`);
  check('no proximity on far anchors', eng.getState().proximity === null);

  // 5.2: EMA smooths jitter but re-seeds on a genuine step change
  const eng2 = new TrajectoryEngine(baseConfig);
  eng2.update({ anchors: [{ id: 'NODE02', distance: 10 }], motion: {}, orientation: {} }, null);
  eng2.update({ anchors: [{ id: 'NODE02', distance: 10.8 }], motion: {}, orientation: {} }, null); // jitter → smoothed
  const smoothed = eng2.getState().anchors[0].distance; // rounded to 0.1 m in state
  check('jitter stays EMA-smoothed', smoothed > 10 && smoothed < 10.5, `got ${smoothed}`);
  eng2.update({ anchors: [{ id: 'NODE02', distance: 2 }], motion: {}, orientation: {} }, null); // real move → re-seed
  const reseeded = eng2.getState().anchors[0].distance;
  check('genuine step re-seeds instantly', reseeded === 2, `got ${reseeded}`);
}

// ─── GROUP 6: StateManager + state exposure ─────────────────────────────────
console.log('\n[GROUP 6] StateManager integration:');
{
  const sm = new StateManager(isolate(baseConfig));
  const rm1 = sm.getFullState().route_map;
  check('route_map exposes session (default active)', rm1.session && rm1.session.active === true);
  check('route_map exposes proximity field', 'proximity' in rm1);

  sm.trajectoryEngine.stopTracking();
  check('stopTracking reflected in full state', sm.getFullState().route_map.session.active === false);
  sm.trajectoryEngine.startTracking();
  check('startTracking reflected in full state', sm.getFullState().route_map.session.active === true);
  sm.destroy();
}

console.log(`\n=========================================================`);
console.log(fail > 0 ? ` FAILURES: ${fail}` : ' ALL v6 TRACKING TESTS PASSED: 100%');
console.log(`=========================================================`);
process.exit(fail > 0 ? 1 : 0);
