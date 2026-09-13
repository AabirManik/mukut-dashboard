/**
 * MUKUT Range Calibrator (v5 — two-point live path-loss fit)
 *
 * The single biggest source of distance inaccuracy was that every conversion
 * used a reference that was never measured on the real hardware: the firmware
 * locks its N2↔N3 baseline at whatever separation the nodes booted at, the
 * N1↔N2/N1↔N3 profile is a hardcoded guess (−45 dBm @ 1 m, n 2.2), and the
 * ONNX model saturates at 1–2 m across the whole measured band.
 *
 * This calibrator fits the REAL path-loss curve from two known placements:
 *   1. Hold the helmet exactly 1 m from NODE 2 → capture (8 s averaging)
 *   2. Hold the helmet 3 m from NODE 2 → capture
 * From the two (rssi, distance) pairs it solves the log-distance model
 *   rssi(d) = A − 10·n·log10(d)
 * for the actual radios/antennas/environment. The fitted curve then converts
 * ANY live RSSI (helmet links, inter-node trunk/peer links — same radio
 * family) into an accurate distance, so the dashboard visibly tracks the
 * helmet as it moves.
 *
 * State machine: IDLE → CAPTURING (per point) → CALIBRATED (both points).
 * Persisted via the stateManager hook; survives restarts.
 */

export class RangeCalibrator {
  constructor(config = {}) {
    const rc = (config && config.range_calibration) || {};
    this.captureMs = rc.capture_window_ms > 0 ? rc.capture_window_ms : 8000;
    this.referenceLink = rc.reference_link || 'link_helmet_node02';
    this.minSamples = rc.min_samples > 0 ? rc.min_samples : 3;

    this.points = {};    // { 1: { distance_m, rssi }, 2: { ... } }
    this.A = null;       // fitted RSSI @ 1 m
    this.n = null;       // fitted path-loss exponent
    this.status = 'IDLE';   // IDLE | CAPTURING | CALIBRATED
    this.capture = null;    // { point, distance_m, startedAt, samples: [] }

    // hooks (set by stateManager)
    this.onEvent = null;    // (severity, message) => void
    this.onLock = null;     // (data) => void — persist the fitted curve
  }

  isCalibrated() {
    return this.status === 'CALIBRATED' && this.A != null && this.n != null;
  }

  isCapturing() {
    return this.status === 'CAPTURING' && this.capture != null;
  }

  // Start an 8 s capture window for one known placement.
  startCapture(point, distanceM) {
    if (this.isCapturing()) {
      return { started: false, reason: 'a capture is already running' };
    }
    if (point !== 1 && point !== 2) {
      return { started: false, reason: 'point must be 1 or 2' };
    }
    if (!(typeof distanceM === 'number' && Number.isFinite(distanceM) && distanceM > 0)) {
      return { started: false, reason: 'distance_m must be a positive number' };
    }
    this.capture = { point, distance_m: distanceM, startedAt: Date.now(), samples: [] };
    this.status = 'CAPTURING';
    return { started: true, point, distance_m: distanceM, duration_ms: this.captureMs };
  }

  // Called from processTelemetry on every packet. Samples the reference
  // link's live RSSI; closes the window when the duration elapses.
  sample(telemetry) {
    if (!this.isCapturing()) return null;
    const links = telemetry && telemetry.network && Array.isArray(telemetry.network.links)
      ? telemetry.network.links : [];
    const ref = links.find(l => l.id === this.referenceLink);
    if (ref && typeof ref.rssi === 'number' && Number.isFinite(ref.rssi) && ref.rssi < 0
        && ref.status !== 'DISCONNECTED') {
      this.capture.samples.push(ref.rssi);
      if (this.capture.samples.length > 200) this.capture.samples.shift();
    }
    if (Date.now() - this.capture.startedAt >= this.captureMs) {
      return this.finalizeCapture();
    }
    return null;
  }

