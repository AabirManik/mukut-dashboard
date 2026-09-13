// v5 Range Calibration — two-point fit on real hardware, fitted curve driving
// bridge distances/anchors/mesh geometry, ML-enrichment bypass, offset gating,
// persistence. Run: node test/v5_rangecal_test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { StateManager } from '../src/server/stateManager.js';
import { RangeCalibrator } from '../src/server/rangeCalibrator.js';
import { Node1Bridge } from '../src/server/node1Bridge.js';
import { isolatedConfig } from './helpers/isolated_config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/default.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK ${name} ${extra}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── GROUP 1: two-point capture + fit ────────────────────────────────────────
console.log('\n[GROUP 1] Two-point fit:');
{
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.range_calibration = { capture_window_ms: 15, min_samples: 2, reference_link: 'link_helmet_node02' };
  const rc = new RangeCalibrator(cfg);
  const events = [];
  let locked = null;
  rc.onEvent = (s, m) => events.push({ s, m });
  rc.onLock = (d) => { locked = d; };

  const tel = (rssi) => ({ network: { links: [
    { id: 'link_helmet_node02', rssi, status: 'CONNECTED' },
    { id: 'link_helmet_node03', rssi: -70, status: 'CONNECTED' }
  ] } });

  check('capture 1 starts', rc.startCapture(1, 1).started === true);
  check('double capture rejected', rc.startCapture(2, 3).started === false);
  rc.sample(tel(-50)); rc.sample(tel(-50.2)); rc.sample(tel(-49.8));
  await sleep(25);
  const r1 = rc.sample(tel(-50)); // window elapsed → finalize point 1
  check('point 1 captured', r1 && r1.captured === true && r1.calibrated === false);
  check('not calibrated after one point', rc.isCalibrated() === false);

  rc.startCapture(2, 3);
  rc.sample(tel(-60)); rc.sample(tel(-60.1));
  await sleep(25);
  const r2 = rc.sample(tel(-59.9));
  check('point 2 captured + calibrated', r2 && r2.captured === true && r2.calibrated === true, JSON.stringify({ A: r2.A, n: r2.n }));
  // n = (−50 − (−60)) / (10·log10 3) ≈ 2.10 ; A = −50 (1 m point)
  check('fit solves real A/n', rc.A === -50 && approx(rc.n, 2.1, 0.01), `A=${rc.A} n=${rc.n}`);
  check('lock event + persist hook fired', events.some(e => e.s === 'INFO' && e.m.includes('LOCKED')) && locked != null && locked.A === -50);

  // curve conversions
  check('fitted(−50) = 1 m (the calibration point)', rc.fittedDistance(-50) === 1);
  check('fitted(−60) ≈ 3 m (the calibration point)', approx(rc.fittedDistance(-60), 3, 0.05), `got ${rc.fittedDistance(-60)}`);
  check('fitted(−70) ≈ 9 m (extrapolates correctly)', approx(rc.fittedDistance(-70), 9, 0.3), `got ${rc.fittedDistance(-70)}`);
  check('fitted caps at 30 m', rc.fittedDistance(-100) === 30);
  check('fitted rejects invalid rssi', rc.fittedDistance(0) === null && rc.fittedDistance(null) === null);
}

// ─── GROUP 2: insufficient samples → failure ────────────────────────────────
console.log('\n[GROUP 2] Failure path:');
{
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.range_calibration = { capture_window_ms: 15, min_samples: 5 };
  const rc = new RangeCalibrator(cfg);
  const events = [];
  rc.onEvent = (s, m) => events.push({ s, m });
  rc.startCapture(1, 1);
  rc.sample({ network: { links: [{ id: 'link_helmet_node02', rssi: -50, status: 'CONNECTED' }] } });
  await sleep(25);
  const r = rc.sample({ network: { links: [] } });
  check('too few samples → not captured', r && r.captured === false);
  check('failure WARNING emitted', events.some(e => e.s === 'WARNING'));
  check('stays uncalibrated', rc.isCalibrated() === false && rc.status === 'IDLE');
}

