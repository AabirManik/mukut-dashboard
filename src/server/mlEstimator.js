/**
 * MUKUT ML Distance Estimator (Phase 7 — ML RSSI+SNR → Distance)
 * Loads a pre-trained Random Forest Regressor (ONNX) that estimates
 * distance from RSSI and SNR, replacing the theoretical path-loss model
 * in the display layer.
 *
 * Architecture:
 *   RSSI + SNR → [ONNX Random Forest] → estimated distance (metres)
 *
 * The trajectory engine always receives RAW telemetry — ML distances
 * are a display-layer override only.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as ort from 'onnxruntime-web';

ort.env.wasm.numThreads = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL_PATH = path.resolve(__dirname, '../../models/mukut_distance_model.onnx');
const METADATA_PATH = path.resolve(__dirname, '../../models/mukut_model_metadata.json');

const RSSI_MIN = -120;
const RSSI_MAX = -20;
const SNR_MIN = -20;
const SNR_MAX = 20;
const DIST_MIN = 0;
const DIST_MAX = 25;

const DEFAULT_SNR_RSSI_FACTOR = 0.15;
const DEFAULT_SNR_OFFSET = 16.5;

export class MLEstimator {
  constructor() {
    this.session = null;
    this.metadata = null;
    this.ready = false;
    this.error = null;
  }

  async init() {
    try {
      if (!fs.existsSync(MODEL_PATH)) {
        throw new Error(`ONNX model not found at ${MODEL_PATH}`);
      }
      this.session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      if (fs.existsSync(METADATA_PATH)) {
        this.metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
      }

      this.ready = true;
      console.log('[ML] Distance estimator loaded — ONNX Random Forest ready');
      if (this.metadata) {
        console.log(`[ML] Model: ${this.metadata.model_type} | Features: ${this.metadata.features.join(' + ')} | Range: ${this.metadata.validated_range_m.min}–${this.metadata.validated_range_m.max} m`);
      }
    } catch (err) {
      this.ready = false;
      this.error = err.message;
      console.error(`[ML] Failed to load model: ${err.message}`);
    }
  }

  validateRssi(rssi) {
    if (rssi == null || typeof rssi !== 'number' || !Number.isFinite(rssi)) return false;
    return rssi >= RSSI_MIN && rssi <= RSSI_MAX;
  }

  validateSnr(snr) {
    if (snr == null || typeof snr !== 'number' || !Number.isFinite(snr)) return false;
    return snr >= SNR_MIN && snr <= SNR_MAX;
  }

  estimateDefaultSnr(rssi) {
    return Number((rssi * DEFAULT_SNR_RSSI_FACTOR + DEFAULT_SNR_OFFSET).toFixed(2));
  }

  async estimateDistance(rssi, snr = null) {
    if (!this.ready) {
      return { distance: null, method: 'unavailable', error: this.error || 'Model not loaded', defaultSnr: false };
    }

    if (!this.validateRssi(rssi)) {
      return { distance: null, method: 'invalid_input', error: `Invalid RSSI: ${rssi}`, defaultSnr: false };
    }

    let defaultSnr = false;
    let snrValue = snr;

    if (!this.validateSnr(snrValue)) {
      snrValue = this.estimateDefaultSnr(rssi);
      defaultSnr = true;
    }

    try {
      const input = new ort.Tensor('float32', new Float32Array([rssi, snrValue]), [1, 2]);
      const inputName = this.session.inputNames[0];
      const outputName = this.session.outputNames[0];
      const results = await this.session.run({ [inputName]: input });
      const predicted = results[outputName].data[0];
      const distance = Number(predicted.toFixed(2));

      const inRange = distance >= this.metadata?.validated_range_m?.min &&
                       distance <= this.metadata?.validated_range_m?.max;

      return {
        distance,
        method: 'ml',
        rssi,
        snr: Number(snrValue.toFixed(2)),
        defaultSnr,
        inRange,
        modelType: this.metadata?.model_type || 'RandomForestRegressor'
      };
    } catch (err) {
      return { distance: null, method: 'inference_error', error: err.message, defaultSnr };
    }
  }

  getMetadata() {
    return this.metadata;
  }

  isReady() {
    return this.ready;
  }
}

export async function createMLEstimator() {
  const estimator = new MLEstimator();
  await estimator.init();
  return estimator;
}
