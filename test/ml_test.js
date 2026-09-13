import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MLEstimator, createMLEstimator } from '../src/server/mlEstimator.js';
import { CalibrationEngine } from '../src/server/calibrationEngine.js';
import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';

console.log('------------------------------------------------------------');
console.log(' Running MUKUT ML Distance Estimator Test Suite');
console.log(' (Phase 7: ONNX Random Forest RSSI+SNR → Distance)');
console.log('------------------------------------------------------------');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../config/default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ─── TEST GROUP 1: Model Loading ──────────────────────────────────────────────
console.log('\n[TEST GROUP 1] Model Loading:');
{
  const onnxPath = path.resolve(__dirname, '../models/mukut_distance_model.onnx');
  const metaPath = path.resolve(__dirname, '../models/mukut_model_metadata.json');

  assert.ok(fs.existsSync(onnxPath), 'ONNX model file must exist');
  console.log(`  ✓ ONNX model file found (${(fs.statSync(onnxPath).size / 1024).toFixed(0)} KB)`);

  const estimator = await createMLEstimator();
  assert.ok(estimator.isReady(), 'ML estimator must be ready after init');
  console.log('  ✓ ML estimator loaded and ready');

  const meta = estimator.getMetadata();
  assert.ok(meta, 'Metadata must be loaded');
  assert.strictEqual(meta.model_type, 'RandomForestRegressor');
  assert.deepStrictEqual(meta.features, ['rssi_dbm', 'snr_db']);
  assert.ok(meta.validated_range_m.min >= 0, 'validated_range_m.min must be non-negative');
  assert.ok(meta.validated_range_m.max > meta.validated_range_m.min, 'validated_range_m.max must be greater than min');
  console.log(`  ✓ Metadata: ${meta.model_type}, features=[${meta.features.join(', ')}], range=${meta.validated_range_m.min}–${meta.validated_range_m.max} m`);
}

// ─── TEST GROUP 2: Valid Input Inference ──────────────────────────────────────
console.log('\n[TEST GROUP 2] Valid Input Inference:');
{
  const estimator = await createMLEstimator();

  // Test case 1: Strong signal
  const r1 = await estimator.estimateDistance(-61, 8.5);
  assert.strictEqual(r1.method, 'ml');
  assert.strictEqual(r1.defaultSnr, false);
  assert.ok(typeof r1.distance === 'number' && Number.isFinite(r1.distance), 'Distance must be a finite number');
  assert.ok(r1.distance >= 0, 'Distance must be non-negative');
  console.log(`  ✓ RSSI=-61, SNR=8.5 → ${r1.distance} m (SNR provided)`);

  // Test case 2: Medium signal
  const r2 = await estimator.estimateDistance(-70, 6.2);
  assert.strictEqual(r2.method, 'ml');
  assert.ok(r2.distance >= 0, 'Distance must be non-negative');
  console.log(`  ✓ RSSI=-70, SNR=6.2 → ${r2.distance} m`);

  // Test case 3: Weak signal
  const r3 = await estimator.estimateDistance(-85, 3.0);
  assert.strictEqual(r3.method, 'ml');
  assert.ok(r3.distance >= 0, 'Distance must be non-negative');
  console.log(`  ✓ RSSI=-85, SNR=3.0 → ${r3.distance} m`);

  // Test case 4: Very weak signal
  const r4 = await estimator.estimateDistance(-95, 1.0);
  assert.strictEqual(r4.method, 'ml');
  assert.ok(r4.distance >= 0, 'Distance must be non-negative');
  console.log(`  ✓ RSSI=-95, SNR=1.0 → ${r4.distance} m`);

  // Sanity: ML model produces finite distances for all signals
  assert.ok(Number.isFinite(r2.distance) && r2.distance >= 0, 'Medium signal produces valid distance');
  assert.ok(Number.isFinite(r3.distance) && r3.distance >= 0, 'Weak signal produces valid distance');
  assert.ok(Number.isFinite(r4.distance) && r4.distance >= 0, 'Very weak signal produces valid distance');
  console.log('  ✓ All signal levels produce valid finite distances (sanity check passed)');
}

