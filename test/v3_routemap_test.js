// v3 Route Mapping — ML-driven anchors, IMU dead reckoning, SET HEADING,
// 2-anchor solve, NODE01 real-range anchor. Run: node test/v3_routemap_test.js
import { StateManager } from '../src/server/stateManager.js';
import { TrajectoryEngine } from '../src/server/trajectoryEngine.js';
import { Node1Bridge } from '../src/server/node1Bridge.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// ─── GROUP 1: enrichAnchorsWithML ────────────────────────────────────────────
console.log('\n[GROUP 1] ML anchor enrichment:');
{
  const sm = new StateManager();
  const anchors = [
    { id: 'NODE01', distance: 3.5 },
    { id: 'NODE02', distance: 22.5 },
    { id: 'NODE03', distance: 5.2 }
  ];
  const tel = { anchors, motion: {}, orientation: {} };

  const mlMap = {
    link_helmet_node01: { distance: 4.0, method: 'ml', inRange: true },
    link_helmet_node02: { distance: 1.6, method: 'ml', inRange: true },
    link_helmet_node03: { distance: 25.0, method: 'ml', inRange: false } // out of validated range
  };
  const out = sm.enrichAnchorsWithML(tel, mlMap);
  const byId = Object.fromEntries(out.anchors.map(a => [a.id, a]));
  check('NODE01 replaced by ML', byId.NODE01.distance === 4.0 && byId.NODE01.source === 'ml');
  check('NODE02 replaced by ML', byId.NODE02.distance === 1.6 && byId.NODE02.source === 'ml');
  check('out-of-range ML keeps raw', byId.NODE03.distance === 5.2 && !byId.NODE03.source, `got ${byId.NODE03.distance}`);

  const out2 = sm.enrichAnchorsWithML(tel, {});
  check('empty mlMap leaves telemetry untouched', out2 === tel);

  const out3 = sm.enrichAnchorsWithML(tel, { link_helmet_node02: { distance: null, method: 'invalid_input' } });
  check('failed inference keeps raw', out3.anchors.find(a => a.id === 'NODE02').distance === 22.5);
  sm.destroy();
}

// ─── GROUP 2: 2-anchor circle-intersection solve ────────────────────────────
console.log('\n[GROUP 2] Two-anchor solve:');
{
  const sm = new StateManager();
  const eng = new TrajectoryEngine(sm.getConfig());
  // Target P=(40,2): on the corridor, between NODE02 and the entrance
  const P = { x: 40, y: 2 };
  const dN2 = Math.hypot(P.x - 52, P.y - 0);
  const dN3 = Math.hypot(P.x - 53.61, P.y - 34.96);
  eng.update({ anchors: [{ id: 'NODE02', distance: dN2 }, { id: 'NODE03', distance: dN3 }], motion: {}, orientation: {} }, null);
  const pos = eng.getState().position;
  check('first fix from 2 anchors', pos != null && approx(pos.x, P.x, 0.5) && approx(pos.y, P.y, 0.5), `(${pos?.x}, ${pos?.y}) vs (${P.x}, ${P.y})`);

  // continuity: move P along — the correction blend (k=0.15) converges over
  // several updates; assert it tracks the near candidate and settles on it
  const P2 = { x: 44, y: -1 };
  const a2 = [{ id: 'NODE02', distance: Math.hypot(P2.x - 52, P2.y) }, { id: 'NODE03', distance: Math.hypot(P2.x - 53.61, P2.y - 34.96) }];
  for (let i = 0; i < 10; i++) {
    eng.update({ anchors: a2.map(a => ({ ...a })), motion: {}, orientation: {} }, null);
  }
  const pos2 = eng.getState().position;
  check('2-anchor correction tracks movement', Math.hypot(pos2.x - P2.x, pos2.y - P2.y) < 1.8, `(${pos2.x}, ${pos2.y}) vs (${P2.x}, ${P2.y})`);
  sm.destroy();
}

