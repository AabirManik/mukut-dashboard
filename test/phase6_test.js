import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';
import { CalibrationEngine } from '../src/server/calibrationEngine.js';
import { isolatedConfig } from './helpers/isolated_config.js';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 6 Automated Test Suite');
console.log(' (RSSI Distance Calibration: model, lock, display layer)');
console.log('------------------------------------------------------------');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../config/default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// 1. Config & Path-Loss Model
console.log('\n[TEST GROUP 1] Config & Path-Loss Model:');
{
  assert.ok(config.calibration && config.calibration.sample_window_s === 5, 'Calibration window must be configured');
  assert.ok(config.calibration.path_loss && typeof config.calibration.path_loss.ref_rssi_1m === 'number', 'Path-loss constants must be configured');
  console.log(`  ✓ Config: window ${config.calibration.sample_window_s}s, A=${config.calibration.path_loss.ref_rssi_1m} dBm@1m, n=${config.calibration.path_loss.exponent_n}`);

  const eng = new CalibrationEngine(config);
  assert.ok(Math.abs(eng.rssiToDistance(-55) - 1) < 0.01, 'A at 1 m must map to exactly 1 m');
  assert.ok(Math.abs(eng.rssiToDistance(-83) - 10) < 0.1, '28 dB below A must map to 10 m (n=2.8 decade)');
  console.log('  ✓ Model: -55 dBm → 1.0 m ; -83 dBm → 10.0 m');
}

// 2. CalibrationEngine Unit Tests
console.log('\n[TEST GROUP 2] Calibration Engine:');
{
  const events = [];
  const stub = {
    links: [
      { id: 'link_helmet_node03', source: 'HELMET01', destination: 'NODE03', rssi: -61, distance: 18, hide_metrics: false },
      { id: 'link_node03_node02', source: 'NODE03', destination: 'NODE02', rssi: -70, distance: 35, hide_metrics: false },
      { id: 'link_node02_node01', source: 'NODE02', destination: 'NODE01', rssi: null, distance: null, hide_metrics: true },
      { id: 'link_node03_node01', source: 'NODE03', destination: 'NODE01', rssi: -79, distance: 64, hide_metrics: false }
    ],
    addEvent: (sev, msg) => events.push(msg)
  };

  const eng = new CalibrationEngine(config);
  const started = eng.start(stub);
  assert.ok(started.started, 'Calibration must start');
  assert.strictEqual(started.phases, 3, 'Trunk (no RSSI) must be excluded from phases');
  assert.strictEqual(eng.status, 'RUNNING');
  console.log(`  ✓ Start: ${started.phases} phases queued (trunk excluded), status RUNNING`);

  const packet = (id, rssi) => ({ network: { links: [{ id, rssi }] } });

  eng.collect(packet('link_helmet_node03', -61), stub);
  eng.collect(packet('link_helmet_node03', -60), stub);
  eng.phases[0].startedAt = Date.now() - 6000;
  eng.collect(packet('link_helmet_node03', -61), stub);

  const lock1 = eng.locked['link_helmet_node03'];
  assert.ok(lock1, 'Phase 0 must lock after window expiry');
  assert.ok(Math.abs(lock1.rssi_avg - (-60.7)) < 0.1, `Averaged RSSI (got ${lock1.rssi_avg})`);
  assert.ok(lock1.distance > 1.3 && lock1.distance < 1.9, `Model distance from avg (got ${lock1.distance})`);
  console.log(`  ✓ Phase 1 locked: avg ${lock1.rssi_avg} dBm → ${lock1.distance} m`);

  eng.collect(packet('link_node03_node02', -70), stub);
  eng.phases[1].startedAt = Date.now() - 6000;
  eng.collect(packet('link_node03_node02', -70), stub);
  const lock2 = eng.locked['link_node03_node02'];
  assert.ok(lock2 && lock2.distance > 3.0 && lock2.distance < 3.9, `N3-N2 lock (got ${lock2 && lock2.distance})`);

  eng.collect(packet('link_node03_node01', -79), stub);
  eng.phases[2].startedAt = Date.now() - 6000;
  eng.collect(packet('link_node03_node01', -79), stub);
  assert.strictEqual(eng.status, 'LOCKED', 'All phases done → LOCKED');
  assert.strictEqual(Object.keys(eng.locked).length, 3);
  assert.ok(events.some(m => m.includes('LOCKED')), 'Lock event must fire');
  console.log(`  ✓ All 3 phases locked → status LOCKED (${Object.keys(eng.locked).length} distances)`);

  const frozen = eng.displayDistance({ id: 'link_helmet_node03', rssi: -61, distance: 999, hide_metrics: false });
  assert.strictEqual(frozen, eng.locked['link_helmet_node03'].distance, 'Locked link must ignore incoming distance');
  assert.notStrictEqual(frozen, 999);

  const trunk = eng.displayDistance({ id: 'link_node02_node01', rssi: null, distance: null, hide_metrics: true });
  assert.strictEqual(trunk, null, 'Trunk (no RSSI) must stay untouched');

  const applied = eng.applyToLinks(stub.links);
  assert.strictEqual(applied.find(l => l.id === 'link_helmet_node03').distance, eng.locked['link_helmet_node03'].distance);
  assert.strictEqual(applied.find(l => l.id === 'link_node02_node01').distance, null);
  console.log('  ✓ Display layer: locked values applied, trunk untouched');

  assert.strictEqual(eng.anchorDisplay({ id: 'NODE03', distance: 18 }), eng.locked['link_helmet_node03'].distance, 'NODE03 anchor must show locked value');
  assert.strictEqual(eng.anchorDisplay({ id: 'NODE01', distance: 75.9 }), 73.9, 'Unlocked anchor passthrough minus the NODE01 helmet display offset (2 m)');
  console.log('  ✓ Anchor display: NODE03 locked, unlocked nodes passthrough');

  const eng2 = new CalibrationEngine(config);
  const e1 = eng2.displayDistance({ id: 'link_helmet_node03', rssi: -61, hide_metrics: false });
  assert.ok(e1 > 1.4 && e1 < 1.9, `Live model first value (got ${e1})`);
  const e2 = eng2.displayDistance({ id: 'link_helmet_node03', rssi: -66, hide_metrics: false });
  assert.ok(e2 > e1 && e2 < 2.4, `EMA smoothing moves partially (got ${e2})`);
  console.log(`  ✓ Live (uncalibrated) mode: model + EMA (${e1} m → ${e2} m on RSSI drop)`);

  eng.clear(stub);
  assert.strictEqual(eng.status, 'IDLE');
  assert.strictEqual(Object.keys(eng.locked).length, 0);
  console.log('  ✓ Clear returns to IDLE with no locks');
}

