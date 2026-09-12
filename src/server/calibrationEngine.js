/**
 * MUKUT Calibration Engine (Phase 6 — RSSI Distance Calibration)
 * Converts live RSSI into estimated distances via a configurable path-loss
 * model, and runs a calibration ceremony (one sampling window per RSSI-bearing
 * link) that LOCKS fixed distances for every dashboard.
 *
 * Distance layer semantics:
 *   LOCKED → link/spatial/anchor distances = frozen calibrated values
 *   IDLE   → distances = pathLoss(rssi), EMA-smoothed (steady real-time)
 *   no RSSI (trunk) → incoming distance untouched
 *
 * The trajectory engine always consumes RAW telemetry — locked values are a
 * display layer only, so miner tracking keeps working while distances are fixed.
 */

export class CalibrationEngine {
  constructor(config) {
    this.config = config || {};
    const c = this.config.calibration || {};
    this.sampleWindowMs = (c.sample_window_s > 0 ? c.sample_window_s : 5) * 1000;

    const pl = c.path_loss || {};
    this.refRssi1m = typeof pl.ref_rssi_1m === 'number' ? pl.ref_rssi_1m : -55;
    this.exponentN = pl.exponent_n > 0 ? pl.exponent_n : 2.8;
    this.emaAlpha = (typeof c.smoothing_ema === 'number' && c.smoothing_ema > 0 && c.smoothing_ema <= 1)
      ? c.smoothing_ema
      : 0.25;

    this.status = 'IDLE'; // IDLE | RUNNING | LOCKED
    this.phases = [];
    this.activePhaseIdx = -1;
    this.lockedAt = null;
    this.locked = {}; // linkId -> { rssi_avg, distance }
    this.ema = {};    // linkId -> smoothed live distance
    this.mlDistances = {}; // linkId -> { distance, method, snr, defaultSnr, inRange }
  }

  rssiToDistance(rssi) {
    return Math.pow(10, (this.refRssi1m - rssi) / (10 * this.exponentN));
  }

  clampDistance(d) {
    return Math.min(200, Math.max(0.5, d));
  }

  start(stateManager) {
    if (this.status === 'RUNNING') {
      return { started: false, reason: 'calibration already running' };
    }
    const links = (stateManager && Array.isArray(stateManager.links)) ? stateManager.links : [];
    this.phases = links
      .filter(l => l.rssi != null && !l.hide_metrics)
      .map(l => ({ linkId: l.id, label: `${l.source}→${l.destination}`, startedAt: Date.now(), samples: [] }));
    if (this.phases.length === 0) {
      return { started: false, reason: 'no RSSI-bearing links to calibrate' };
    }
    this.status = 'RUNNING';
    this.activePhaseIdx = 0;
    this.locked = {};
    this.lockedAt = null;
    if (stateManager) {
      stateManager.addEvent('INFO', `Distance calibration started — sampling ${this.phases.length} links, ${this.sampleWindowMs / 1000} s each`);
    }
    return { started: true, phases: this.phases.length };
  }

  clear(stateManager) {
    this.status = 'IDLE';
    this.phases = [];
    this.activePhaseIdx = -1;
    this.locked = {};
    this.lockedAt = null;
    if (stateManager) {
      stateManager.addEvent('INFO', 'Distance calibration cleared — live RSSI-derived distances active');
    }
  }

  reset() {
    this.clear(null);
  }

  // Sample raw telemetry while RUNNING; advance phases on window expiry.
  collect(telemetry, stateManager) {
    if (this.status !== 'RUNNING') return;
    const phase = this.phases[this.activePhaseIdx];
    if (!phase) return;

    const links = (telemetry && telemetry.network && Array.isArray(telemetry.network.links)) ? telemetry.network.links : [];
    const match = links.find(l => l.id === phase.linkId && l.rssi != null);
    if (match) phase.samples.push(match.rssi);

    if (Date.now() - phase.startedAt >= this.sampleWindowMs) {
      this.closePhase(phase, stateManager);
      this.activePhaseIdx++;
      if (this.activePhaseIdx >= this.phases.length) {
        this.status = 'LOCKED';
        this.lockedAt = Date.now();
        if (stateManager) {
          stateManager.addEvent('INFO', `Distance calibration LOCKED — ${Object.keys(this.locked).length} link distances fixed across all dashboards`);
        }
      } else {
        this.phases[this.activePhaseIdx].startedAt = Date.now();
      }
    }
  }

