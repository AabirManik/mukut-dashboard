/**
 * MUKUT ML Pipeline Validation — SIMULATED DATA
 * Runs production ONNX inference against simulated telemetry packets.
 * Do NOT present results as real hardware accuracy.
 */

import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';
import { CalibrationEngine } from '../src/server/calibrationEngine.js';
import { MLEstimator } from '../src/server/mlEstimator.js';
import { isolate } from './helpers/isolated_config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../config/default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const PACKET_COUNT = 25;

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  MUKUT ML Pipeline Validation — SIMULATED DATA');
console.log('  Using production ONNX inference (onnxruntime-web WASM)');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// ─── Initialize ────────────────────────────────────────────────────────────────
const sm = new StateManager(isolate(config));
const sim = new TelemetrySimulator(sm);
const calEng = new CalibrationEngine(config);
const mlEstimator = new MLEstimator();

console.log('[BOOT] Loading ONNX model...');
await mlEstimator.init();
if (!mlEstimator.isReady()) {
  console.error('[FATAL] ML estimator failed to load — aborting');
  process.exit(1);
}
console.log('');

sim.setScenario('NORMAL');

// ─── Stats ─────────────────────────────────────────────────────────────────────
let totalLinks = 0;
let successCount = 0;
let errorCount = 0;
let nanCount = 0;
let negativeCount = 0;
const mlDistances = [];
const theoreticalDistances = [];

// ─── Run Packets ───────────────────────────────────────────────────────────────
for (let tick = 1; tick <= PACKET_COUNT; tick++) {
  const packet = sim.generatePacket();
  const links = packet.network?.links || [];

  const pad = String(tick).padStart(2, '0');

  for (const link of links) {
    if (link.rssi == null || link.hide_metrics || link.id === 'link_node02_node01') continue;

    totalLinks++;

    // Theoretical distance (path-loss model)
    const theoretical = Number(calEng.clampDistance(calEng.rssiToDistance(link.rssi)).toFixed(2));

    // ML inference (production module)
    const mlResult = await mlEstimator.estimateDistance(link.rssi, link.snr ?? null);

    if (mlResult.method === 'ml' && mlResult.distance != null) {
      successCount++;
      mlDistances.push(mlResult.distance);
      theoreticalDistances.push(theoretical);

      if (Number.isNaN(mlResult.distance)) nanCount++;
      if (mlResult.distance < 0) negativeCount++;

      const snrLabel = mlResult.defaultSnr ? `${mlResult.snr} (default)` : `${mlResult.snr}`;
      console.log(
        `[${pad}] ${link.source}→${link.destination}`.padEnd(32) +
        `RSSI=${String(link.rssi).padStart(4)}  SNR=${snrLabel.padEnd(14)}` +
        `theoretical=${String(theoretical).padStart(5)}m  ML=${String(mlResult.distance).padStart(5)}m`
      );
    } else {
      errorCount++;
      console.log(
        `[${pad}] ${link.source}→${link.destination}`.padEnd(32) +
        `RSSI=${String(link.rssi).padStart(4)}  SNR=${String(link.snr ?? 'null').padEnd(14)}` +
        `ERROR: ${mlResult.error || mlResult.method}`
      );
    }
  }

  // Feed through full pipeline (keeps StateManager alive)
  await sm.processTelemetry(packet);
}

// ─── Validation Report ─────────────────────────────────────────────────────────
const mlAvg = mlDistances.length > 0 ? (mlDistances.reduce((a, b) => a + b, 0) / mlDistances.length) : 0;
const mlMin = mlDistances.length > 0 ? Math.min(...mlDistances) : 0;
const mlMax = mlDistances.length > 0 ? Math.max(...mlDistances) : 0;
const thAvg = theoreticalDistances.length > 0 ? (theoreticalDistances.reduce((a, b) => a + b, 0) / theoreticalDistances.length) : 0;
const thMin = theoreticalDistances.length > 0 ? Math.min(...theoreticalDistances) : 0;
const thMax = theoreticalDistances.length > 0 ? Math.max(...theoreticalDistances) : 0;
const successRate = totalLinks > 0 ? ((successCount / totalLinks) * 100).toFixed(1) : '0.0';

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  MUKUT ML PIPELINE VALIDATION REPORT');
console.log('  DATA SOURCE: SIMULATED (TelemetrySimulator)');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Total packets:            ${PACKET_COUNT}`);
console.log(`  Total link inferences:    ${totalLinks}`);
console.log(`  Successful:               ${successCount} (${successRate}%)`);
console.log(`  Errors:                   ${errorCount}`);
console.log(`  NaN predictions:          ${nanCount}`);
console.log(`  Negative distances:       ${negativeCount}`);
console.log('  ──────────────────────────────────────────────────────────');
console.log('  ML Distance Stats (ONNX Random Forest):');
console.log(`    Average:   ${mlAvg.toFixed(2)} m`);
console.log(`    Minimum:   ${mlMin.toFixed(2)} m`);
console.log(`    Maximum:   ${mlMax.toFixed(2)} m`);
console.log('  ──────────────────────────────────────────────────────────');
console.log('  Theoretical Distance Stats (Path-Loss Model):');
console.log(`    Average:   ${thAvg.toFixed(2)} m`);
console.log(`    Minimum:   ${thMin.toFixed(2)} m`);
console.log(`    Maximum:   ${thMax.toFixed(2)} m`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('  ⚠  SIMULATED DATA — NOT REAL HARDWARE ACCURACY');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

process.exit(0);
