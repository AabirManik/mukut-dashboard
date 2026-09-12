import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateTelemetry } from '../src/server/schema.js';
import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';
import { TrajectoryEngine, computeTunnelGeometry } from '../src/server/trajectoryEngine.js';
import { Node1Bridge } from '../src/server/node1Bridge.js';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 5 Automated Test Suite');
console.log(' (Route Mapping: Trajectory Engine, Journey, State)');
console.log('------------------------------------------------------------');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../config/default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// 1. Config & Tunnel Geometry Tests
console.log('\n[TEST GROUP 1] Config & Tunnel Geometry:');
{
  const geo = computeTunnelGeometry(config);

  assert.ok(geo.anchors.length >= 3, 'All 3 relay nodes must have map_pos');
  console.log(`  ✓ Anchor nodes mapped: ${geo.anchors.map(a => `${a.id}(${a.x},${a.y})`).join(', ')}`);

  const n1 = geo.anchors.find(a => a.id === 'NODE01');
  const n2 = geo.anchors.find(a => a.id === 'NODE02');
  const n3 = geo.anchors.find(a => a.id === 'NODE03');

  const d12 = Math.hypot(n2.x - n1.x, n2.y - n1.y);
  const d23 = Math.hypot(n3.x - n2.x, n3.y - n2.y);
  const d13 = Math.hypot(n3.x - n1.x, n3.y - n1.y);
  assert.ok(Math.abs(d12 - 52) < 0.5, `N1-N2 distance should match trunk (got ${d12.toFixed(1)})`);
  assert.ok(Math.abs(d23 - 35) < 0.5, `N2-N3 distance should match relay trunk (got ${d23.toFixed(1)})`);
  assert.ok(Math.abs(d13 - 64) < 0.5, `N1-N3 distance should match bypass link (got ${d13.toFixed(1)})`);
  console.log(`  ✓ Geometry consistent with link distances: ${d12.toFixed(1)} / ${d23.toFixed(1)} / ${d13.toFixed(1)} m`);

  assert.ok(geo.polyline.length === 4, 'Polyline must include working face extension');
  const face = geo.polyline[3];
  const faceDist = Math.hypot(face.x - n3.x, face.y - n3.y);
  assert.ok(Math.abs(faceDist - 18) < 0.5, `Working face must be 18 m past NODE03 (got ${faceDist.toFixed(1)})`);
  console.log(`  ✓ Tunnel polyline: 4 points, total ${geo.totalLength.toFixed(1)} m, face 18 m past N3`);

  assert.ok(config.trajectory && config.trajectory.correction_strength > 0, 'Trajectory config block present');
  console.log('  ✓ Trajectory config block present (correction, corridor, cadence)');
}

