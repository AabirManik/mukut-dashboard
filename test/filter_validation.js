/**
 * MUKUT Filter Validation — SIMULATED DATA
 * Compares ML distance with and without median filtering.
 * Do NOT present results as real hardware accuracy.
 */

import { StateManager } from '../src/server/stateManager.js';
import { TelemetrySimulator } from '../src/server/simulator.js';
import { CalibrationEngine } from '../src/server/calibrationEngine.js';
import { MLEstimator } from '../src/server/mlEstimator.js';
import { SignalFilter } from '../src/server/signalFilter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../config/default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const PACKET_COUNT = 25;

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  MUKUT Median Filter Validation — SIMULATED DATA');
console.log('  Comparing raw vs filtered ONNX inference');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// ─── Initialize ────────────────────────────────────────────────────────────────
const sm = new StateManager(config);
const sim = new TelemetrySimulator(sm);
const calEng = new CalibrationEngine(config);
const mlEstimator = new MLEstimator();
const filter = new SignalFilter(config);

console.log('[BOOT] Loading ONNX model...');
await mlEstimator.init();
if (!mlEstimator.isReady()) {
  console.error('[FATAL] ML estimator failed to load — aborting');
  process.exit(1);
}
console.log(`[BOOT] Median filter window size: ${filter.getWindowSize()}`);
console.log('');

sim.setScenario('NORMAL');

// ─── Per-link stats ────────────────────────────────────────────────────────────
const linkIds = ['link_helmet_node03', 'link_node03_node02', 'link_node03_node01'];
const linkLabels = {
  link_helmet_node03: 'HELMET01→NODE03',
  link_node03_node02: 'NODE03→NODE02',
  link_node03_node01: 'NODE03→NODE01'
};
const rawDistances = {};
const filtDistances = {};
linkIds.forEach(id => { rawDistances[id] = []; filtDistances[id] = []; });

// ─── Run Packets ───────────────────────────────────────────────────────────────
for (let tick = 1; tick <= PACKET_COUNT; tick++) {
  const packet = sim.generatePacket();
  const links = packet.network?.links || [];
  const pad = String(tick).padStart(2, '0');

  for (const link of links) {
    if (link.rssi == null || link.hide_metrics || link.id === 'link_node02_node01') continue;
    if (!linkIds.includes(link.id)) continue;

    const rawRssi = link.rssi;
    const rawSnr = link.snr ?? null;

    // Raw inference (no filter)
    const rawResult = await mlEstimator.estimateDistance(rawRssi, rawSnr);

    // Filtered inference
    filter.push(link.id, rawRssi, rawSnr);
    const filtered = filter.getFiltered(link.id);
    const filtResult = await mlEstimator.estimateDistance(filtered.rssi, filtered.snr);

    if (rawResult.distance != null) rawDistances[link.id].push(rawResult.distance);
    if (filtResult.distance != null) filtDistances[link.id].push(filtResult.distance);

    const label = linkLabels[link.id] || link.id;
    const rawD = rawResult.distance != null ? rawResult.distance.toFixed(2) : 'ERR';
    const filtD = filtResult.distance != null ? filtResult.distance.toFixed(2) : 'ERR';
    console.log(
      `[${pad}] ${label}`.padEnd(30) +
      `Raw: RSSI=${String(rawRssi).padStart(4)} SNR=${String(rawSnr ?? 'null').padEnd(5)} ` +
      `Filtered: RSSI=${String(filtered.rssi).padStart(4)} SNR=${String(filtered.snr ?? 'null').padEnd(5)} ` +
      `Raw ML=${rawD.padStart(5)}m  Filt ML=${filtD.padStart(5)}m`
    );
  }

  await sm.processTelemetry(packet);
}

// ─── Stats helpers ─────────────────────────────────────────────────────────────
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// ─── Validation Report ─────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  FILTER VALIDATION REPORT');
console.log('  DATA SOURCE: SIMULATED (TelemetrySimulator)');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Window size: ${filter.getWindowSize()}`);
console.log(`  Packets: ${PACKET_COUNT}`);
console.log('');
console.log('  Link                   Raw StdDev  Filt StdDev  Reduction');
console.log('  ──────────────────────────────────────────────────────────');

let totalRawStd = 0;
let totalFiltStd = 0;
let linkCount = 0;

for (const id of linkIds) {
  const label = (linkLabels[id] || id).padEnd(22);
  const rawStd = stdDev(rawDistances[id]);
  const filtStd = stdDev(filtDistances[id]);
  const reduction = rawStd > 0 ? ((rawStd - filtStd) / rawStd * 100) : 0;

  totalRawStd += rawStd;
  totalFiltStd += filtStd;
  linkCount++;

  console.log(
    `  ${label}` +
    `${rawStd.toFixed(3)} m`.padStart(10) +
    `${filtStd.toFixed(3)} m`.padStart(12) +
    `${reduction.toFixed(1)}%`.padStart(10)
  );
}

const avgRawStd = linkCount > 0 ? totalRawStd / linkCount : 0;
const avgFiltStd = linkCount > 0 ? totalFiltStd / linkCount : 0;
const avgReduction = avgRawStd > 0 ? ((avgRawStd - avgFiltStd) / avgRawStd * 100) : 0;

console.log('  ──────────────────────────────────────────────────────────');
console.log(
    '  ' + 'AVERAGE'.padEnd(22) +
    `${avgRawStd.toFixed(3)} m`.padStart(10) +
    `${avgFiltStd.toFixed(3)} m`.padStart(12) +
    `${avgReduction.toFixed(1)}%`.padStart(10)
  );
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  ⚠  SIMULATED DATA — NOT REAL HARDWARE ACCURACY');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

process.exit(0);
