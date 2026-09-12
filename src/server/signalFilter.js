/**
 * MUKUT Signal Filter (Phase 8 — Temporal Median Filter)
 * Applies a per-link rolling median filter to RSSI and SNR
 * before ONNX inference, reducing noise spikes while
 * preserving genuine signal changes.
 *
 * Each LoRa link maintains independent buffers for RSSI and SNR.
 * The median is computed over the last N samples (configurable window).
 * During cold start, uses whatever samples are available.
 */

export class SignalFilter {
  constructor(config) {
    const sf = (config && config.signal_filter) || {};
    this.windowSize = (sf.window_size > 0) ? sf.window_size : 5;
    this.buffers = {};
  }

  _ensureBuffer(linkId) {
    if (!this.buffers[linkId]) {
      this.buffers[linkId] = { rssi: [], snr: [] };
    }
  }

  push(linkId, rssi, snr) {
    this._ensureBuffer(linkId);
    const buf = this.buffers[linkId];

    if (typeof rssi === 'number' && Number.isFinite(rssi)) {
      buf.rssi.push(rssi);
      if (buf.rssi.length > this.windowSize) buf.rssi.shift();
    }

    if (typeof snr === 'number' && Number.isFinite(snr)) {
      buf.snr.push(snr);
      if (buf.snr.length > this.windowSize) buf.snr.shift();
    }
  }

  _median(arr) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted[mid];
  }

  getFiltered(linkId) {
    this._ensureBuffer(linkId);
    const buf = this.buffers[linkId];
    return {
      rssi: this._median(buf.rssi),
      snr: this._median(buf.snr),
      samples: Math.max(buf.rssi.length, buf.snr.length)
    };
  }

  getRaw(linkId) {
    this._ensureBuffer(linkId);
    const buf = this.buffers[linkId];
    return {
      rssi: buf.rssi.length > 0 ? buf.rssi[buf.rssi.length - 1] : null,
      snr: buf.snr.length > 0 ? buf.snr[buf.snr.length - 1] : null
    };
  }

  reset(linkId) {
    delete this.buffers[linkId];
  }

  resetAll() {
    this.buffers = {};
  }

  getBufferSize(linkId) {
    this._ensureBuffer(linkId);
    return Math.max(this.buffers[linkId].rssi.length, this.buffers[linkId].snr.length);
  }

  getWindowSize() {
    return this.windowSize;
  }
}