// 2. TrajectoryEngine Unit Tests
console.log('\n[TEST GROUP 2] Trajectory Engine:');
{
  // 2.1: Anchor-only first fix (trilateration)
  {
    const eng = new TrajectoryEngine(config);
    const target = { x: 20, y: 5 };
    const anchors = [
      { id: 'NODE01', distance: Math.hypot(target.x, target.y) },
      { id: 'NODE02', distance: Math.hypot(target.x - 52, target.y) },
      { id: 'NODE03', distance: Math.hypot(target.x - 53.61, target.y - 34.96) }
    ];
    eng.update({ motion: { moving: false, distance_walked_m: 0 }, orientation: { heading: 0 }, anchors }, null);
    const st = eng.getState();
    assert.ok(st.tracking, 'Engine must track after first fix');
    assert.ok(Math.hypot(st.position.x - target.x, st.position.y - target.y) < 0.7, `First fix near target (got ${st.position.x},${st.position.y})`);
    console.log(`  ✓ Anchor trilateration first fix: (${st.position.x}, ${st.position.y}) ≈ (20, 5)`);
  }

  // 2.2: Pure dead reckoning along heading 0
  {
    const eng = new TrajectoryEngine(config);
    for (let i = 0; i <= 9; i++) {
      eng.update({ motion: { moving: i > 0, distance_walked_m: i * 2.4 }, orientation: { heading: 0 } }, null);
    }
    const st = eng.getState();
    assert.ok(Math.abs(st.position.x - 21.6) < 0.5, `DR x should be ~21.6 (got ${st.position.x})`);
    assert.ok(Math.abs(st.position.y) < 0.5, `DR y should stay ~0 (got ${st.position.y})`);
    assert.ok(st.waypoint_count >= 9 && st.waypoint_count <= 11, `Waypoint cadence ~10 (got ${st.waypoint_count})`);
    assert.ok(Math.abs(st.distance_walked_m - 21.6) < 0.5, `Walked distance tracked (got ${st.distance_walked_m})`);
    console.log(`  ✓ Dead reckoning: 21.6 m along +x, ${st.waypoint_count} waypoints`);
  }

  // 2.3: Anchor correction pulls a drifted position back
  {
    const eng = new TrajectoryEngine(config);
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
        { id: 'NODE03', distance: Math.hypot(10 - 53.61, 34.96) }
      ]
    }, null);
    const correctedX = eng.getState().position.x;
    assert.ok(correctedX < driftX, `Correction must pull toward anchor (was ${driftX}, now ${correctedX})`);
    assert.ok(correctedX > 12 && correctedX < 21, `Blended, not snapped (got ${correctedX.toFixed(2)})`);
    console.log(`  ✓ Anchor correction blend: ${driftX.toFixed(1)} → ${correctedX.toFixed(1)} (anchor at 10)`);
  }

  // 2.4: Large offset triggers resync + event
  {
    const eng = new TrajectoryEngine(config);
    const events = [];
    const stub = { addEvent: (sev, msg) => events.push(msg) };
    for (let i = 0; i <= 10; i++) {
      eng.update({ motion: { moving: i > 0, distance_walked_m: i * 4 }, orientation: { heading: 0 } }, null);
    }
    eng.update({
      motion: { moving: false, distance_walked_m: 40 },
      orientation: { heading: 0 },
      anchors: [
        { id: 'NODE01', distance: 5 },
        { id: 'NODE02', distance: 47 },
        { id: 'NODE03', distance: Math.hypot(5 - 53.61, 34.96) }
      ]
    }, stub);
    const x = eng.getState().position.x;
    assert.ok(x > 15 && x < 30, `Resync half-step toward anchor (got ${x.toFixed(1)})`);
    assert.ok(events.some(m => m.includes('resynchronized')), 'Resync event must fire');
    console.log(`  ✓ Resync beyond 25 m: x=${x.toFixed(1)} + event logged`);
  }

  // 2.5: Corridor clamp limits off-tunnel drift
  {
    const eng = new TrajectoryEngine(config);
    for (let i = 0; i <= 10; i++) {
      eng.update({ motion: { moving: i > 0, distance_walked_m: i * 2 }, orientation: { heading: 90 } }, null);
    }
    const st = eng.getState();
    assert.ok(Math.abs(st.position.y - 8) < 0.6, `Lateral drift clamped to corridor (got y=${st.position.y})`);
    assert.ok(Math.abs(st.position.x) < 0.6, 'Along-tunnel axis preserved');
    console.log(`  ✓ Corridor clamp: 20 m lateral walk clamped to y=${st.position.y}`);
  }

  // 2.6: Reset clears the trajectory
  {
    const eng = new TrajectoryEngine(config);
    eng.update({ motion: { moving: false, distance_walked_m: 0 }, orientation: { heading: 0 } }, null);
    eng.reset();
    const st = eng.getState();
    assert.strictEqual(st.tracking, false);
    assert.strictEqual(st.path.length, 0);
    console.log('  ✓ Reset clears position and path');
  }
}

// 3. Simulator Journey Tests
console.log('\n[TEST GROUP 3] Simulator Journey:');
{
  const sm = new StateManager();
  const sim = new TelemetrySimulator(sm, 100);

  assert.ok(sim.geoValid, 'Simulator must load map geometry from config');
  assert.strictEqual(sim.journeyMode, 'STATIONARY');
  assert.ok(Math.abs(sim.minerArc - sim.geo.totalLength) < 0.1, 'Baseline position is the working face');
  console.log(`  ✓ Journey baseline: working face at arc ${sim.minerArc.toFixed(1)} m`);

  // 3.1: Journey stepping math
  sim.journeyMode = 'OUT';
  sim.stepJourney(30);
  const arcAfter = sim.minerArc;
  const walkedAfter = sim.distanceWalkedTotal;
  assert.ok(arcAfter > 50 && arcAfter < 70, `30 s walk should cover 38-52 m (arc now ${arcAfter.toFixed(1)})`);
  assert.ok(Math.abs(walkedAfter - (sim.geo.totalLength - arcAfter)) < 0.1, 'Walked distance matches arc delta');
  console.log(`  ✓ Walk-out stepping: arc ${sim.geo.totalLength.toFixed(1)} → ${arcAfter.toFixed(1)} m`);

  sim.stepJourney(300);
  assert.ok(sim.minerArc <= 0.05, 'Walk-out must terminate at the surface');
  assert.strictEqual(sim.journeyMode, 'STATIONARY');
  console.log(`  ✓ Journey terminates at surface (walked ${sim.distanceWalkedTotal.toFixed(1)} m total)`);

  // 3.2: State integration through full pipeline
  sim.setScenario('RESET');
  sim.setScenario('MINER_WALK_OUT');
  for (let i = 0; i < 80; i++) sim.tick();

  let state = sm.getFullState();
  const rm = state.route_map;
  assert.ok(rm && rm.tracking, 'route_map must be present and tracking');
  assert.ok(rm.path.length >= 3, `Path must grow while walking (got ${rm.path.length} waypoints)`);
  assert.ok(rm.moving, 'moving flag set during walk');
  assert.ok(rm.distance_from_surface_m < sim.geo.totalLength - 8, `Distance from surface decreases (got ${rm.distance_from_surface_m})`);
  assert.ok(rm.distance_walked_m > 8, `Walked distance accumulates (got ${rm.distance_walked_m})`);
  console.log(`  ✓ Full pipeline: ${rm.path.length} waypoints, ${rm.distance_from_surface_m} m from surface, ${rm.distance_walked_m} m walked`);

  // 3.3: Packet anchors consistent with geometry
  const packet = sim.generatePacket();
  assert.strictEqual(validateTelemetry(packet).valid, true, 'Journey packet must pass v1.0 schema');
  const pos = sim.polylinePos(sim.minerArc);
  const n3 = config.network.nodes.find(n => n.id === 'NODE03').map_pos;
  const expectedD3 = Math.hypot(pos.x - n3.x, pos.y - n3.y);
  const reportedD3 = packet.anchors.find(a => a.id === 'NODE03').distance;
  assert.ok(Math.abs(reportedD3 - expectedD3) < 1.0, `Anchor range consistent with position (${reportedD3} vs ${expectedD3.toFixed(1)})`);
  assert.ok(packet.motion && typeof packet.orientation.heading === 'number', 'motion/orientation blocks emitted');
  console.log(`  ✓ Packet anchors geometry-consistent: N3 range ${reportedD3} m, heading ${packet.orientation.heading}°`);

  // 3.4: Stationary + reset behaviour
  sim.setScenario('MINER_STATIONARY');
  sim.tick();
  state = sm.getFullState();
  assert.strictEqual(state.route_map.moving, false, 'Stationary scenario stops movement');

  sim.setScenario('RESET');
  sim.tick();
  state = sm.getFullState();
  assert.ok(state.route_map.path.length <= 1, 'Reset clears the plotted path');
  assert.ok(Math.abs(state.route_map.distance_from_surface_m - sim.geo.totalLength) < 3, 'Reset restores working-face baseline');
  console.log(`  ✓ Stationary + reset: path cleared, back at face (${state.route_map.distance_from_surface_m} m)`);

  sm.destroy();
}

