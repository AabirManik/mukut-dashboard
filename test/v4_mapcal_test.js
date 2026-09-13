// v4 Dynamic Map Calibration — measured geometry, 8 s lock-in ceremony,
// persistence, mesh_geometry bridge mapping, tracking accuracy on real layout.
// Run: node test/v4_mapcal_test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { StateManager } from '../src/server/stateManager.js';
import { TrajectoryEngine, buildGeometryFromDistances } from '../src/server/trajectoryEngine.js';
import { Node1Bridge } from '../src/server/node1Bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/default.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── GROUP 1: geometry from measured distances ──────────────────────────────
console.log('\n[GROUP 1] buildGeometryFromDistances:');
{
  // Physical placement: N1↔N2 2 m, N2↔N3 1.5 m, N1↔N3 1.8 m
  const geo = buildGeometryFromDistances(2.0, 1.5, 1.8, 18);
  const byId = Object.fromEntries(geo.anchors.map(a => [a.id, a]));
  check('NODE01 at origin', byId.NODE01.x === 0 && byId.NODE01.y === 0);
  check('NODE02 on +x at measured d12', byId.NODE02.x === 2 && byId.NODE02.y === 0);
  // x3 = (2² + 1.8² − 1.5²) / (2·2) = 1.2475 ; y3 = √(1.8² − x3²) ≈ 1.2976
  check('NODE03 trilaterated (+y side)', approx(byId.NODE03.x, 1.2475, 0.01) && approx(byId.NODE03.y, 1.2976, 0.01), `(${byId.NODE03.x}, ${byId.NODE03.y})`);
  check('polyline = 3 nodes + capped face ext', geo.polyline.length === 4);
  const tail = Math.hypot(geo.polyline[3].x - byId.NODE03.x, geo.polyline[3].y - byId.NODE03.y);
  check('face extension capped to real scale (2 m)', approx(tail, 2, 0.05), `tail=${tail.toFixed(2)}`);
  check('invalid distances → null', buildGeometryFromDistances(0, 1.5, 1.8, 18) === null && buildGeometryFromDistances(-1, 1.5, 1.8, 18) === null);
}

// ─── GROUP 2: 8-second calibration ceremony + lock ──────────────────────────
console.log('\n[GROUP 2] Map calibration ceremony:');
{
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.trajectory.map_calibration_ms = 60; // fast for tests (default 8000)
  const eng = new TrajectoryEngine(cfg);
  const events = [];
  let saved = null;
  const fakeSm = {
    addEvent: (severity, message) => events.push({ severity, message }),
    saveMapGeometry: (data) => { saved = data; return true; }
  };

  const start = eng.startMapCalibration();
  check('calibration starts', start.started === true && start.duration_ms === 60);
  check('double-start rejected', eng.startMapCalibration().started === false);

  // Feed noisy samples around the real placement (helmet-agnostic: stations only)
  const samples = [
    { n1_n2_m: 2.0, n2_n3_m: 1.5, n1_n3_m: 1.8 },
    { n1_n2_m: 2.2, n2_n3_m: 1.4, n1_n3_m: 1.9 },
    { n1_n2_m: 1.9, n2_n3_m: 1.6, n1_n3_m: 1.7 },
    { n1_n2_m: 2.1, n2_n3_m: 1.5, n1_n3_m: 1.8 },
    { n1_n2_m: 2.0, n2_n3_m: 1.5, n1_n3_m: 1.8 }
  ];
  for (const s of samples) {
    eng.update({ mesh_geometry: s, anchors: [], motion: {}, orientation: {} }, fakeSm);
  }
  check('still RUNNING before duration', eng.getState().geometry.calibrating === true);

  await sleep(70); // ceremony window elapses
  eng.update({ mesh_geometry: samples[0], anchors: [], motion: {}, orientation: {} }, fakeSm);

  const st = eng.getState();
  check('locked after 8 s window', st.geometry.source === 'calibrated' && st.geometry.calibrating === false);
  // 6 samples total (the finalizing packet's sample is included): avg 12.2/6 = 2.03
  check('averages locked once (2.03 / 1.5 / 1.8)', approx(st.geometry.distances.n1_n2_m, 2.03, 0.01) && approx(st.geometry.distances.n2_n3_m, 1.5, 0.01) && approx(st.geometry.distances.n1_n3_m, 1.8, 0.01), JSON.stringify(st.geometry.distances));
  check('anchors follow the measured placement', approx(st.geometry.nodes.find(a => a.id === 'NODE02').x, 2.03, 0.05), `N2.x=${st.geometry.nodes.find(a => a.id === 'NODE02').x}`);
  check('lock INFO event emitted', events.some(e => e.severity === 'INFO' && e.message.includes('LOCKED')));
  check('geometry persisted via stateManager hook', saved != null && approx(saved.distances.n1_n2_m, 2.03, 0.01), saved ? JSON.stringify(saved.distances) : 'null');
}

