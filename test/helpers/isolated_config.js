// Shared test helper — a config with the calibration persistence files
// pointed at unique temp locations.
//
// WHY: every suite that constructs a StateManager in LIVE hardware mode
// (data_source node1/hardware/serial) restores any leftover
// config/map_geometry.json and config/range_calibration.json from the last
// REAL hardware session (G38 gate). A test would then inherit whatever the
// operator last calibrated — distances, geometry and ML-bypass behaviour all
// become session-dependent and the suite breaks after every live demo.
// Pointing both files at a fresh non-existent temp path keeps live-mode
// semantics (data_source untouched) with a clean, deterministic slate.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tempDir() {
  const dir = path.join(os.tmpdir(), 'opencode');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

// Load config/default.json and isolate its persistence paths.
export function isolatedConfig() {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/default.json'), 'utf8'));
  return isolate(config);
}

// Isolate an already-loaded/parsed config (deep copy; the input is untouched).
export function isolate(config) {
  const out = JSON.parse(JSON.stringify(config));
  const uniq = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  out.trajectory = {
    ...(out.trajectory || {}),
    map_geometry_file: path.join(tempDir(), `mukut-test-geo-${uniq}.json`)
  };
  out.range_calibration = {
    ...(out.range_calibration || {}),
    file: path.join(tempDir(), `mukut-test-rc-${uniq}.json`)
  };
  return out;
}