// ─── GROUP 3: bridge uses the fitted curve everywhere ───────────────────────
console.log('\n[GROUP 3] Bridge fitted distances:');
{
  const sm = new StateManager(isolatedConfig()); // live node1 mode, persistence isolated
  sm.rangeCalibrator.restore({ A: -50, n: 2.1 });
  const bridge = new Node1Bridge(sm, '192.168.14.60', 1500);
  const payload = {
    system: { active_route: '', overall_risk_index: 'LOW' },
    miner: { worker_id: 'MINER 01', status: 'SAFE', motion_state: 'STATIONARY', step_count: 0, total_distance_m: 0, heading_deg: 0 },
    environment: { temperature_c: 30, humidity_pct: 60, mq4_methane_ppm: 100, mq6_lpg_ppm: 110, mq8_hydrogen_ppm: 120 },
    mesh_topology: {
      node2_relay: { online: true, rssi_dbm: -65, snr_db: 9, distance_to_helmet_m: 1.6, distance_to_node3_m: 1.5, distance_to_node1_m: 2.1, helmet_link: true, helmet_rssi_db: -72.4, helmet_snr_db: 8.75 },
      node3_relay: { online: true, rssi_dbm: -55, snr_db: 10, distance_to_helmet_m: 0.8, distance_to_node1_m: 1.9, helmet_link: true, helmet_rssi_db: -60.2, helmet_snr_db: 9.5, peer_rssi_db: -66.5, peer_snr_db: 11 },
      helmet_direct: { online: true, rssi_dbm: -58, snr_db: 9.5, distance_to_helmet_m: 3.5 },
      tunnel_position: { nearest_node: 'NODE03', relative_slider_pct: 65 }
    },
    active_alerts: [],
    active_emergencies: []
  };
  const t = bridge.translate(payload);
  const links = Object.fromEntries(t.network.links.map(l => [l.id, l]));
  // fitted(−72.4) = 10^(22.4/21) ≈ 11.7 m — NOT the relay's 1.6
  check('helmet→N2 uses fitted curve', approx(links.link_helmet_node02.distance, 11.7, 0.15), `got ${links.link_helmet_node02.distance}`);
  // fitted(−60.2) = 10^(10.2/21) ≈ 3.1 m
  check('helmet→N3 uses fitted curve', approx(links.link_helmet_node03.distance, 3.1, 0.15), `got ${links.link_helmet_node03.distance}`);
  // fitted(−58) = 10^(8/21) ≈ 2.4 m
  check('helmet→N1 uses fitted curve', approx(links.link_helmet_node01.distance, 2.4, 0.15), `got ${links.link_helmet_node01.distance}`);
  const a = Object.fromEntries(t.anchors.map(x => [x.id, x.distance]));
  check('anchors use fitted curve', approx(a.NODE02, 11.7, 0.15) && approx(a.NODE03, 3.1, 0.15), JSON.stringify(a));
  // mesh: n1_n2 from trunk −65 → ≈5.2 ; n2_n3 from peer −66.5 → ≈6.1 ; n1_n3 from trunk −55 → ≈1.7
  check('mesh geometry uses fitted curve', approx(t.mesh_geometry.n1_n2_m, 5.2, 0.2) && approx(t.mesh_geometry.n2_n3_m, 6.1, 0.2) && approx(t.mesh_geometry.n1_n3_m, 1.7, 0.2), JSON.stringify(t.mesh_geometry));

  // uncalibrated → previous behavior (relay distances)
  const sm2 = new StateManager(isolatedConfig());
  const bridge2 = new Node1Bridge(sm2, '192.168.14.60', 1500);
  const t2 = bridge2.translate(payload);
  const l2 = Object.fromEntries(t2.network.links.map(l => [l.id, l]));
  check('uncalibrated keeps relay distances', l2.link_helmet_node02.distance === 1.6, `got ${l2.link_helmet_node02.distance}`);
  sm.destroy();
  sm2.destroy();
}