// 4. State & Node1 Bridge Integration
console.log('\n[TEST GROUP 4] State & Bridge Integration:');
{
  const sm = new StateManager();
  const target = { x: 20, y: 5 };
  const packet = {
    version: '1.0',
    helmet_id: 'HELMET01',
    timestamp: Math.floor(Date.now() / 1000),
    environment: { temperature: 30.0, humidity: 65.0, methane: 0.2, carbon_monoxide: 15, smoke: 50 },
    safety: { sos: false },
    motion: { moving: true, step_count: 10, distance_walked_m: 12 },
    orientation: { heading: 90 },
    anchors: [
      { id: 'NODE01', distance: Math.hypot(target.x, target.y) },
      { id: 'NODE02', distance: Math.hypot(target.x - 52, target.y) },
      { id: 'NODE03', distance: Math.hypot(target.x - 53.61, target.y - 34.96) }
    ]
  };

  const state = await sm.processTelemetry(packet);
  assert.ok(state.route_map && state.route_map.tracking, 'getFullState must expose route_map');
  assert.ok(state.route_map.tunnel.length === 4, 'route_map carries the tunnel polyline');
  assert.ok(state.route_map.anchors.length === 3, 'route_map echoes anchor beacons');
  assert.ok(Math.hypot(state.route_map.position.x - target.x, state.route_map.position.y - target.y) < 0.7, 'Position fixed from anchors');
  console.log(`  ✓ processTelemetry → route_map: position (${state.route_map.position.x}, ${state.route_map.position.y}), ${state.route_map.anchors.length} beacons`);

  const bridge = new Node1Bridge(sm, '192.168.4.1', 5000);
  const translated = bridge.translate({
    system: { active_route: 'HELMET01 -> Node 3 -> GATEWAY', overall_risk_index: 'LOW' },
    miner: { worker_id: 'MINER 01', status: 'SAFE', motion_state: 'MOVING', step_count: 42, total_distance_m: 29.4, heading_deg: 132 },
    environment: { temperature_c: 31.5, humidity_pct: 68.0, mq4_methane_ppm: 155, mq6_lpg_ppm: 160, mq8_hydrogen_ppm: 170 },
    mesh_topology: {
      node2_relay: { online: true, rssi_dbm: -65, distance_to_helmet_m: 22.5, distance_to_node3_m: 15.0, hazard_level: 0, hazard_status: 'STABLE' },
      node3_relay: { online: true, rssi_dbm: -55, distance_to_helmet_m: 5.2, hazard_level: 0, hazard_status: 'STABLE' },
      helmet_direct: { online: true, rssi_dbm: -58 },
      tunnel_position: { nearest_node: 'NODE03', relative_slider_pct: 65.0 }
    }
  });
  assert.strictEqual(translated.motion.moving, true, 'node1 MOVING maps to motion.moving');
  assert.strictEqual(translated.orientation.heading, 132, 'node1 heading maps through');
  assert.ok(translated.anchors.length >= 2, `node1 distances map to anchor beacons (got ${translated.anchors.length})`);
  console.log(`  ✓ node1Bridge → motion/orientation/anchors (${translated.anchors.length} beacons)`);

  sm.destroy();
}

console.log('\n=========================================================');
console.log(' ALL PHASE 5 TESTS COMPLETED SUCCESSFULLY: 100% PASS');
console.log('=========================================================');