// ─── GROUP 3: failure + clear ────────────────────────────────────────────────
console.log('\n[GROUP 3] Failure and clear:');
{
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.trajectory.map_calibration_ms = 50;
  const eng = new TrajectoryEngine(cfg);
  const events = [];
  const fakeSm = { addEvent: (severity, message) => events.push({ severity, message }) };

  eng.startMapCalibration();
  eng.update({ anchors: [], motion: {}, orientation: {} }, fakeSm); // no mesh_geometry
  await sleep(60);
  eng.update({ anchors: [], motion: {}, orientation: {} }, fakeSm);
  check('no samples → calibration fails back to preset', eng.getState().geometry.source === 'preset' && eng.getState().geometry.calibrating === false);
  check('failure WARNING emitted', events.some(e => e.severity === 'WARNING' && e.message.includes('failed')));

  eng.applyLockedGeometry({ n1_n2_m: 2, n2_n3_m: 1.5, n1_n3_m: 1.8 }, Date.now());
  check('applyLockedGeometry switches source', eng.getState().geometry.source === 'calibrated');
  eng.clearMapCalibration();
  const st = eng.getState();
  check('clear returns to preset layout', st.geometry.source === 'preset' && st.geometry.nodes.find(a => a.id === 'NODE02').x === 52, `N2.x=${st.geometry.nodes.find(a => a.id === 'NODE02').x}`);
}

// ─── GROUP 4: persistence across StateManager restarts ──────────────────────
console.log('\n[GROUP 4] Persistence:');
{
  const tmpFile = path.join(os.tmpdir(), 'opencode', 'mapcal_test.json');
  try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.trajectory.map_geometry_file = tmpFile;

  const sm1 = new StateManager(cfg);
  sm1.trajectoryEngine.applyLockedGeometry({ n1_n2_m: 2, n2_n3_m: 1.5, n1_n3_m: 1.8 }, Date.now());
  check('saveMapGeometry writes file', sm1.saveMapGeometry({ distances: { n1_n2_m: 2, n2_n3_m: 1.5, n1_n3_m: 1.8 }, locked_at: Date.now() }) === true && fs.existsSync(tmpFile));
  sm1.destroy();

  const sm2 = new StateManager(cfg); // "restart"
  const st = sm2.getFullState().route_map;
  check('locked geometry restored on boot', st.geometry.source === 'calibrated' && st.geometry.distances.n1_n2_m === 2, JSON.stringify(st.geometry.distances));
  check('restored anchors follow measured placement', approx(st.geometry.nodes.find(a => a.id === 'NODE02').x, 2, 0.01), `N2.x=${st.geometry.nodes.find(a => a.id === 'NODE02').x}`);
  check('clearMapGeometryFile removes persistence', sm2.clearMapGeometryFile() === true && !fs.existsSync(tmpFile));
  sm2.destroy();
}