// ─── GROUP 3: IMU dead reckoning — clockwise tunnel-relative heading ────────
console.log('\n[GROUP 3] Helmet IMU dead reckoning:');
{
  const sm = new StateManager();
  const eng = new TrajectoryEngine(sm.getConfig());
  // accelerometer odometry: distance_walked_m from the helmet step counter
  eng.update({ motion: { moving: true, distance_walked_m: 0 }, orientation: { heading: 90 } }, null);
  eng.update({ motion: { moving: true, distance_walked_m: 2 }, orientation: { heading: 90 } }, null);
  let pos = eng.getState().position;
  check('heading 90° (RIGHT turn) moves +y', approx(pos.x, 0, 0.05) && approx(pos.y, 2, 0.05), `(${pos.x}, ${pos.y})`);

  eng.update({ motion: { moving: true, distance_walked_m: 4 }, orientation: { heading: 270 } }, null);
  pos = eng.getState().position;
  check('heading 270° (LEFT turn) moves −y', approx(pos.y, 0, 0.05), `y=${pos.y}`);

  // step-count fallback (no distance_walked_m): stride from config
  const eng2 = new TrajectoryEngine(sm.getConfig());
  eng2.update({ motion: { step_count: 10 }, orientation: { heading: 0 } }, null);
  eng2.update({ motion: { step_count: 12 }, orientation: { heading: 0 } }, null);
  const pos2 = eng2.getState().position;
  check('step-count DR: 2 steps × 0.75 m forward (+x)', approx(pos2.x, 1.5, 0.05), `x=${pos2.x}`);
  sm.destroy();
}

// ─── GROUP 4: SET HEADING runtime calibration ────────────────────────────────
console.log('\n[GROUP 4] SET HEADING calibration:');
{
  const sm = new StateManager();
  const eng = new TrajectoryEngine(sm.getConfig());
  const fail = eng.setHeadingZero();
  check('calibration rejected before any heading', fail.success === false);

  eng.update({ motion: { distance_walked_m: 0 }, orientation: { heading: 90 } }, null);
  const res = eng.setHeadingZero();
  check('calibration succeeds with heading', res.success === true && res.heading_offset_deg === 270, `offset=${res.heading_offset_deg}`);

  eng.update({ motion: { moving: true, distance_walked_m: 2 }, orientation: { heading: 90 } }, null);
  const st = eng.getState();
  check('raw 90° now applies as 0° (tunnel-forward)', st.position.heading === 0, `heading=${st.position.heading}`);
  check('calibrated forward walk moves +x', approx(st.position.x, 2, 0.05), `x=${st.position.x}`);
  check('state exposes offset + raw heading', st.heading_offset_deg === 270 && st.raw_heading_deg === 90);
  sm.destroy();
}

// ─── GROUP 5: NODE01 anchor uses the REAL direct range ──────────────────────
console.log('\n[GROUP 5] Bridge NODE01 anchor:');
{
  const sm = new StateManager();
  const bridge = new Node1Bridge(sm, '192.168.14.60', 1500);
  const base = {
    system: { active_route: '', overall_risk_index: 'LOW' },
    miner: { worker_id: 'MINER 01', status: 'SAFE', motion_state: 'MOVING', step_count: 5, total_distance_m: 99, heading_deg: 90 },
    environment: { temperature_c: 30, humidity_pct: 60, mq4_methane_ppm: 100, mq6_lpg_ppm: 110, mq8_hydrogen_ppm: 120 },
    mesh_topology: {
      node2_relay: { online: true, rssi_dbm: -65, snr_db: 9, distance_to_helmet_m: 22.5, distance_to_node3_m: 15, helmet_link: true, helmet_rssi_db: -72.4, helmet_snr_db: 8.75 },
      node3_relay: { online: true, rssi_dbm: -55, snr_db: 10, distance_to_helmet_m: 5.2, helmet_link: true, helmet_rssi_db: -60.2, helmet_snr_db: 9.5 },
      helmet_direct: { online: true, rssi_dbm: -58, snr_db: 9.5, distance_to_helmet_m: 3.5 },
      tunnel_position: { nearest_node: 'NODE03', relative_slider_pct: 65 }
    },
    active_alerts: [],
    active_emergencies: []
  };
  const t1 = bridge.translate(base);
  const a1 = Object.fromEntries(t1.anchors.map(a => [a.id, a.distance]));
  check('NODE01 anchor = direct range 3.5 m', a1.NODE01 === 3.5, `got ${a1.NODE01}`);
  check('odometry (99 m) NOT used as a range', !Object.values(a1).includes(99));
  check('NODE02/NODE03 relay ranges pass', a1.NODE02 === 22.5 && a1.NODE03 === 5.2);

  const noDirect = JSON.parse(JSON.stringify(base));
  delete noDirect.mesh_topology.helmet_direct.distance_to_helmet_m;
  const t2 = bridge.translate(noDirect);
  check('missing direct range → no NODE01 anchor (never odometry)', !t2.anchors.some(a => a.id === 'NODE01'), `${t2.anchors.length} anchors`);
  sm.destroy();
}