  closePhase(phase, stateManager) {
    if (phase.samples.length === 0) {
      if (stateManager) {
        stateManager.addEvent('WARNING', `Calibration window for ${phase.label} received no RSSI samples — skipped`);
      }
      return;
    }
    const avg = phase.samples.reduce((a, b) => a + b, 0) / phase.samples.length;
    const dist = Number(this.clampDistance(this.rssiToDistance(avg)).toFixed(1));
    this.locked[phase.linkId] = { rssi_avg: Number(avg.toFixed(1)), distance: dist };
    if (stateManager) {
      stateManager.addEvent('INFO', `Link ${phase.label} calibrated: avg ${Number(avg.toFixed(1))} dBm → ${dist} m (fixed)`);
    }
  }

  setMLDistances(mlMap) {
    this.mlDistances = mlMap || {};
  }

  // Display distance for a link: locked value, else ML model, else live path-loss (EMA), else original.
  // The trunk uplink (NODE02—NODE01) carries no metrics by design — telemetry
  // links from the simulator lack the hide_metrics flag, so guard by id too
  // (same convention as the client renderers).
  displayDistance(link) {
    if (this.status === 'LOCKED' && this.locked[link.id]) {
      return this.locked[link.id].distance;
    }
    // An offline link must never show a model-derived "live" distance
    if (link.status === 'DISCONNECTED' || link.available === false) {
      return link.distance;
    }
    // A live gateway-computed distance always takes priority over the ONNX
    // estimate: field captures (test/hw_live.log) show the model saturating at
    // 1–2 m across the measured -40…-79 dBm band while the gateway distance
    // changes with physical movement. ONNX remains the fallback for links
    // that report RSSI but no distance.
    if (link.distance != null && Number.isFinite(link.distance) && link.distance > 0) {
      return Number(link.distance.toFixed(1));
    }
    if (link.rssi != null && !link.hide_metrics && link.id !== 'link_node02_node01') {
      const ml = this.mlDistances[link.id];
      if (ml && ml.distance != null && ml.method === 'ml') {
        return this.clampDistance(ml.distance);
      }
      const raw = this.clampDistance(this.rssiToDistance(link.rssi));
      const prev = this.ema[link.id];
      const smoothed = prev == null ? raw : prev + (raw - prev) * this.emaAlpha;
      this.ema[link.id] = smoothed;
      return Number(smoothed.toFixed(1));
    }
    return link.distance;
  }

  applyToLinks(links) {
    if (!Array.isArray(links)) return links;
    return links.map(l => ({ ...l, distance: this.displayDistance(l) }));
  }

  anchorDisplay(anchor) {
    const linkId = { NODE01: 'link_helmet_node01', NODE02: 'link_helmet_node02', NODE03: 'link_helmet_node03' }[anchor.id];
    if (linkId && this.status === 'LOCKED' && this.locked[linkId]) {
      return this.locked[linkId].distance;
    }
    return anchor.distance;
  }

  getState() {
    let progress = null;
    if (this.status === 'RUNNING') {
      const phase = this.phases[this.activePhaseIdx];
      if (phase) {
        const elapsedMs = Math.min(this.sampleWindowMs, Math.max(0, Date.now() - phase.startedAt));
        progress = {
          link: phase.label,
          link_id: phase.linkId,
          phase: this.activePhaseIdx + 1,
          total_phases: this.phases.length,
          elapsed_s: Number((elapsedMs / 1000).toFixed(1)),
          remaining_s: Number(((this.sampleWindowMs - elapsedMs) / 1000).toFixed(1)),
          samples: phase.samples.length
        };
      }
    }
    return {
      status: this.status,
      progress,
      locked_at: this.lockedAt,
      locked: this.locked,
      window_s: this.sampleWindowMs / 1000
    };
  }
}