// ─── GROUP 5: bridge mesh_geometry mapping ───────────────────────────────────
console.log('\n[GROUP 5] Bridge mesh_geometry:');
{
  const sm = new StateManager();
  const bridge = new Node1Bridge(sm, '192.168.14.60', 1500);
  const payload = {
    system: { active_route: '', overall_risk_index: 'LOW' },
    miner: { worker_id: 'MINER 01', status: 'SAFE', motion_state: 'STATIONARY', step_count: 0, total_distance_m: 0, heading_deg: 0 },
    environment: { temperature_c: 30, humidity_pct: 60, mq4_methane_ppm: 100, mq6_lpg_ppm: 110, mq8_hydrogen_ppm: 120 },
    mesh_topology: {
      node2_relay: { online: true, rssi_dbm: -65, snr_db: 9, distance_to_helmet_m: 1.6, distance_to_node3_m: 1.5, distance_to_node1_m: 2.1, helmet_link: true, helmet_rssi_db: -72.4, helmet_snr_db: 8.75 },
      node3_relay: { online: true, rssi_dbm: -55, snr_db: 10, distance_to_helmet_m: 0.8, distance_to_node1_m: 1.9, helmet_link: true, helmet_rssi_db: -60.2, helmet_snr_db: 9.5 },
      helmet_direct: { online: true, rssi_dbm: -58, snr_db: 9.5, distance_to_helmet_m: 3.5 },
      tunnel_position: { nearest_node: 'NODE03', relative_slider_pct: 65 }
    },
    active_alerts: [],
    active_emergencies: []
  };
  const t = bridge.translate(payload);
  check('firmware ranges pass through', t.mesh_geometry.n1_n2_m === 2.1 && t.mesh_geometry.n2_n3_m === 1.5 && t.mesh_geometry.n1_n3_m === 1.9, JSON.stringify(t.mesh_geometry));

  const old = JSON.parse(JSON.stringify(payload));
  delete old.mesh_topology.node2_relay.distance_to_node1_m;
  delete old.mesh_topology.node3_relay.distance_to_node1_m;
  const t2 = bridge.translate(old);
  // static fallback: N1↔N2 from trunk rssi −65 → 10^(20/22) ≈ 8.11 m;
  // N1↔N3 from trunk rssi −55 → 10^(10/22) ≈ 2.85 m
  check('old firmware falls back to static profile', approx(t2.mesh_geometry.n1_n2_m, 8.1, 0.1) && approx(t2.mesh_geometry.n1_n3_m, 2.8, 0.1), JSON.stringify(t2.mesh_geometry));

  check('staticLinkDistance math mirrors firmware', Node1Bridge.staticLinkDistance(-45) === 1 && approx(Node1Bridge.staticLinkDistance(-40), 0.75, 0.001) && Node1Bridge.staticLinkDistance(-100) === 30 && Node1Bridge.staticLinkDistance(0) === null);
  sm.destroy();
}

// ─── GROUP 6: helmet tracks accurately on the REAL layout ───────────────────
console.log('\n[GROUP 6] Tracking accuracy on measured layout:');
{
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  const eng = new TrajectoryEngine(cfg);
  eng.applyLockedGeometry({ n1_n2_m: 2, n2_n3_m: 1.5, n1_n3_m: 1.8 }, Date.now());
  const n = Object.fromEntries(eng.getState().geometry.nodes.map(a => [a.id, a]));

  // Helmet physically at (1.0, 0.6) — ML-calculated anchor ranges
  const H = { x: 1.0, y: 0.6 };
  const dist = (a) => Math.hypot(H.x - a.x, H.y - a.y);
  eng.update({
    anchors: [
      { id: 'NODE01', distance: dist(n.NODE01) },
      { id: 'NODE02', distance: dist(n.NODE02) },
      { id: 'NODE03', distance: dist(n.NODE03) }
    ],
    motion: {}, orientation: {}
  }, null);
  const pos = eng.getState().position;
  check('helmet position exact on measured geometry', Math.hypot(pos.x - H.x, pos.y - H.y) < 0.3, `(${pos.x}, ${pos.y}) vs (${H.x}, ${H.y})`);

  // helmet moves toward NODE03 → position follows
  const H2 = { x: 1.1, y: 0.9 };
  for (let i = 0; i < 12; i++) {
    eng.update({
      anchors: [
        { id: 'NODE01', distance: Math.hypot(H2.x - n.NODE01.x, H2.y - n.NODE01.y) },
        { id: 'NODE02', distance: Math.hypot(H2.x - n.NODE02.x, H2.y - n.NODE02.y) },
        { id: 'NODE03', distance: Math.hypot(H2.x - n.NODE03.x, H2.y - n.NODE03.y) }
      ],
      motion: {}, orientation: {}
    }, null);
  }
  const pos2 = eng.getState().position;
  check('movement toward node tracked', Math.hypot(pos2.x - H2.x, pos2.y - H2.y) < 0.4, `(${pos2.x}, ${pos2.y}) vs (${H2.x}, ${H2.y})`);
}

console.log(`\n=========================================================`);
console.log(fail > 0 ? ` FAILURES: ${fail}` : ' ALL v4 MAP CALIBRATION TESTS PASSED: 100%');
console.log(`=========================================================`);
process.exit(fail > 0 ? 1 : 0);