// ─── GROUP 4: pipeline — ML bypass + display offsets disabled ───────────────
console.log('\n[GROUP 4] Pipeline integration:');
{
  const sm = new StateManager(isolatedConfig());
  sm.rangeCalibrator.restore({ A: -50, n: 2.1 });
  sm.mlEstimator = {
    isReady: () => true,
    estimateDistance: async () => ({ distance: 10, method: 'ml', inRange: true, defaultSnr: false })
  };
  const bridge = new Node1Bridge(sm, '192.168.14.60', 1500);
  const payload = {
    system: { active_route: '', overall_risk_index: 'LOW' },
    miner: { worker_id: 'MINER 01', status: 'SAFE', motion_state: 'STATIONARY', step_count: 0, total_distance_m: 0, heading_deg: 90 },
    environment: { temperature_c: 30, humidity_pct: 60, mq4_methane_ppm: 100, mq6_lpg_ppm: 110, mq8_hydrogen_ppm: 120 },
    mesh_topology: {
      node2_relay: { online: true, rssi_dbm: -65, snr_db: 9, distance_to_helmet_m: 1.6, distance_to_node3_m: 1.5, helmet_link: true, helmet_rssi_db: -72.4, helmet_snr_db: 8.75 },
      node3_relay: { online: true, rssi_dbm: -55, snr_db: 10, distance_to_helmet_m: 0.8, helmet_link: true, helmet_rssi_db: -60.2, helmet_snr_db: 9.5 },
      helmet_direct: { online: true, rssi_dbm: -58, snr_db: 9.5, distance_to_helmet_m: 3.5 },
      tunnel_position: { nearest_node: 'NODE03', relative_slider_pct: 65 }
    },
    active_alerts: [],
    active_emergencies: []
  };
  const state = await sm.processTelemetry(bridge.translate(payload));
  const rmA = Object.fromEntries(state.route_map.anchors.map(a => [a.id, a.distance]));
  check('ML enrichment bypassed — anchors stay fitted', approx(rmA.NODE02, 11.7, 0.2) && rmA.NODE02 !== 10, `NODE02=${rmA.NODE02}`);
  const link = state.network.links.find(l => l.id === 'link_helmet_node02');
  check('display offsets disabled when calibrated', approx(link.distance, 11.7, 0.2), `display=${link.distance} (offset would give 8.7)`);
  check('range_cal exposed in state', state.range_cal.calibrated === true && state.range_cal.A === -50);
  sm.destroy();
}

// ─── GROUP 5: persistence across restarts ────────────────────────────────────
console.log('\n[GROUP 5] Persistence:');
{
  const tmpFile = path.join(os.tmpdir(), 'opencode', 'rangecal_test.json');
  try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.range_calibration = { ...cfg.range_calibration, file: tmpFile };

  const sm1 = new StateManager(cfg);
  check('saveRangeCal writes file', sm1.saveRangeCal({ points: { 1: { distance_m: 1, rssi: -50 }, 2: { distance_m: 3, rssi: -60 } }, A: -50, n: 2.1, saved_at: Date.now() }) === true && fs.existsSync(tmpFile));
  sm1.destroy();

  const sm2 = new StateManager(cfg); // "restart"
  check('fitted curve restored on boot', sm2.rangeCalibrator.isCalibrated() === true && sm2.rangeCalibrator.A === -50 && sm2.rangeCalibrator.n === 2.1);
  check('helmet display offsets auto-disabled on restore', sm2.calibrationEngine.disableHelmetOffset === true);
  check('clearRangeCalFile removes persistence', sm2.clearRangeCalFile() === true && !fs.existsSync(tmpFile));
  sm2.destroy();
}

console.log(`\n=========================================================`);
console.log(fail > 0 ? ` FAILURES: ${fail}` : ' ALL v5 RANGE CALIBRATION TESTS PASSED: 100%');
console.log(`=========================================================`);
process.exit(fail > 0 ? 1 : 0);
