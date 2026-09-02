import { WebSocket } from 'ws';
import assert from 'assert';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 1 End-to-End WebSocket & REST Test');
console.log('------------------------------------------------------------');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  // 1. Test Static HTML Delivery
  const htmlRes = await fetch('http://localhost:3000/dashboard');
  assert.strictEqual(htmlRes.status, 200, 'Dashboard HTML must be served with 200 OK');
  const htmlText = await htmlRes.text();
  assert.ok(htmlText.includes('MUKUT'), 'HTML must include MUKUT branding');
  assert.ok(htmlText.includes('WORKER SAFETY STATUS'), 'HTML must include Worker Safety Status');
  assert.ok(htmlText.includes('ATMOSPHERIC GAS MONITORING'), 'HTML must include Gas Monitoring');
  console.log('✓ 1. Dashboard HTML route /dashboard serves valid Phase 1 structure');

  // 2. Test REST API State
  const stateRes = await fetch('http://localhost:3000/api/state');
  assert.strictEqual(stateRes.status, 200);
  const stateJson = await stateRes.json();
  assert.ok(stateJson.helmet_id === 'HELMET01');
  console.log('✓ 2. GET /api/state returns current system state');

  // 3. Test WebSocket Connection
  const ws = new WebSocket('ws://localhost:3000');
  const receivedMessages = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    receivedMessages.push(msg);
  });

  await new Promise((resolve) => ws.on('open', resolve));
  console.log('✓ 3. WebSocket client connected successfully to live server');

  await sleep(1000);
  assert.ok(receivedMessages.length > 0, 'Must receive initial state over WebSocket');
  console.log(`✓ 4. Received ${receivedMessages.length} initial message(s) from WebSocket`);

  // 4. Test Scenario: GAS_WARNING
  console.log('\nTesting Scenario: GAS_WARNING...');
  const warnRes = await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'GAS_WARNING' })
  });
  assert.strictEqual(warnRes.status, 200);
  await sleep(500);

  const warnStateRes = await fetch('http://localhost:3000/api/state');
  const warnState = await warnStateRes.json();
  assert.strictEqual(warnState.status, 'WARNING');
  assert.strictEqual(warnState.gas_status.overall, 'WARNING');
  console.log(`✓ 5. Triggered GAS_WARNING -> State is ${warnState.status}, Gas is ${warnState.gas_status.overall}`);

  // 5. Test Scenario: GAS_CRITICAL
  console.log('\nTesting Scenario: GAS_CRITICAL...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'GAS_CRITICAL' })
  });
  await sleep(500);

  const critState = await (await fetch('http://localhost:3000/api/state')).json();
  assert.strictEqual(critState.status, 'EMERGENCY');
  assert.strictEqual(critState.gas_status.overall, 'CRITICAL');
  console.log(`✓ 6. Triggered GAS_CRITICAL -> State is ${critState.status}, Gas is ${critState.gas_status.overall}`);

  // 6. Test Scenario: SOS
  console.log('\nTesting Scenario: SOS EMERGENCY...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'SOS' })
  });
  await sleep(500);

  const sosState = await (await fetch('http://localhost:3000/api/state')).json();
  assert.strictEqual(sosState.status, 'EMERGENCY');
  assert.strictEqual(sosState.sos, true);
  console.log(`✓ 7. Triggered SOS -> State is ${sosState.status}, SOS is ${sosState.sos}`);

  // 7. Test Scenario: RESET
  console.log('\nTesting Scenario: RESET...');
  await fetch('http://localhost:3000/api/simulator/scenario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'RESET' })
  });
  await sleep(500);

  const resetState = await (await fetch('http://localhost:3000/api/state')).json();
  assert.strictEqual(resetState.status, 'SAFE');
  assert.strictEqual(resetState.sos, false);
  assert.strictEqual(resetState.gas_status.overall, 'NORMAL');
  console.log(`✓ 8. Triggered RESET -> State returned to ${resetState.status}, Gas is ${resetState.gas_status.overall}`);

  // 8. Test Direct Ingestion API
  console.log('\nTesting Direct Telemetry Ingestion (Hardware Contract)...');
  const customTelemetry = {
    version: "1.0",
    helmet_id: "HELMET01",
    timestamp: Math.floor(Date.now() / 1000),
    environment: {
      temperature: 31.0,
      humidity: 67.0,
      methane: 0.18,
      carbon_monoxide: 12.0,
      smoke: 42.0
    },
    safety: { sos: false }
  };
  const ingestRes = await fetch('http://localhost:3000/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(customTelemetry)
  });
  assert.strictEqual(ingestRes.status, 200);
  const ingestJson = await ingestRes.json();
  assert.strictEqual(ingestJson.success, true);
  console.log('✓ 9. POST /api/telemetry ingested valid hardware packet successfully');

  ws.close();
  console.log('\n============================================================');
  console.log(' END-TO-END LIVE REST & WEBSOCKET VERIFICATION PASSED (100%)');
  console.log('============================================================\n');
}

runTest().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
