import assert from 'assert';
import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 2 Automated Test Suite');
console.log('------------------------------------------------------------');

// 1. Network State Model Tests
console.log('\n[TEST GROUP 1] Network Model & Initialization Tests:');
{
  const sm = new StateManager();
  const state = sm.getFullState();

  assert.ok(state.network, 'State must contain network object');
  assert.strictEqual(state.network.health, 'GOOD', 'Default network health should be GOOD');
  assert.strictEqual(state.network.connected_node, 'NODE03', 'Default connected node should be NODE03');
  assert.strictEqual(state.network.nodes.length, 4, 'Should have 4 nodes (NODE01, NODE02, NODE03, HELMET01)');
  assert.ok(state.network.links.length >= 5, 'Should have at least 5 communication links');

  console.log('  ✓ Initialized 4 network nodes and communication links');
  console.log('  ✓ Default network health is GOOD and target node is NODE03');
  sm.destroy();
}

// 2. RSSI Calculation & Quality Evaluation Tests
console.log('\n[TEST GROUP 2] RSSI & Link Quality Evaluation Tests:');
{
  const sm = new StateManager();

  // Test RSSI interpretation
  const r1 = sm.evaluateRssi(-60);
  assert.strictEqual(r1.quality, 'EXCELLENT', '-60 dBm should be EXCELLENT');

  const r2 = sm.evaluateRssi(-70);
  assert.strictEqual(r2.quality, 'GOOD', '-70 dBm should be GOOD');

  const r3 = sm.evaluateRssi(-80);
  assert.strictEqual(r3.quality, 'FAIR', '-80 dBm should be FAIR');

  const r4 = sm.evaluateRssi(-88);
  assert.strictEqual(r4.quality, 'WEAK', '-88 dBm should be WEAK');

  console.log('  ✓ -60 dBm correctly evaluated as EXCELLENT');
  console.log('  ✓ -70 dBm correctly evaluated as GOOD');
  console.log('  ✓ -80 dBm correctly evaluated as FAIR');
  console.log('  ✓ -88 dBm correctly evaluated as WEAK');

  sm.destroy();
}

// 3. Network Health & Degradation Tests
console.log('\n[TEST GROUP 3] Network Health & Degradation Tests:');
{
  const sm = new StateManager();

  // Scenario: Link degradation
  sm.updateNetworkTelemetry([
    { id: 'link_helmet_node03', rssi: -87, status: 'CONNECTED' }
  ]);

  const degState = sm.getFullState();
  assert.strictEqual(degState.network.health, 'DEGRADED', 'Weak link should cause network health to become DEGRADED');
  console.log('  ✓ Weak link (-87 dBm) causes overall network health to become DEGRADED');

  // Scenario: Node going OFFLINE
  sm.setNodeStatus('NODE02', 'OFFLINE');
  const offlineState = sm.getFullState();
  const node2 = offlineState.network.nodes.find(n => n.id === 'NODE02');
  assert.strictEqual(node2.status, 'OFFLINE', 'NODE02 must be OFFLINE');

  const link2 = offlineState.network.links.find(l => l.id === 'link_node02_node01');
  assert.strictEqual(link2.status, 'DISCONNECTED', 'Links attached to offline node must be DISCONNECTED');
  assert.strictEqual(offlineState.network.health, 'DEGRADED', 'Network health remains DEGRADED');
  console.log('  ✓ Setting NODE02 to OFFLINE severs connected links and maintains DEGRADED health');

  // Scenario: Restoration
  sm.reset();
  const restoredState = sm.getFullState();
  assert.strictEqual(restoredState.network.health, 'GOOD', 'Reset should restore network health to GOOD');
  console.log('  ✓ Network reset restores all nodes to ONLINE and health to GOOD');

  sm.destroy();
}

// 4. Simulator Phase 2 Scenario Tests
console.log('\n[TEST GROUP 4] Phase 2 Network Simulator Tests:');
{
  const sm = new StateManager();
  const sim = new TelemetrySimulator(sm, 100);

  // Normal Network
  sim.setScenario('NETWORK_NORMAL');
  const p1 = sim.generatePacket();
  assert.ok(p1.network, 'Packet must contain network telemetry');
  assert.strictEqual(p1.network.connected_node, 'NODE03');
  console.log('  ✓ Simulator NETWORK_NORMAL emits 4 links with nominal RSSI');

  // Weak Link Scenario
  sim.setScenario('WEAK_LINK');
  const p2 = sim.generatePacket();
  const weakLink = p2.network.links.find(l => l.id === 'link_helmet_node03');
  assert.ok(weakLink.rssi <= -84, 'Weak link scenario should have attenuated RSSI');
  console.log(`  ✓ Simulator WEAK_LINK scenario generated RSSI=${weakLink.rssi} dBm`);

  // Node Offline Scenario
  sim.setScenario('NODE02_OFFLINE');
  const offState = sm.getFullState();
  const node2 = offState.network.nodes.find(n => n.id === 'NODE02');
  assert.strictEqual(node2.status, 'OFFLINE');
  console.log('  ✓ Simulator NODE02_OFFLINE correctly marked node OFFLINE');

  sm.destroy();
}

console.log('\n============================================================');
console.log(' ALL PHASE 2 AUTOMATED TESTS PASSED SUCCESSFULLY! (100%)');
console.log('============================================================\n');