// ─── GROUP 6: full pipeline — ML distances drive the route map ───────────────
console.log('\n[GROUP 6] Full pipeline (ML-stubbed, live node1 config):');
{
  const sm = new StateManager(); // default config: data_source "node1" → live mode
  sm.mlEstimator = {
    isReady: () => true,
    estimateDistance: async () => ({ distance: 10, method: 'ml', inRange: true, defaultSnr: false })
  };
  const pkt = {
    version: '1.0',
    helmet_id: 'HELMET01',
    timestamp: Math.floor(Date.now() / 1000),
    environment: { temperature: 30, humidity: 60, methane: 10, carbon_monoxide: 10, smoke: 10 },
    safety: { sos: false },
    motion: { moving: false, step_count: 0, distance_walked_m: 0 },
    orientation: { heading: 90 },
    anchors: [{ id: 'NODE01', distance: 3.5 }, { id: 'NODE02', distance: 22.5 }, { id: 'NODE03', distance: 5.2 }],
    network: {
      connected_node: 'NODE03',
      links: [
        { id: 'link_helmet_node01', source: 'HELMET01', destination: 'NODE01', rssi: -58, snr: 9.5, distance: 3.5, status: 'CONNECTED', available: true },
        { id: 'link_helmet_node02', source: 'HELMET01', destination: 'NODE02', rssi: -70, snr: 9, distance: 22.5, status: 'CONNECTED', available: true },
        { id: 'link_helmet_node03', source: 'HELMET01', destination: 'NODE03', rssi: -60, snr: 9.5, distance: 5.2, status: 'CONNECTED', available: true }
      ]
    }
  };
  const state = await sm.processTelemetry(pkt);
  const rm = state.route_map;
  check('route map tracking active', rm.tracking === true && rm.position != null && Number.isFinite(rm.position.x));
  const aById = Object.fromEntries(rm.anchors.map(a => [a.id, a.distance]));
  // ML distance 10 replaces raw anchors; applyHelmetOffset then trims displays (2/3/5 m)
  check('NODE01 anchor driven by ML (10 − 2)', aById.NODE01 === 8, `got ${aById.NODE01}`);
  check('NODE02 anchor driven by ML (10 − 3)', aById.NODE02 === 7, `got ${aById.NODE02}`);
  check('NODE03 anchor driven by ML (10 − 5)', aById.NODE03 === 5, `got ${aById.NODE03}`);
  check('raw heading exposed in route map state', rm.raw_heading_deg === 90 && rm.heading_offset_deg === 0);
  sm.destroy();
}

console.log(`\n=========================================================`);
console.log(fail > 0 ? ` FAILURES: ${fail}` : ' ALL v3 ROUTE MAP TESTS PASSED: 100%');
console.log(`=========================================================`);
process.exit(fail > 0 ? 1 : 0);