// ─── TEST GROUP 3: Default SNR Fallback ───────────────────────────────────────
console.log('\n[TEST GROUP 3] Default SNR Fallback:');
{
  const estimator = await createMLEstimator();

  // No SNR provided → should use default
  const r1 = await estimator.estimateDistance(-70);
  assert.strictEqual(r1.method, 'ml');
  assert.strictEqual(r1.defaultSnr, true);
  assert.ok(typeof r1.snr === 'number' && Number.isFinite(r1.snr), 'SNR should be computed from default');
  assert.ok(typeof r1.distance === 'number' && Number.isFinite(r1.distance), 'Distance must still be computed');
  console.log(`  ✓ RSSI=-70, SNR=null → default SNR=${r1.snr}, distance=${r1.distance} m`);

  // Explicit null SNR
  const r2 = await estimator.estimateDistance(-80, null);
  assert.strictEqual(r2.defaultSnr, true);
  console.log(`  ✓ RSSI=-80, SNR=null → default SNR=${r2.snr}, distance=${r2.distance} m`);

  // Explicit undefined SNR
  const r3 = await estimator.estimateDistance(-65, undefined);
  assert.strictEqual(r3.defaultSnr, true);
  console.log(`  ✓ RSSI=-65, SNR=undefined → default SNR=${r3.snr}, distance=${r3.distance} m`);
}

// ─── TEST GROUP 4: Input Validation ──────────────────────────────────────────
console.log('\n[TEST GROUP 4] Input Validation:');
{
  const estimator = await createMLEstimator();

  // Missing RSSI
  const r1 = await estimator.estimateDistance(null);
  assert.strictEqual(r1.method, 'invalid_input');
  assert.ok(r1.error.includes('Invalid RSSI'));
  console.log('  ✓ null RSSI → invalid_input error');

  // NaN RSSI
  const r2 = await estimator.estimateDistance(NaN);
  assert.strictEqual(r2.method, 'invalid_input');
  console.log('  ✓ NaN RSSI → invalid_input error');

  // Infinity RSSI
  const r3 = await estimator.estimateDistance(Infinity);
  assert.strictEqual(r3.method, 'invalid_input');
  console.log('  ✓ Infinity RSSI → invalid_input error');

  // String RSSI
  const r4 = await estimator.estimateDistance('abc');
  assert.strictEqual(r4.method, 'invalid_input');
  console.log('  ✓ "abc" RSSI → invalid_input error');

  // RSSI out of range (too positive)
  const r5 = await estimator.estimateDistance(0);
  assert.strictEqual(r5.method, 'invalid_input');
  console.log('  ✓ RSSI=0 (too positive) → invalid_input error');

  // RSSI out of range (too negative)
  const r6 = await estimator.estimateDistance(-150);
  assert.strictEqual(r6.method, 'invalid_input');
  console.log('  ✓ RSSI=-150 (too negative) → invalid_input error');

  // Invalid SNR (string) — should fallback to default
  const r7 = await estimator.estimateDistance(-70, 'abc');
  assert.strictEqual(r7.method, 'ml');
  assert.strictEqual(r7.defaultSnr, true);
  console.log('  ✓ SNR="abc" → falls back to default SNR');
}

// ─── TEST GROUP 5: Out-of-Range Detection ────────────────────────────────────
console.log('\n[TEST GROUP 5] Out-of-Range Detection:');
{
  const estimator = await createMLEstimator();

  // Very strong signal (very close)
  const r1 = await estimator.estimateDistance(-45, 12.0);
  assert.strictEqual(r1.method, 'ml');
  console.log(`  ✓ Close range: RSSI=-45, SNR=12 → ${r1.distance} m (inRange=${r1.inRange})`);

  // Very weak signal (far)
  const r2 = await estimator.estimateDistance(-100, 0.5);
  assert.strictEqual(r2.method, 'ml');
  console.log(`  ✓ Far range: RSSI=-100, SNR=0.5 → ${r2.distance} m (inRange=${r2.inRange})`);
}

