import assert from 'assert';
import { validateTelemetry } from '../src/server/schema.js';
import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT Phase 1 Automated Test Suite');
console.log('------------------------------------------------------------');

// 1. Telemetry Schema Validation Tests
console.log('\n[TEST GROUP 1] Schema Validator Tests:');
{
  const validPacket = {
    version: "1.0",
    helmet_id: "HELMET01",
    timestamp: 1725230000,
    environment: {
      temperature: 32.4,
      humidity: 71.2,
      methane: 0.21,
      carbon_monoxide: 18.0,
      smoke: 120.0
    },
    safety: {
      sos: false
    }
  };
  const res1 = validateTelemetry(validPacket);
  assert.strictEqual(res1.valid, true, 'Valid telemetry must pass');
  console.log('  ✓ Valid telemetry payload passes schema');

  const invalidPacket = {
    helmet_id: "HELMET01"
    // missing timestamp, environment, safety
  };
  const res2 = validateTelemetry(invalidPacket);
  assert.strictEqual(res2.valid, false, 'Incomplete payload must fail');
  assert.ok(res2.errors.length >= 3, 'Multiple errors reported');
  console.log(`  ✓ Incomplete payload caught ${res2.errors.length} validation errors`);
}

// 2. StateManager Evaluation Tests
console.log('\n[TEST GROUP 2] StateManager & Alert Logic Tests:');
{
  const sm = new StateManager();

  // Test 2.1: Nominal Telemetry
  const nominalTelemetry = {
    version: "1.0",
    helmet_id: "HELMET01",
    timestamp: Math.floor(Date.now() / 1000),
    environment: {
      temperature: 30.0,
      humidity: 65.0,
      methane: 0.20,
      carbon_monoxide: 15.0,
      smoke: 50.0
    },
    safety: { sos: false }
  };
  const stateNominal = await sm.processTelemetry(nominalTelemetry);
  assert.strictEqual(stateNominal.status, 'SAFE', 'Nominal environment should yield SAFE status');
  assert.strictEqual(stateNominal.gas_status.overall, 'NORMAL', 'Gas status should be NORMAL');
  assert.strictEqual(stateNominal.online, true, 'Helmet should be ONLINE');
  console.log('  ✓ Nominal telemetry yields SAFE status and NORMAL atmosphere');

  // Test 2.2: Gas Warning Trigger
  const gasWarningTelemetry = {
    ...nominalTelemetry,
    environment: {
      ...nominalTelemetry.environment,
      methane: 350 // > 300 warning
    }
  };
  const stateWarn = await sm.processTelemetry(gasWarningTelemetry);
  assert.strictEqual(stateWarn.status, 'WARNING', 'Elevated methane should trigger WARNING');
  assert.strictEqual(stateWarn.gas_status.methane.status, 'WARNING', 'Methane status should be WARNING');
  assert.strictEqual(stateWarn.gas_status.overall, 'WARNING', 'Overall gas status should be WARNING');
  console.log('  ✓ Elevated methane (>300 ppm) triggers WARNING status and events');

  // Test 2.3: Gas Critical Trigger
  const gasCriticalTelemetry = {
    ...nominalTelemetry,
    environment: {
      ...nominalTelemetry.environment,
      methane: 700 // > 600 critical
    }
  };
  const stateCrit = await sm.processTelemetry(gasCriticalTelemetry);
  assert.strictEqual(stateCrit.status, 'EMERGENCY', 'Critical methane should trigger EMERGENCY');
  assert.strictEqual(stateCrit.gas_status.methane.status, 'CRITICAL', 'Methane status should be CRITICAL');
  assert.strictEqual(stateCrit.gas_status.overall, 'CRITICAL', 'Overall gas status should be CRITICAL');
  console.log('  ✓ Critical methane (>600 ppm) triggers EMERGENCY status');

  // Test 2.4: Emergency SOS Trigger
  const sosTelemetry = {
    ...nominalTelemetry,
    safety: { sos: true }
  };
  const stateSos = await sm.processTelemetry(sosTelemetry);
  assert.strictEqual(stateSos.status, 'EMERGENCY', 'SOS active must trigger EMERGENCY');
  assert.strictEqual(stateSos.sos, true, 'SOS flag must be true');
  console.log('  ✓ Hardware SOS active immediately forces EMERGENCY state');

  // Test 2.5: Event Generation
  const events = sm.getFullState().events;
  assert.ok(events.length > 0, 'Events log should contain entries');
  console.log(`  ✓ Event log populated (${events.length} events logged)`);

  sm.destroy();
}

// 3. Simulator Scenario Tests
console.log('\n[TEST GROUP 3] Telemetry Simulator Tests:');
{
  const sm = new StateManager();
  const sim = new TelemetrySimulator(sm, 100);

  // Normal Scenario
  sim.setScenario('NORMAL');
  const p1 = sim.generatePacket();
  const val1 = validateTelemetry(p1);
  assert.strictEqual(val1.valid, true, 'Simulator generated packet must match schema');
  assert.strictEqual(p1.safety.sos, false);
  console.log('  ✓ Simulator generates valid schema packet for NORMAL scenario');

  // Gas Warning Scenario
  sim.setScenario('GAS_WARNING');
  const p2 = sim.generatePacket();
  assert.ok(p2.environment.methane >= 300, 'Methane in GAS_WARNING should exceed 300');
  console.log(`  ✓ GAS_WARNING scenario generated Methane=${p2.environment.methane} ppm (Warning threshold >= 300)`);

  // Gas Critical Scenario
  sim.setScenario('GAS_CRITICAL');
  const p3 = sim.generatePacket();
  assert.ok(p3.environment.methane >= 600, 'Methane in GAS_CRITICAL should exceed 600');
  console.log(`  ✓ GAS_CRITICAL scenario generated Methane=${p3.environment.methane} ppm (Critical threshold >= 600)`);

  // SOS Scenario
  sim.setScenario('SOS');
  const p4 = sim.generatePacket();
  assert.strictEqual(p4.safety.sos, true, 'SOS scenario must have sos=true');
  console.log('  ✓ SOS scenario generated sos=true');

  sm.destroy();
}

console.log('\n============================================================');
console.log(' ALL PHASE 1 AUTOMATED TESTS PASSED SUCCESSFULLY! (100%)');
console.log('============================================================\n');