// 3. StateManager Integration (full pipeline through simulator)
console.log('\n[TEST GROUP 3] State & Pipeline Integration:');
{
  const sm = new StateManager(isolatedConfig());
  const sim = new TelemetrySimulator(sm, 100);

  sim.setScenario('NORMAL');

  let state = sm.getFullState();
  let hn3 = state.network.links.find(l => l.id === 'link_helmet_node03');
  assert.ok(hn3.distance > 0, `IDLE distances follow the live (sim/firmware) distance (got ${hn3.distance})`);
  assert.strictEqual(hn3.distance, 13, 'Live distance (18) takes priority over model estimate, minus the helmet display offset (−5)');
  const trunkLink = state.network.links.find(l => l.id === 'link_node02_node01');
  assert.strictEqual(trunkLink.distance, 52, 'Trunk distance must pass through untouched (sim raw value, no model)');
  assert.strictEqual(state.calibration.status, 'IDLE');
  assert.ok(state.spatial_position.dist_n3 > 0, 'Spatial dist_n3 must follow display distance');
  console.log(`  ✓ IDLE mode: helmet→N3 shows ${hn3.distance} m (live), spatial ${state.spatial_position.dist_n3} m, trunk null`);

  const eng = sm.calibrationEngine;
  const started = eng.start(sm);
  assert.ok(started.started && started.phases === 3, `Calibration must queue 3 sim phases (got ${started.phases})`);

  let guard = 0;
  while (eng.status === 'RUNNING' && guard < 20) {
    if (eng.phases[eng.activePhaseIdx]) eng.phases[eng.activePhaseIdx].startedAt = Date.now() - 6000;
    sim.tick();
    guard++;
  }
  assert.strictEqual(eng.status, 'LOCKED', `Calibration must complete (guard ${guard})`);

  state = sm.getFullState();
  assert.strictEqual(state.calibration.status, 'LOCKED');
  assert.strictEqual(state.calibration.progress, null);
  const lockedD = eng.locked['link_helmet_node03'].distance;
  hn3 = state.network.links.find(l => l.id === 'link_helmet_node03');
  assert.strictEqual(hn3.distance, lockedD, 'State link distance must equal locked value');

  sim.tick();
  sim.tick();
  assert.strictEqual(sm.getFullState().network.links.find(l => l.id === 'link_helmet_node03').distance, lockedD, 'Distance must stay frozen across ticks');
  console.log(`  ✓ LOCKED mode: helmet→N3 frozen at ${lockedD} m across ticks`);

  const rm = sm.getFullState().route_map;
  assert.ok(rm.tracking, 'Trajectory must keep tracking while distances are locked');
  const anchorN3 = rm.anchors.find(a => a.id === 'NODE03');
  assert.strictEqual(anchorN3.distance, lockedD, 'Route map beacon label must show locked range');
  console.log('  ✓ Route map: beacon label locked, trajectory still raw-fed');

  sim.setScenario('MINER_WALK_OUT');
  for (let i = 0; i < 60; i++) sim.tick();
  const rmWalk = sm.getFullState().route_map;
  assert.ok(rmWalk.path.length >= 3, `Trajectory must keep growing while locked (got ${rmWalk.path.length} waypoints)`);
  assert.ok(rmWalk.distance_from_surface_m < sim.geo.totalLength - 4, `Miner must keep moving (dist ${rmWalk.distance_from_surface_m})`);
  assert.strictEqual(sm.getFullState().network.links.find(l => l.id === 'link_helmet_node03').distance, lockedD, 'Display stays frozen while miner walks');
  console.log(`  ✓ FOLLOW-MINER unaffected: ${rmWalk.path.length} waypoints, ${rmWalk.distance_from_surface_m} m from surface while distances locked`);

  sim.setScenario('RESET');
  sim.tick();
  state = sm.getFullState();
  assert.strictEqual(state.calibration.status, 'IDLE', 'RESET must unlock calibration');
  assert.strictEqual(Object.keys(state.calibration.locked).length, 0, 'Lock map must be empty after unlock');
  const liveDist = state.network.links.find(l => l.id === 'link_helmet_node03').distance;
  assert.ok(liveDist > 0, `Distances revert to live distance after unlock (got ${liveDist})`);
  console.log('  ✓ RESET: calibration unlocked, live distances restored');

  sm.destroy();
}

console.log('\n=========================================================');
console.log(' ALL PHASE 6 TESTS COMPLETED SUCCESSFULLY: 100% PASS');
console.log('=========================================================');