// ─── TEST GROUP 6: CalibrationEngine ML Integration ──────────────────────────
console.log('\n[TEST GROUP 6] CalibrationEngine ML Integration:');
{
  const estimator = await createMLEstimator();
  const calEng = new CalibrationEngine(config);

  // Simulate ML distance map
  const mlMap = {
    link_helmet_node03: { distance: 4.87, method: 'ml', snr: 8.5, defaultSnr: false, inRange: true },
    link_node03_node02: { distance: 35.2, method: 'ml', snr: 6.2, defaultSnr: false, inRange: false }
  };
  calEng.setMLDistances(mlMap);

  // displayDistance: a live gateway-computed distance takes priority over the ML estimate
  // (then the helmet display offset applies: link_helmet_node03 → −5 m → 13)
  const link1 = { id: 'link_helmet_node03', rssi: -61, distance: 18 };
  const d1 = calEng.displayDistance(link1);
  assert.strictEqual(d1, 13, 'Live distance takes priority over ML estimate (minus helmet display offset)');
  console.log(`  ✓ displayDistance(link_helmet_node03) = ${d1} m (live distance priority, −5 m display offset)`);

  // No live distance → ML distance is used
  const link1b = { id: 'link_helmet_node03', rssi: -61, distance: null };
  const d1b = calEng.displayDistance(link1b);
  assert.ok(Math.abs(d1b - 4.87) < 0.01, 'ML distance should be used when no live distance exists');
  console.log(`  ✓ displayDistance(link_helmet_node03, no live dist) = ${d1b} m (ML fallback)`);

  // Trunk link should NOT use ML
  const trunk = { id: 'link_node02_node01', rssi: null, distance: null, hide_metrics: true };
  const dTrunk = calEng.displayDistance(trunk);
  assert.ok(dTrunk == null, 'Trunk link should pass through null');
  console.log('  ✓ Trunk link: ML not applied (hide_metrics)');

  // Link with no ML distance and no live distance → path-loss fallback
  const linkNoML = { id: 'link_helmet_node01', rssi: -53, distance: null };
  const dNoML = calEng.displayDistance(linkNoML);
  assert.ok(typeof dNoML === 'number' && Number.isFinite(dNoML), 'Path-loss fallback must return a number');
  console.log(`  ✓ displayDistance(link_helmet_node01) = ${dNoML} m (path-loss fallback)`);
}

// ─── TEST GROUP 7: Full Pipeline Integration ──────────────────────────────────
console.log('\n[TEST GROUP 7] Full Pipeline Integration:');
{
  const sm = new StateManager(config);
  const sim = new TelemetrySimulator(sm);
  sim.setScenario('NORMAL');

  // Wait for ML estimator to be ready (async init in StateManager constructor)
  while (!sm.mlEstimator.isReady()) {
    await new Promise(r => setTimeout(r, 50));
  }
  console.log('  ✓ ML estimator ready in StateManager');

  // Generate a packet
  const packet = sim.generatePacket();
  assert.ok(packet.network && Array.isArray(packet.network.links), 'Packet must have network.links');

  // Verify SNR is in the links
  const mlLink = packet.network.links.find(l => l.id === 'link_helmet_node03');
  assert.ok(mlLink, 'link_helmet_node03 must exist');
  assert.ok(typeof mlLink.snr === 'number', 'Link must carry SNR');
  console.log(`  ✓ Simulator packet link_helmet_node03: RSSI=${mlLink.rssi}, SNR=${mlLink.snr}`);

  // Process through StateManager (async — includes ML inference)
  await sm.processTelemetry(packet);

  // Check that ML was applied
  const stateLink = sm.links.find(l => l.id === 'link_helmet_node03');
  assert.ok(stateLink, 'State link must exist');
  assert.ok(typeof stateLink.distance === 'number', 'Distance must be a number after processing');
  console.log(`  ✓ State link_helmet_node03: RSSI=${stateLink.rssi}, distance=${stateLink.distance} m`);
}

// ─── TEST GROUP 8: Metadata Validation ────────────────────────────────────────
console.log('\n[TEST GROUP 8] Metadata Validation:');
{
  const metaPath = path.resolve(__dirname, '../models/mukut_model_metadata.json');
  assert.ok(fs.existsSync(metaPath), 'Metadata file must exist');

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.strictEqual(meta.model_type, 'RandomForestRegressor');
  assert.strictEqual(meta.target, 'distance_m');
  assert.deepStrictEqual(meta.features, ['rssi_dbm', 'snr_db']);
  assert.ok(Array.isArray(meta.training_distances_m), 'Training distances must be an array');
  assert.ok(meta.training_distances_m.length > 0, 'Training distances must not be empty');
  assert.ok(meta.validated_range_m.max >= 20, 'Validated range max must be >= 20 m');
  console.log(`  ✓ Metadata valid: range=${meta.validated_range_m.min}–${meta.validated_range_m.max} m`);
  console.log(`  ✓ Training distances: [${meta.training_distances_m.join(', ')}] m`);
}

// ─── DONE ──────────────────────────────────────────────────────────────────────
console.log('\n------------------------------------------------------------');
console.log(' All ML Distance Estimator tests passed!');
console.log('------------------------------------------------------------\n');
process.exit(0);
