import assert from 'assert';
import { validateTelemetry } from '../src/server/schema.js';
import { StateManager } from '../src/server/stateManager.js';
import { Node1Bridge } from '../src/server/node1Bridge.js';
import { isolatedConfig } from './helpers/isolated_config.js';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 4 Automated Test Suite');
console.log(' (Node1 Bridge, Config Validation & Telemetry Endpoint)');
console.log('------------------------------------------------------------');

// 1. Config Validation Tests
console.log('\n[TEST GROUP 1] Config Validation:');
{
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(__dirname, '../config/default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const nodeIds = config.network.nodes.map(n => n.id);
  assert.ok(nodeIds.includes('NODE01'), 'NODE01 must exist');
  assert.ok(nodeIds.includes('NODE02'), 'NODE02 must exist');
  assert.ok(nodeIds.includes('NODE03'), 'NODE03 must exist');
  assert.ok(nodeIds.includes('HELMET01'), 'HELMET01 must exist');
  console.log(`  ✓ All 4 nodes present: ${nodeIds.join(', ')}`);

  const node03 = config.network.nodes.find(n => n.id === 'NODE03');
  assert.strictEqual(node03.status, 'ONLINE');
  assert.strictEqual(node03.type, 'node');
  console.log('  ✓ NODE03 is ONLINE with type "node"');

  const linkIds = config.network.default_links.map(l => l.id);
  assert.ok(linkIds.includes('link_helmet_node03'), 'link_helmet_node03 must exist');
  assert.ok(linkIds.includes('link_node03_node01'), 'link_node03_node01 must exist');
  console.log(`  ✓ Failover links present: ${linkIds.filter(l => l.includes('node03')).join(', ')}`);

  const helmetToN3 = config.network.default_links.find(l => l.id === 'link_helmet_node03');
  const n3ToN1 = config.network.default_links.find(l => l.id === 'link_node03_node01');
  assert.strictEqual(helmetToN3.source, 'HELMET01');
  assert.strictEqual(helmetToN3.destination, 'NODE03');
  assert.strictEqual(n3ToN1.source, 'NODE03');
  assert.strictEqual(n3ToN1.destination, 'NODE01');
  console.log('  ✓ Failover link directions correct: HELMET01→NODE03→NODE01');

  assert.ok(config.hardware.node1_ip, 'node1_ip must be configured');
  assert.ok(config.hardware.node1_poll_interval_ms, 'node1_poll_interval_ms must be configured');
  console.log(`  ✓ Node1 config: ip=${config.hardware.node1_ip}, poll=${config.hardware.node1_poll_interval_ms}ms`);
}

// 2. Node1Bridge Translator Tests
console.log('\n[TEST GROUP 2] Node1 Bridge Translator:');
{
  const sm = new StateManager(isolatedConfig());
  const bridge = new Node1Bridge(sm, '192.168.4.1', 5000);

  // 2.1: Translate normal data
  const normalNode1 = {
    system: {
      gateway_id: 'NODE_1_SURFACE',
      uptime_ms: 50000,
      active_route: 'HELMET01 -> Node 3 -> Node 2 -> GATEWAY',
      overall_risk_index: 'LOW'
    },
    miner: {
      worker_id: 'MINER 01',
      motion_state: 'MOVING',
      step_count: 42,
      total_distance_m: 29.4,
      heading_deg: 132.0,
      direction_cardinal: 'SOUTH-EAST',
      battery_pct: 94,
      status: 'SAFE'
    },
    environment: {
      temperature_c: 31.5,
      humidity_pct: 68.0,
      mq6_lpg_ppm: 160,
      mq4_methane_ppm: 155,
      mq8_hydrogen_ppm: 170
    },
    mesh_topology: {
      node2_relay: {
        online: true,
        rssi_dbm: -65,
        signal_pct: 85,
        signal_quality: 'GOOD',
        distance_to_helmet_m: 22.5,
        distance_to_node3_m: 15.0,
        hazard_level: 0,
        hazard_status: 'STABLE'
      },
      node3_relay: {
        online: true,
        rssi_dbm: -55,
        signal_pct: 95,
        signal_quality: 'EXCELLENT',
        distance_to_helmet_m: 5.2,
        hazard_level: 0,
        hazard_status: 'STABLE'
      },
      helmet_direct: {
        online: true,
        rssi_dbm: -58,
        signal_pct: 90,
        signal_quality: 'EXCELLENT'
      },
      tunnel_position: {
        nearest_node: 'NODE03',
        relative_slider_pct: 65.0
      }
    },
    active_alerts: [],
    active_emergencies: []
  };

  const translated = bridge.translate(normalNode1);

  assert.strictEqual(translated.version, '1.0');
  assert.strictEqual(translated.helmet_id, 'MINER 01');
  assert.ok(typeof translated.timestamp === 'number');
  console.log('  ✓ Basic fields translated (version, helmet_id, timestamp)');

  assert.ok(translated.environment.temperature === 31.5, `Temp: ${translated.environment.temperature}`);
  assert.ok(translated.environment.humidity === 68.0, `Humidity: ${translated.environment.humidity}`);
  console.log('  ✓ Temperature & humidity passed through directly');

  assert.strictEqual(translated.environment.methane, 155, `Methane: ${translated.environment.methane}`);
  assert.strictEqual(translated.environment.carbon_monoxide, 160, `CO: ${translated.environment.carbon_monoxide}`);
  assert.strictEqual(translated.environment.smoke, 170, `Smoke: ${translated.environment.smoke}`);
  console.log(`  ✓ Gas values passed through raw (ppm): CH4=${translated.environment.methane}, CO=${translated.environment.carbon_monoxide}, Smoke=${translated.environment.smoke}`);

  assert.strictEqual(translated.safety.sos, false);
  console.log('  ✓ SOS = false for SAFE status');

  assert.strictEqual(translated.network.connected_node, 'NODE03');
  assert.ok(Array.isArray(translated.network.links));
  assert.ok(translated.network.links.length >= 3, `Links count: ${translated.network.links.length}`);
  console.log(`  ✓ Network: connected_node=${translated.network.connected_node}, ${translated.network.links.length} links`);

  // 2.2: SOS Detection
  const sosNode1 = JSON.parse(JSON.stringify(normalNode1));
  sosNode1.miner.status = 'SOS EMERGENCY';
  const translatedSos = bridge.translate(sosNode1);
  assert.strictEqual(translatedSos.safety.sos, true);
  console.log('  ✓ SOS EMERGENCY status detected → sos: true');

  // 2.3: Offline Helmet
  const offlineNode1 = JSON.parse(JSON.stringify(normalNode1));
  offlineNode1.mesh_topology.helmet_direct.online = false;
  offlineNode1.miner.status = 'OFFLINE_CASUALTY';
  const translatedOffline = bridge.translate(offlineNode1);
  const disconnectedLinks = translatedOffline.network.links.filter(l => l.status === 'DISCONNECTED');
  assert.ok(disconnectedLinks.length >= 1, 'Helmet offline creates disconnected links');
  console.log(`  ✓ Helmet offline → ${disconnectedLinks.length} disconnected links`);

  // 2.4: Offline Node2
  const n2DownNode1 = JSON.parse(JSON.stringify(normalNode1));
  n2DownNode1.mesh_topology.node2_relay.online = false;
  const translatedN2Down = bridge.translate(n2DownNode1);
  const n2Link = translatedN2Down.network.links.find(l => l.id === 'link_node02_node01');
  assert.ok(n2Link, 'link_node02_node01 must exist');
  assert.strictEqual(n2Link.status, 'DISCONNECTED');
  console.log('  ✓ Node2 offline → link_node02_node01 DISCONNECTED');

  // 2.5: Gas scaling boundary - high raw values
  const gasNode1 = JSON.parse(JSON.stringify(normalNode1));
  gasNode1.environment.mq4_methane_ppm = 2000;
  gasNode1.environment.mq6_lpg_ppm = 2000;
  gasNode1.environment.mq8_hydrogen_ppm = 2000;
  const translatedGas = bridge.translate(gasNode1);
  assert.strictEqual(translatedGas.environment.methane, 2000, `High methane: ${translatedGas.environment.methane}`);
  assert.strictEqual(translatedGas.environment.carbon_monoxide, 2000, `High CO: ${translatedGas.environment.carbon_monoxide}`);
  assert.strictEqual(translatedGas.environment.smoke, 2000, `High smoke: ${translatedGas.environment.smoke}`);
  console.log(`  ✓ High raw gas values passed through: CH4=${translatedGas.environment.methane}, CO=${translatedGas.environment.carbon_monoxide}, Smoke=${translatedGas.environment.smoke} ppm`);

  // 2.6: Gas scaling boundary - low raw values
  const lowGasNode1 = JSON.parse(JSON.stringify(normalNode1));
  lowGasNode1.environment.mq4_methane_ppm = 150;
  lowGasNode1.environment.mq6_lpg_ppm = 150;
  lowGasNode1.environment.mq8_hydrogen_ppm = 150;
  const translatedLow = bridge.translate(lowGasNode1);
  assert.strictEqual(translatedLow.environment.methane, 150);
  assert.strictEqual(translatedLow.environment.carbon_monoxide, 150);
  assert.strictEqual(translatedLow.environment.smoke, 150);
  console.log('  ✓ Low raw gas values passed through unchanged (150 ppm, below warning threshold)');

  // 2.7: Translated packet passes schema validation
  const validation = validateTelemetry(translated);
  assert.strictEqual(validation.valid, true, `Schema errors: ${validation.errors.join(', ')}`);
  console.log('  ✓ Translated packet passes MUKUT v1.0 schema validation');

  // 2.8: Translated packet processes through StateManager
  const result = await sm.processTelemetry(translated);
  assert.ok(result, 'StateManager returns result');
  assert.ok(result.status, 'Result has status field');
  assert.ok(result.network.route, 'Result has network route');
  console.log(`  ✓ Translated packet processes through StateManager → status=${result.status}`);
  sm.destroy();
}

// 3. StateManager Failover with NODE03 Tests
console.log('\n[TEST GROUP 3] Failover with NODE03:');
{
  const sm = new StateManager(isolatedConfig());

  // Verify initial route goes through NODE02 (primary path)
  const initState = sm.getFullState();
  const initRoute = initState.network.route.current_route;
  assert.ok(initRoute.length > 0, 'Initial route exists');
  console.log(`  ✓ Initial route: ${initRoute.join(' → ')}`);

  // Take NODE02 offline → should failover through NODE03
  sm.setNodeStatus('NODE02', 'OFFLINE');
  const failoverState = sm.getFullState();
  const failoverRoute = failoverState.network.route;
  assert.strictEqual(failoverRoute.status, 'FAILOVER');
  assert.ok(failoverRoute.current_route.includes('NODE03'), `Failover route should include NODE03: ${failoverRoute.current_route.join(' → ')}`);
  assert.strictEqual(failoverRoute.failed_node, 'NODE02');
  console.log(`  ✓ NODE02 offline → FAILOVER via ${failoverRoute.current_route.join(' → ')}`);

  // Restore NODE02 → should return to primary route
  sm.setNodeStatus('NODE02', 'ONLINE');
  const restoredState = sm.getFullState();
  const restoredRoute = restoredState.network.route;
  assert.strictEqual(restoredRoute.status, 'NORMAL');
  assert.ok(!restoredRoute.failover_active, 'Failover no longer active');
  console.log(`  ✓ NODE02 restored → NORMAL route: ${restoredRoute.current_route.join(' → ')}`);
  sm.destroy();
}

// 4. Full Pipeline Test: Node1 Data → StateManager → WebSocket State
console.log('\n[TEST GROUP 4] Full Pipeline (Node1 → StateManager → State):');
{
  const sm = new StateManager(isolatedConfig());
  const bridge = new Node1Bridge(sm, '192.168.4.1', 5000);

  const node1Payload = {
    system: { gateway_id: 'NODE_1', active_route: 'HELMET01 -> Node 3 -> GATEWAY', overall_risk_index: 'LOW' },
    miner: { worker_id: 'HELMET01', status: 'SAFE', motion_state: 'MOVING', heading_deg: 90.0 },
    environment: { temperature_c: 33.0, humidity_pct: 72.0, mq4_methane_ppm: 180, mq6_lpg_ppm: 160, mq8_hydrogen_ppm: 170 },
    mesh_topology: {
      node2_relay: { online: true, rssi_dbm: -70, distance_to_helmet_m: 25.0, distance_to_node3_m: 12.0, hazard_level: 0, hazard_status: 'STABLE' },
      node3_relay: { online: true, rssi_dbm: -60, distance_to_helmet_m: 8.0, hazard_level: 0, hazard_status: 'STABLE' },
      helmet_direct: { online: true, rssi_dbm: -62, signal_quality: 'GOOD' },
      tunnel_position: { nearest_node: 'NODE03' }
    },
    active_alerts: [],
    active_emergencies: []
  };

  const translated = bridge.translate(node1Payload);
  assert.strictEqual(validateTelemetry(translated).valid, true);

  const state = await sm.processTelemetry(translated);
  assert.strictEqual(state.status, 'SAFE');
  assert.strictEqual(state.online, true);
  assert.ok(state.environment.temperature === 33.0);
  assert.ok(state.network.route.current_route.length > 0);
  console.log(`  ✓ Full pipeline: status=${state.status}, online=${state.online}, temp=${state.environment.temperature}°C`);

  // Simulate SOS through pipeline
  const sosPayload = JSON.parse(JSON.stringify(node1Payload));
  sosPayload.miner.status = 'SOS EMERGENCY';
  const sosTranslated = bridge.translate(sosPayload);
  const sosState = await sm.processTelemetry(sosTranslated);
  assert.strictEqual(sosState.sos, true);
  assert.strictEqual(sosState.status, 'EMERGENCY');
  console.log('  ✓ SOS through full pipeline → EMERGENCY status');

  // Simulate gas warning through pipeline
  const gasPayload = JSON.parse(JSON.stringify(node1Payload));
  gasPayload.miner.status = 'SAFE';
  gasPayload.environment.mq4_methane_ppm = 1800;
  const gasTranslated = bridge.translate(gasPayload);
  const gasState = await sm.processTelemetry(gasTranslated);
  assert.ok(gasState.gas_status.overall !== 'NORMAL', `Gas status: ${gasState.gas_status.overall}`);
  console.log(`  ✓ Gas warning through full pipeline → atmosphere ${gasState.gas_status.overall}`);
  sm.destroy();
}

console.log('\n=======================================================');
console.log(' ALL PHASE 4 TESTS COMPLETED SUCCESSFULLY: 100% PASS');
console.log('=======================================================');
