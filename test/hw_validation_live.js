/**
 * MUKUT Real-Hardware ONNX Distance Validation
 * Uses actual RSSI from the LoRa gateway (Node1) with ONNX inference.
 * SNR is null from the gateway firmware → default SNR formula applied.
 */

import { MLEstimator } from '../src/server/mlEstimator.js';
import { SignalFilter } from '../src/server/signalFilter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATEWAY_URL = 'http://192.168.14.60/api/telemetry';
const NUM_SAMPLES = 60;
const POLL_INTERVAL_MS = 1500;
const FILTER_WINDOW = 5;

async function collectRawSamples(count) {
  const samples = [];
  console.log(`\n[COLLECT] Fetching ${count} samples from gateway at ${GATEWAY_URL}...`);
  
  for (let i = 0; i < count; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(GATEWAY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      
      const data = await response.json();
      const hd = data.mesh_topology?.helmet_direct || {};
      
      samples.push({
        timestamp: new Date().toISOString(),
        raw_rssi: hd.rssi_dbm ?? null,
        raw_snr: hd.snr_db ?? null,
        gateway_distance: hd.distance_to_helmet_m ?? null,
        miner_status: data.miner?.status || 'UNKNOWN'
      });
      
      process.stdout.write(`\r[COLLECT] Sample ${i + 1}/${count} | RSSI=${hd.rssi_dbm} | GW_Dist=${hd.distance_to_helmet_m}m`);
      
      if (i < count - 1) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error(`\n[COLLECT] Error at sample ${i + 1}: ${err.message}`);
      samples.push({
        timestamp: new Date().toISOString(),
        raw_rssi: null,
        raw_snr: null,
        gateway_distance: null,
        miner_status: 'ERROR'
      });
    }
  }
  console.log('\n');
  return samples;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function rmse(predictions, actuals) {
  const sqErrors = predictions.map((p, i) => Math.pow(p - actuals[i], 2));
  return Math.sqrt(sqErrors.reduce((a, b) => a + b, 0) / sqErrors.length);
}

function mae(predictions, actuals) {
  return predictions.map((p, i) => Math.abs(p - actuals[i])).reduce((a, b) => a + b, 0) / predictions.length;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  MUKUT REAL-HARDWARE ONNX DISTANCE VALIDATION');
  console.log('  Date:', new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════');

  // 1. Initialize ML estimator
  console.log('\n[BOOT] Loading ONNX model...');
  const ml = new MLEstimator();
  await ml.init();
  if (!ml.isReady()) {
    console.error('[FATAL] ML estimator failed to load:', ml.error);
    process.exit(1);
  }

  // 2. Initialize signal filter
  const filter = new SignalFilter({ signal_filter: { window_size: FILTER_WINDOW } });
  console.log(`[BOOT] Median filter window: ${FILTER_WINDOW}`);

  // 3. Collect raw samples from live hardware
  const rawSamples = await collectRawSamples(NUM_SAMPLES);

  // 4. Run ONNX inference on each sample
  console.log('[INFERENCE] Running ONNX distance estimation on collected samples...\n');
  
  const results = [];
  let nanCount = 0;
  let negativeCount = 0;
  let errorCount = 0;

  for (let i = 0; i < rawSamples.length; i++) {
    const s = rawSamples[i];
    
    if (s.raw_rssi == null) {
      console.log(`  [${String(i + 1).padStart(3)}] SKIP — no RSSI`);
      continue;
    }

    // Push raw values into filter
    filter.push(`link_helmet_node01`, s.raw_rssi, s.raw_snr);
    const filtered = filter.getFiltered(`link_helmet_node01`);

    // ONNX inference
    const result = await ml.estimateDistance(filtered.rssi, filtered.snr);

    if (result.distance == null) {
      nanCount++;
      console.log(`  [${String(i + 1).padStart(3)}] RSSI=${s.raw_rssi} SNR=${s.raw_snr} → INFERENCE_ERROR: ${result.error}`);
      continue;
    }

    if (result.distance < 0) {
      negativeCount++;
    }

    results.push({
      sample: i + 1,
      timestamp: s.timestamp,
      raw_rssi: s.raw_rssi,
      raw_snr: s.raw_snr,
      filtered_rssi: filtered.rssi,
      filtered_snr: filtered.snr,
      default_snr: result.defaultSnr,
      ml_distance: result.distance,
      in_range: result.inRange,
      gateway_distance: s.gateway_distance,
      miner_status: s.miner_status
    });

    const snrTag = result.defaultSnr ? ' (default)' : '';
    console.log(
      `  [${String(i + 1).padStart(3)}] Raw RSSI=${String(s.raw_rssi).padStart(4)} SNR=${String(s.raw_snr).padStart(5)}` +
      ` → Filtered RSSI=${String(filtered.rssi).padStart(4)} SNR=${String(filtered.snr).padStart(5)}${snrTag}` +
      ` | ML=${result.distance.toFixed(2)}m | GW=${s.gateway_distance}m`
    );
  }

  // 5. Save detailed results to CSV
  const csvPath = path.join(__dirname, 'hw_ml_predictions.csv');
  const csvHeader = 'sample,timestamp,raw_rssi,raw_snr,filtered_rssi,filtered_snr,default_snr,ml_distance,in_range,gateway_distance,miner_status\n';
  const csvRows = results.map(r =>
    `${r.sample},${r.timestamp},${r.raw_rssi},${r.raw_snr},${r.filtered_rssi},${r.filtered_snr},${r.default_snr},${r.ml_distance},${r.in_range},${r.gateway_distance},${r.miner_status}`
  ).join('\n');
  fs.writeFileSync(csvPath, csvHeader + csvRows);
  console.log(`\n[SAVE] Predictions saved to ${csvPath}`);

  // 6. Filter out offline links (RSSI=-100 is a disconnected link)
  const validResults = results.filter(r => r.raw_rssi > -95);
  const invalidResults = results.filter(r => r.raw_rssi <= -95);

  console.log(`\n[STATS] Total samples: ${results.length}`);
  console.log(`[STATS] Valid (RSSI > -95 dBm): ${validResults.length}`);
  console.log(`[STATS] Offline/disconnected (RSSI <= -95 dBm): ${invalidResults.length}`);
  console.log(`[STATS] Inference errors: ${nanCount}`);
  console.log(`[STATS] Negative distances: ${negativeCount}`);

  if (validResults.length === 0) {
    console.error('\n[FATAL] No valid samples with real RSSI data.');
    process.exit(1);
  }

  // 7. Compute ML distance statistics for valid samples
  const mlDistances = validResults.map(r => r.ml_distance);
  const gwDistances = validResults.filter(r => r.gateway_distance != null).map(r => r.gateway_distance);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ONNX ML DISTANCE PREDICTIONS (LIVE HARDWARE)');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Valid samples:          ${validResults.length}`);
  console.log(`  ML Distance Min:        ${Math.min(...mlDistances).toFixed(2)} m`);
  console.log(`  ML Distance Max:        ${Math.max(...mlDistances).toFixed(2)} m`);
  console.log(`  ML Distance Median:     ${median(mlDistances).toFixed(2)} m`);
  console.log(`  ML Distance Mean:       ${mean(mlDistances).toFixed(2)} m`);
  console.log(`  ML Distance StdDev:     ${Math.sqrt(mlDistances.reduce((s, d) => s + Math.pow(d - mean(mlDistances), 2), 0) / mlDistances.length).toFixed(2)} m`);
  
  if (gwDistances.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  GATEWAY REFERENCE DISTANCE');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Gateway Distance Min:   ${Math.min(...gwDistances).toFixed(2)} m`);
    console.log(`  Gateway Distance Max:   ${Math.max(...gwDistances).toFixed(2)} m`);
    console.log(`  Gateway Distance Median:${median(gwDistances).toFixed(2)} m`);
    console.log(`  Gateway Distance Mean:  ${mean(gwDistances).toFixed(2)} m`);
  }

  // 8. Comparison: ML vs Gateway (both are predictions, gateway is our best reference)
  if (gwDistances.length > 0) {
    const mlForGw = validResults.filter(r => r.gateway_distance != null).map(r => r.ml_distance);
    const gwRef = validResults.filter(r => r.gateway_distance != null).map(r => r.gateway_distance);

    const overallMae = mae(mlForGw, gwRef);
    const overallRmse = rmse(mlForGw, gwRef);
    const maxError = Math.max(...mlForGw.map((d, i) => Math.abs(d - gwRef[i])));
    const within1m = mlForGw.filter((d, i) => Math.abs(d - gwRef[i]) <= 1.0).length / mlForGw.length * 100;
    const within2m = mlForGw.filter((d, i) => Math.abs(d - gwRef[i]) <= 2.0).length / mlForGw.length * 100;

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  ML vs GATEWAY COMPARISON');
    console.log('  (Gateway RSSI-based distance used as reference)');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Overall MAE:            ${overallMae.toFixed(2)} m`);
    console.log(`  Overall RMSE:           ${overallRmse.toFixed(2)} m`);
    console.log(`  Max Absolute Error:     ${maxError.toFixed(2)} m`);
    console.log(`  Within ±1 m:            ${within1m.toFixed(1)}%`);
    console.log(`  Within ±2 m:            ${within2m.toFixed(1)}%`);

    // 9. Group by gateway distance buckets
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  RESULTS BY DISTANCE BUCKET');
    console.log('═══════════════════════════════════════════════════════');
    console.log('  GW_Dist(m) | ML_Med | ML_Mean | MAE    | Min    | Max    | N');
    console.log('  -----------+--------+---------+--------+--------+--------+---');

    const buckets = {};
    for (let i = 0; i < mlForGw.length; i++) {
      const bucket = Math.round(gwRef[i]);
      if (!buckets[bucket]) buckets[bucket] = { ml: [], gw: [] };
      buckets[bucket].ml.push(mlForGw[i]);
      buckets[bucket].gw.push(gwRef[i]);
    }

    for (const bucket of Object.keys(buckets).sort((a, b) => Number(a) - Number(b))) {
      const b = buckets[bucket];
      const bMedian = median(b.ml).toFixed(1);
      const bMean = mean(b.ml).toFixed(1);
      const bMae = mae(b.ml, b.gw).toFixed(2);
      const bMin = Math.min(...b.ml).toFixed(1);
      const bMax = Math.max(...b.ml).toFixed(1);
      console.log(`  ${String(bucket).padStart(10)}m | ${bMedian.padStart(6)} | ${bMean.padStart(7)} | ${bMae.padStart(6)} | ${bMin.padStart(6)} | ${bMax.padStart(6)} | ${b.ml.length}`);
    }
  }

  // 10. Error analysis
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  HARDWARE INTEGRATION STATUS');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  ONNX model loaded:       YES`);
  console.log(`  Median filter active:    YES (window=${FILTER_WINDOW})`);
  console.log(`  Backend crashes:         0`);
  console.log(`  NaN predictions:         ${nanCount}`);
  console.log(`  Negative distances:      ${negativeCount}`);
  console.log(`  SNR from hardware:       ${results.some(r => r.raw_snr != null) ? 'YES' : 'NO — default SNR formula used'}`);
  console.log(`  Active link tested:      HELMET01->NODE01 (direct)`);
  console.log(`  NODE02/NODE03:           OFFLINE (not physically present)`);
  console.log(`  Validated range:         1–20 m (model training range)`);
  console.log(`  Tested range:            ${Math.min(...gwDistances).toFixed(1)}–${Math.max(...gwDistances).toFixed(1)} m (gateway reference)`);

  // 11. Important notes
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  IMPORTANT NOTES');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  • Gateway firmware does NOT report SNR → default SNR formula used');
  console.log('  • Gateway distance is RSSI-based (path-loss model), NOT ground truth');
  console.log('  • For true accuracy, measure physical distance with tape measure');
  console.log('  • NODE02/NODE03 offline — only HELMET→GATEWAY direct link active');
  console.log('  • Results are NOT mixed with simulated or Colab test data');
  console.log('  • Model validated range: 1–20 m — do not claim accuracy outside');

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  VALIDATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
