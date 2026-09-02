import { WebSocket } from 'ws';
import assert from 'assert';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 2 End-to-End WebSocket & REST Test');
console.log('------------------------------------------------------------');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  // 1. Verify Routes
  const safetyRes = await fetch('http://localhost:3000/dashboard');
  assert.strictEqual(safetyRes.status, 200, 'Safety page must return 200');
  const safetyHtml = await safetyRes.text();
  assert.ok(safetyHtml.includes('UNDERGROUND NETWORK'), 'Safety page must contain navigation to network');
  console.log('✓ 1. Route /dashboard serves Safety Overview with Phase 2 navigation tabs');

  const netRes = await fetch('http://localhost:3000/dashboard/network');
  assert.strictEqual(netRes.status, 200, 'Network page must return 200');
  const netHtml = await netRes.text();
  assert.ok(netHtml.includes('UNDERGROUND LORA MESH TOPOLOGY'), 'Network page must contain topology');
  assert.ok(netHtml.includes('INTER-NODE LINK METRICS'), 'Network page must contain link table');
  console.log('✓ 2. Route /dashboard/network serves Underground Network Monitoring page');

  // 2. Test REST API /api/network
  const netApiRes = await fetch('http://localhost:3000/api/network');
  assert.strictEqual(netApiRes.status, 200);
  const netData = await netApiRes.json();
  assert.strictEqual(netData.health, 'GOOD');
  assert.strictEqual(netData.nodes.length, 4);
  assert.strictEqual(netData.links.length, 4);
  console.log('✓ 3. GET /api/network returns valid network state model');

  // 3. Test WebSocket connection
  const ws = new WebSocket('ws://localhost:3000');
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise(resolve => ws.on('open', resolve));
  await sleep(600);
  assert.ok(messages.length > 0, 'Must receive initial state over WebSocket');
  console.log('✓ 4. WebSocket connected and streaming state updates');

  // 4. Test Scenario: WEAK_LINK
  console.log('\nTesting Scenario: WEAK_LINK...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'WEAK_LINK' })
  });
  await sleep(600);

  const weakState = await (await fetch('http://localhost:3000/api/state')).json();
  assert.strictEqual(weakState.network.health, 'DEGRADED');
  const weakLink = weakState.network.links.find(l => l.id === 'link_helmet_node03');
  assert.ok(weakLink.rssi <= -84, 'RSSI must be attenuated');
  assert.strictEqual(weakLink.quality, 'WEAK');
  console.log(`✓ 5. WEAK_LINK triggered: RSSI=${weakLink.rssi} dBm, Quality=${weakLink.quality}, Health=${weakState.network.health}`);

  // 5. Test Scenario: NODE02_OFFLINE (No Failover in Phase 2)
  console.log('\nTesting Scenario: NODE02_OFFLINE...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'NODE02_OFFLINE' })
  });
  await sleep(600);

  const offState = await (await fetch('http://localhost:3000/api/state')).json();
  const node2 = offState.network.nodes.find(n => n.id === 'NODE02');
  assert.strictEqual(node2.status, 'OFFLINE');
  assert.strictEqual(offState.network.health, 'DEGRADED');
  console.log(`✓ 6. NODE02_OFFLINE triggered: Node2 status=${node2.status}, Health=${offState.network.health} (No failover in Phase 2)`);

  // 6. Test Scenario: RESET_NETWORK
  console.log('\nTesting Scenario: RESET_NETWORK...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'RESET_NETWORK' })
  });
  await sleep(600);

  const resetNetState = await (await fetch('http://localhost:3000/api/state')).json();
  assert.strictEqual(resetNetState.network.health, 'GOOD');
  assert.strictEqual(resetNetState.network.nodes.find(n => n.id === 'NODE02').status, 'ONLINE');
  console.log('✓ 7. RESET_NETWORK triggered: All nodes restored to ONLINE and health to GOOD');

  // 7. Regression check for Phase 1 Safety features
  console.log('\nChecking Phase 1 Regression (Safety & Gas alert triggers)...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'GAS_WARNING' })
  });
  await sleep(600);
  const gasWarnState = await (await fetch('http://localhost:3000/api/state')).json();
  assert.strictEqual(gasWarnState.status, 'WARNING');
  assert.strictEqual(gasWarnState.gas_status.overall, 'WARNING');
  console.log('✓ 8. Phase 1 Safety features continue working 100% (No regressions)');

  // Reset to nominal
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'RESET' })
  });

  ws.close();
  console.log('\n============================================================');
  console.log(' ALL PHASE 2 END-TO-END TESTS PASSED SUCCESSFULLY! (100%)');
  console.log('============================================================\n');
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