  finalizeCapture() {
    const c = this.capture;
    this.capture = null;
    this.status = this.isCalibrated() ? 'CALIBRATED' : 'IDLE';
    if (!c || c.samples.length < this.minSamples) {
      if (this.onEvent) {
        this.onEvent('WARNING',
          `Range calibration point ${c ? c.point : '?'} failed — not enough RSSI samples on ${this.referenceLink} (is the helmet transmitting?)`);
      }
      return { captured: false, reason: 'not enough RSSI samples on the reference link' };
    }
    const rssi = c.samples.reduce((a, b) => a + b, 0) / c.samples.length;
    this.points[c.point] = { distance_m: c.distance_m, rssi: Number(rssi.toFixed(1)) };
    if (this.onEvent) {
      this.onEvent('INFO',
        `Range calibration point ${c.point} captured — ${c.distance_m} m @ ${rssi.toFixed(1)} dBm (${c.samples.length} samples)`);
    }
    if (this.points[1] && this.points[2]) {
      if (this.fit()) {
        if (this.onEvent) {
          this.onEvent('INFO',
            `Range curve LOCKED — fitted on real hardware: A ${this.A} dBm @ 1 m, exponent n ${this.n} — all live distances now use the measured curve`);
        }
        if (this.onLock) {
          this.onLock({ points: this.points, A: this.A, n: this.n, saved_at: Date.now() });
        }
        return { captured: true, point: c.point, calibrated: true, A: this.A, n: this.n };
      }
      if (this.onEvent) {
        this.onEvent('WARNING', 'Range curve fit failed — implausible measurements, re-capture both points');
      }
      return { captured: true, point: c.point, calibrated: false };
    }
    return { captured: true, point: c.point, calibrated: false };
  }

  // Solve rssi(d) = A − 10·n·log10(d) from the two captured points.
  fit() {
    const p1 = this.points[1];
    const p2 = this.points[2];
    if (!p1 || !p2) return false;
    if (!(p1.distance_m > 0 && p2.distance_m > 0) || p1.distance_m === p2.distance_m) return false;
    const lg = Math.log10(p2.distance_m / p1.distance_m);
    if (Math.abs(lg) < 1e-6) return false;
    let n = (p1.rssi - p2.rssi) / (10 * lg);
    n = Math.max(1.5, Math.min(4.0, n)); // sanity clamp for the exponent
    const A = p1.rssi + 10 * n * Math.log10(p1.distance_m);
    if (!(A >= -70 && A <= -25)) return false; // 1 m reference must be plausible
    this.A = Number(A.toFixed(1));
    this.n = Number(n.toFixed(2));
    this.status = 'CALIBRATED';
    return true;
  }

  // Convert a live RSSI into a distance using the fitted curve.
  // Mirrors the firmware's sub-metre branch and 30 m cap.
  fittedDistance(rssi) {
    if (!this.isCalibrated() || rssi == null || typeof rssi !== 'number' || rssi >= 0) return null;
    if (rssi > this.A) {
      const sub = 1.0 - ((rssi - this.A) * 0.05);
      return sub < 0.3 ? 0.3 : sub;
    }
    const d = Math.pow(10, (this.A - rssi) / (10 * this.n));
    return d > 30 ? 30 : d;
  }

  // Restore a persisted curve (server restart).
  restore(data) {
    if (!data || data.A == null || data.n == null) return false;
    if (!(data.A >= -70 && data.A <= -25) || !(data.n >= 1.5 && data.n <= 4.0)) return false;
    this.A = data.A;
    this.n = data.n;
    this.points = data.points || {};
    this.status = 'CALIBRATED';
    return true;
  }

  clear() {
    this.points = {};
    this.A = null;
    this.n = null;
    this.status = 'IDLE';
    this.capture = null;
    return { cleared: true };
  }

  getState() {
    return {
      status: this.status,
      calibrated: this.isCalibrated(),
      reference_link: this.referenceLink,
      points: this.points && Object.keys(this.points).length ? this.points : null,
      A: this.A,
      n: this.n,
      capture: this.isCapturing()
        ? {
            point: this.capture.point,
            distance_m: this.capture.distance_m,
            samples: this.capture.samples.length
          }
        : null
    };
  }
}
