import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// --- Gateway positions (from Salvora paper) ---
const GATEWAYS = [
  { id: 'GW1', lat: 42.46972, lon: -9.01345 },
  { id: 'GW2', lat: 42.49955, lon: -9.00654 },
  { id: 'GW3', lat: 42.50893, lon: -9.04902 },
];

// --- Haversine distance (metres) ---
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Parse Salvora CSV ---
function parseSalvora() {
  const csvPath = path.join(ROOT, 'salvora_lora_dataset.csv');
  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = raw.split('\n');
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 12) continue;

    const deviceLat = parseFloat(cols[9]);
    const deviceLon = parseFloat(cols[10]);
    if (!Number.isFinite(deviceLat) || !Number.isFinite(deviceLon)) continue;

    // Gateway 1: rssi_1 (col1), snr_1 (col2)
    const rssi1 = parseFloat(cols[1]);
    const snr1 = parseFloat(cols[2]);
    if (Number.isFinite(rssi1) && rssi1 !== 0) {
      const dist = haversine(deviceLat, deviceLon, GATEWAYS[0].lat, GATEWAYS[0].lon);
      rows.push({
        rssi: rssi1,
        snr: Number.isFinite(snr1) ? snr1 : null,
        distance: Math.round(dist * 100) / 100,
        source: 'salvora_gw1',
      });
    }

    // Gateway 2: rssi_2 (col3), snr_2 (col4)
    const rssi2 = parseFloat(cols[3]);
    const snr2 = parseFloat(cols[4]);
    if (Number.isFinite(rssi2) && rssi2 !== 0) {
      const dist = haversine(deviceLat, deviceLon, GATEWAYS[1].lat, GATEWAYS[1].lon);
      rows.push({
        rssi: rssi2,
        snr: Number.isFinite(snr2) ? snr2 : null,
        distance: Math.round(dist * 100) / 100,
        source: 'salvora_gw2',
      });
    }

    // Gateway 3: rssi_3 (col5), snr_3 (col6)
    const rssi3 = parseFloat(cols[5]);
    const snr3 = parseFloat(cols[6]);
    if (Number.isFinite(rssi3) && rssi3 !== 0) {
      const dist = haversine(deviceLat, deviceLon, GATEWAYS[2].lat, GATEWAYS[2].lon);
      rows.push({
        rssi: rssi3,
        snr: Number.isFinite(snr3) ? snr3 : null,
        distance: Math.round(dist * 100) / 100,
        source: 'salvora_gw3',
      });
    }
  }

  return rows;
}

// --- MUKUT hardware data ---
function parseMukutHardware() {
  const csvPath = path.join(ROOT, 'test', 'hw_ml_predictions.csv');
  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = raw.split('\n');
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const rssi = parseFloat(cols[2]);     // raw_rssi
    const gatewayDist = parseFloat(cols[9]); // gateway_distance

    if (Number.isFinite(rssi) && Number.isFinite(gatewayDist)) {
      // Estimate SNR using the same formula the ML estimator uses
      const snr = Math.round((rssi * 0.15 + 16.5) * 100) / 100;
      rows.push({
        rssi,
        snr,
        distance: gatewayDist,
        source: 'mukut_hardware',
      });
    }
  }

  return rows;
}

// --- Write CSV ---
function writeCSV(rows, outPath) {
  const header = 'rssi_dbm,snr_db,distance_m,source';
  const lines = [header];

  for (const r of rows) {
    const snrStr = r.snr != null ? r.snr.toFixed(2) : '';
    lines.push(`${r.rssi},${snrStr},${r.distance},${r.source}`);
  }

  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return lines.length - 1; // minus header
}

// --- Main ---
console.log('[1/3] Parsing Salvora dataset...');
const salvoraRows = parseSalvora();
console.log(`      Salvora: ${salvoraRows.length} rows`);

console.log('[2/3] Parsing MUKUT hardware data...');
const hardwareRows = parseMukutHardware();
console.log(`      MUKUT hardware: ${hardwareRows.length} rows`);

const allRows = [...salvoraRows, ...hardwareRows];

// Stats
const distances = allRows.map((r) => r.distance).filter((d) => d > 0);
const rssis = allRows.map((r) => r.rssi);
console.log(`\n--- Dataset Stats ---`);
console.log(`Total rows: ${allRows.length}`);
console.log(`Distance range: ${Math.min(...distances).toFixed(1)}m – ${(Math.max(...distances) / 1000).toFixed(1)}km`);
console.log(`RSSI range: ${Math.min(...rssis)} – ${Math.max(...rssis)} dBm`);
console.log(`Sources:`);
const sources = {};
for (const r of allRows) {
  sources[r.source] = (sources[r.source] || 0) + 1;
}
for (const [src, count] of Object.entries(sources)) {
  console.log(`  ${src}: ${count}`);
}

const outPath = path.join(__dirname, 'lora_training_dataset.csv');
console.log(`\n[3/3] Writing CSV to ${outPath}`);
const written = writeCSV(allRows, outPath);
console.log(`Done — ${written} rows written.`);
