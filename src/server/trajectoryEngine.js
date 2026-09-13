/**
 * MUKUT Trajectory Engine (Phase 5 / v3 — Route Mapping)
 * Fuses pedestrian dead reckoning (magnetometer heading + accelerometer step
 * odometry, both fetched from the helmet) with anchor beacon ranges into a
 * live 2D trajectory. Anchor ranges are the ML-calculated distances
 * (stateManager.enrichAnchorsWithML) with raw relay ranges as fallback.
 *
 * Map frame: metres. x = deeper into the tunnel, y = lateral (right side
 * positive when walking in). Heading convention (v3 — tunnel-relative,
 * CLOCKWISE, matching the helmet's compass-style QMC5883L output read against
 * the tunnel axis): 0° = walking deeper in (+x), 90° = right turn (+y),
 * 180° = back toward the entrance, 270° = left turn. `heading_offset_deg`
 * (or the SET HEADING runtime control) aligns whatever the magnetometer
 * currently reports as "forward" with 0°.
 * Tunnel polyline is derived from node map_pos entries + a working-face extension.
 */

export function computeTunnelGeometry(config) {
  const netNodes = (config && config.network && Array.isArray(config.network.nodes)) ? config.network.nodes : [];
  const anchors = [];
  for (const n of netNodes) {
    if (n.map_pos && typeof n.map_pos.x === 'number' && typeof n.map_pos.y === 'number' && Number.isFinite(n.map_pos.x) && Number.isFinite(n.map_pos.y)) {
      anchors.push({ id: n.id, x: n.map_pos.x, y: n.map_pos.y });
    }
  }

  const trajCfg = (config && config.trajectory) || {};
  const faceExt = typeof trajCfg.face_extension_m === 'number' && trajCfg.face_extension_m > 0 ? trajCfg.face_extension_m : 18;

  const relay = ['NODE01', 'NODE02', 'NODE03'].map(id => anchors.find(a => a.id === id)).filter(Boolean);
  const polyline = relay.map(a => ({ x: a.x, y: a.y }));
  if (polyline.length >= 2) {
    extendPolyline(polyline, faceExt);
  }

  return finishGeometry(anchors, polyline);
}

// v4: extend the polyline beyond its last point (working-face direction).
function extendPolyline(polyline, ext) {
  const n = polyline.length;
  const last = polyline[n - 1];
  const prev = polyline[n - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  polyline.push({ x: last.x + (dx / len) * ext, y: last.y + (dy / len) * ext });
}

function finishGeometry(anchors, polyline) {
  const cumulative = [0];
  for (let i = 1; i < polyline.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y));
  }
  return {
    anchors,
    polyline,
    cumulative,
    totalLength: cumulative.length ? cumulative[cumulative.length - 1] : 0
  };
}

// v4: DYNAMIC map geometry — builds the node layout from the MEASURED
// inter-node distances instead of the preset config map_pos values, so the
// map reflects where the nodes are physically placed.
//   NODE01 at the origin (surface reference), NODE02 along +x at d12,
//   NODE03 trilaterated from (d12, d23, d13) onto the +y side (right bend).
// The face extension is capped relative to the real scale so a small physical
// layout does not get an oversized narrative tail.
export function buildGeometryFromDistances(d12, d23, d13, faceExtCfg) {
  if (![d12, d23, d13].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    return null;
  }
  // NODE03: classic two-anchor circle intersection
  let x3 = (d12 * d12 + d13 * d13 - d23 * d23) / (2 * d12);
  // clamp inside the corridor span & keep the triangle non-degenerate
  x3 = Math.max(0.05 * d12, Math.min(0.95 * d12, x3));
  const y3 = Math.sqrt(Math.max(d13 * d13 - x3 * x3, Math.pow(0.1 * d13, 2)));

  const anchors = [
    { id: 'NODE01', x: 0, y: 0 },
    { id: 'NODE02', x: d12, y: 0 },
    { id: 'NODE03', x: Number(x3.toFixed(3)), y: Number(y3.toFixed(3)) }
  ];
  const polyline = anchors.map(a => ({ x: a.x, y: a.y }));
  const ext = Math.min(faceExtCfg, Math.max(2, (d12 + d23) * 0.5));
  extendPolyline(polyline, ext);
  return finishGeometry(anchors, polyline);
}

function trilaterate(anchorSet, guess) {
  let px = guess.x;
  let py = guess.y;
  for (let iter = 0; iter < 6; iter++) {
    let hxx = 0, hyy = 0, hxy = 0, gx = 0, gy = 0;
    for (const a of anchorSet) {
      const dx = px - a.x;
      const dy = py - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.01) { px += 0.01; continue; }
      const r = d - a.distance;
      const jx = dx / d;
      const jy = dy / d;
      hxx += jx * jx;
      hyy += jy * jy;
      hxy += jx * jy;
      gx += jx * r;
      gy += jy * r;
    }
    const det = hxx * hyy - hxy * hxy;
    if (Math.abs(det) < 1e-6) break;
    const stepX = -(hyy * gx - hxy * gy) / det;
    const stepY = -(-hxy * gx + hxx * gy) / det;
    px += stepX;
    py += stepY;
    if (Math.hypot(stepX, stepY) < 0.01) break;
  }
  return { x: px, y: py };
}

export class TrajectoryEngine {
  constructor(config) {
    this.config = config || {};
    const t = this.config.trajectory || {};
    this.strideLength = t.stride_length_m > 0 ? t.stride_length_m : 0.75;
    this.waypointInterval = t.waypoint_interval_m > 0 ? t.waypoint_interval_m : 2.0;
    this.maxWaypoints = t.max_waypoints > 0 ? t.max_waypoints : 600;
    this.correctionStrength = typeof t.correction_strength === 'number' ? t.correction_strength : 0.15;
    this.resyncThreshold = typeof t.resync_threshold_m === 'number' ? t.resync_threshold_m : 25;
    this.corridorWidth = typeof t.corridor_width_m === 'number' ? t.corridor_width_m : 8;
    this.surfaceThreshold = typeof t.surface_threshold_m === 'number' ? t.surface_threshold_m : 10;
    this.headingOffset = typeof t.heading_offset_deg === 'number' ? t.heading_offset_deg : 0;
    this.faceExtCfg = t.face_extension_m > 0 ? t.face_extension_m : 18;

    // v6: motion-agnostic correction — with no step displacement this update,
    // beacons are the only motion signal, so the anchor correction is more
    // assertive than the gentle drift-correct blend used while walking.
    this.correctionStrengthAgnostic = typeof t.correction_strength_agnostic === 'number' && t.correction_strength_agnostic > 0
      ? t.correction_strength_agnostic : 0.35;
    // v6: proximity pull — the strongest beacon signal within this radius of a
    // node pulls the map toward that node when the fused position disagrees.
    this.proximityRadius = typeof t.proximity_radius_m === 'number' && t.proximity_radius_m > 0
      ? t.proximity_radius_m : 5;
    this.proximityMismatch = typeof t.proximity_mismatch_m === 'number' && t.proximity_mismatch_m >= 0
      ? t.proximity_mismatch_m : 1;
    this.proximityMaxPull = typeof t.proximity_max_pull === 'number' && t.proximity_max_pull > 0 && t.proximity_max_pull <= 1
      ? t.proximity_max_pull : 0.65;

    // v4: dynamic map calibration — an 8 s ceremony (matching the firmware's
    // ANCHOR_CAL_SILENCE_MS boot window) that samples the measured inter-node
    // distances, averages them ONCE, rebuilds the map geometry from the real
    // node placement, and locks it. Locked geometry survives resets and
    // (via stateManager) server restarts.
    this.mapCalDurationMs = t.map_calibration_ms > 0 ? t.map_calibration_ms : 8000;
    this.mapCal = { status: 'IDLE', startedAt: null, samples: { n1_n2: [], n2_n3: [], n1_n3: [] } };
    this.geometrySource = 'preset';
    this.measuredDistances = null;
    this.geometryLockedAt = null;

    // v6: tracking session — START TRACKING opens a fresh session (path
    // cleared, position re-fixed from beacons); STOP TRACKING freezes the
    // trajectory. Default ON preserves the always-on demo behaviour.
    this.trackingSession = { active: true, startedAt: null };
    this.proximity = null;        // engaged proximity lock {id, distance_m, pull}
    this.lastProximityId = null;  // event de-dup across packets

    this.geo = computeTunnelGeometry(this.config);
    this.reset();
  }

  reset() {
    this.position = null;
    this.heading = null;
    this.lastRawHeading = null;
    this.path = [];
    this.distanceWalked = 0;
    this.lastWalkedInput = null;
    this.lastStepInput = null;
    this.moving = false;
    this.speedMps = 0;
    this.lastUpdateMs = null;
    this.sinceLastWaypoint = 0;
    this.enteredTunnel = false;
    this.resyncFlagged = false;
    this.lastAnchors = [];
    this.anchorEma = {};
    this.distanceFromSurface = null;
  }

  projectOntoPolyline(p) {
    const pts = this.geo.polyline;
    if (pts.length < 2) return { arc: 0, point: { x: p.x, y: p.y }, dist: 0 };
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, ay = pts[i].y;
      const bx = pts[i + 1].x, by = pts[i + 1].y;
      const segX = bx - ax, segY = by - ay;
      const segLen = Math.hypot(segX, segY) || 1;
      let tSeg = ((p.x - ax) * segX + (p.y - ay) * segY) / (segLen * segLen);
      tSeg = Math.max(0, Math.min(1, tSeg));
      const cx = ax + segX * tSeg;
      const cy = ay + segY * tSeg;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      if (!best || dist < best.dist) {
        best = { arc: this.geo.cumulative[i] + tSeg * segLen, point: { x: cx, y: cy }, dist };
      }
    }
    return best;
  }

  clampToCorridor(p) {
    if (this.geo.polyline.length < 2 || this.corridorWidth <= 0) return p;
    const proj = this.projectOntoPolyline(p);
    if (proj.dist <= this.corridorWidth) return p;
    const scale = this.corridorWidth / proj.dist;
    return {
      x: proj.point.x + (p.x - proj.point.x) * scale,
      y: proj.point.y + (p.y - proj.point.y) * scale
    };
  }

  // v3: solve an anchor set — Gauss-Newton trilateration for 3+ ranges,
  // two-circle intersection for exactly 2. `ref` seeds the solver and breaks
  // the two-candidate ambiguity (nearest candidate wins); when null (first
  // fix) the corridor-preferred candidate is chosen.
  solveAnchors(anchors, ref) {
    if (!Array.isArray(anchors) || anchors.length >= 3) {
      return Array.isArray(anchors) && anchors.length >= 3
        ? trilaterate(anchors, ref || { x: 0, y: 0 })
        : null;
    }
    if (anchors.length === 2) return this.solveTwoAnchors(anchors[0], anchors[1], ref);
    return null;
  }

  // v3: two-circle intersection. Non-intersecting circles (range error) fall
  // back to the point on the line of centres at the a-range proportion.
  solveTwoAnchors(a, b, ref) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6 || !(a.distance > 0) || !(b.distance > 0)) return null;
    if (a.distance + b.distance < d || Math.abs(a.distance - b.distance) > d) {
      const t = Math.max(0, Math.min(1, a.distance / d));
      return { x: a.x + dx * t, y: a.y + dy * t };
    }
    const aa = (a.distance * a.distance - b.distance * b.distance + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.distance * a.distance - aa * aa));
    const mx = a.x + (aa / d) * dx;
    const my = a.y + (aa / d) * dy;
    const c1 = { x: mx + (h / d) * dy, y: my - (h / d) * dx };
    const c2 = { x: mx - (h / d) * dy, y: my + (h / d) * dx };
    if (!ref) {
      return this.projectOntoPolyline(c1).dist <= this.projectOntoPolyline(c2).dist ? c1 : c2;
    }
    return Math.hypot(c1.x - ref.x, c1.y - ref.y) <= Math.hypot(c2.x - ref.x, c2.y - ref.y) ? c1 : c2;
  }

  // v3: SET HEADING runtime calibration — the miner faces "into the tunnel"
  // (+x) and the control is pressed: whatever the magnetometer reports right
  // now becomes the new zero. Runtime-only (config heading_offset_deg remains
  // the boot default); effective from the next telemetry packet.
  setHeadingZero() {
    if (this.lastRawHeading == null) {
      return { success: false, error: 'No magnetometer heading received yet' };
    }
    this.headingOffset = (360 - this.lastRawHeading) % 360;
    return {
      success: true,
      raw_heading_deg: this.lastRawHeading,
      heading_offset_deg: this.headingOffset,
      applied_heading_deg: 0
    };
  }

  // ── v6: tracking session ────────────────────────────────────────────────────

  // Open a fresh tracking session: breadcrumb path cleared, position re-fixed
  // from the next packet's beacons. From then on the route draws itself as the
  // miner moves — step odometry when present, beacon signal (anchor correction
  // + proximity pull) when the accelerometer data is absent or unreliable.
  startTracking() {
    this.trackingSession = { active: true, startedAt: Date.now() };
    this.path = [];
    this.sinceLastWaypoint = 0;
    this.position = null;
    this.anchorEma = {};
    return { active: true, started_at: this.trackingSession.startedAt };
  }

  // Freeze the trajectory: position and path stop updating. Heading capture,
  // odometer baselines and the map calibration ceremony keep running so a
  // later resume is seamless and SET HEADING still works while paused.
  stopTracking() {
    this.trackingSession = { active: false, startedAt: null };
    return { active: false };
  }

  // ── v4: dynamic map calibration ────────────────────────────────────────────

  // Start the 8 s ceremony. Keep all nodes stationary while it runs — the
  // measured inter-node distances are averaged once and locked at the end.
  startMapCalibration() {
    if (this.mapCal.status === 'RUNNING') {
      return { started: false, reason: 'map calibration already running' };
    }
    this.mapCal = { status: 'RUNNING', startedAt: Date.now(), samples: { n1_n2: [], n2_n3: [], n1_n3: [] } };
    return { started: true, duration_ms: this.mapCalDurationMs };
  }

  // Discard the locked geometry and return to the preset config layout.
  clearMapCalibration() {
    this.mapCal = { status: 'IDLE', startedAt: null, samples: { n1_n2: [], n2_n3: [], n1_n3: [] } };
    this.geometrySource = 'preset';
    this.measuredDistances = null;
    this.geometryLockedAt = null;
    this.geo = computeTunnelGeometry(this.config);
    this.reset();
    return { cleared: true };
  }

  // Apply a previously persisted locked geometry (server restart).
  applyLockedGeometry(distances, lockedAt) {
    if (!distances) return false;
    const geo = buildGeometryFromDistances(
      distances.n1_n2_m, distances.n2_n3_m, distances.n1_n3_m, this.faceExtCfg
    );
    if (!geo) return false;
    this.geo = geo;
    this.mapCal.status = 'LOCKED';
    this.geometrySource = 'calibrated';
    this.measuredDistances = { ...distances };
    this.geometryLockedAt = lockedAt || Date.now();
    return true;
  }

  sampleMeshGeometry(telemetry) {
    const mg = telemetry && telemetry.mesh_geometry;
    if (!mg) return;
    const take = (key, v) => {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        this.mapCal.samples[key].push(v);
        if (this.mapCal.samples[key].length > 200) this.mapCal.samples[key].shift();
      }
    };
    take('n1_n2', mg.n1_n2_m);
    take('n2_n3', mg.n2_n3_m);
    take('n1_n3', mg.n1_n3_m);
  }

  // Average the sampled inter-node distances, rebuild the geometry from the
  // REAL node placement, lock it, reset the trajectory (fresh fix in the new
  // frame), and persist via the stateManager hook.
  finalizeMapCalibration(stateManager) {
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const d12 = avg(this.mapCal.samples.n1_n2);
    const d23 = avg(this.mapCal.samples.n2_n3);
    const d13 = avg(this.mapCal.samples.n1_n3);
    const lock = () => {
      const distances = {
        n1_n2_m: Number(d12.toFixed(2)),
        n2_n3_m: Number(d23.toFixed(2)),
        n1_n3_m: Number(d13.toFixed(2))
      };
      if (!this.applyLockedGeometry(distances, Date.now())) return false;
      this.reset(); // fresh fix in the new frame on this same update
      if (stateManager) {
        stateManager.addEvent('INFO',
          `Map geometry LOCKED from measured placement — N1↔N2 ${distances.n1_n2_m} m · N2↔N3 ${distances.n2_n3_m} m · N1↔N3 ${distances.n1_n3_m} m`);
        if (typeof stateManager.saveMapGeometry === 'function') {
          stateManager.saveMapGeometry({ distances, locked_at: this.geometryLockedAt });
        }
      }
      return true;
    };
    if (d12 != null && d23 != null && d13 != null) {
      if (lock()) return { locked: true, distances: this.measuredDistances };
    }
    this.mapCal = { status: 'IDLE', startedAt: null, samples: { n1_n2: [], n2_n3: [], n1_n3: [] } };
    if (stateManager) {
      stateManager.addEvent('WARNING',
        'Map calibration failed — no inter-node distance samples received (check that the gateway reports node ranges)');
    }
    return { locked: false };
  }

  collectAnchors(telemetry) {
    const list = Array.isArray(telemetry && telemetry.anchors) ? telemetry.anchors : [];
    const out = [];
    for (const a of list) {
      const node = this.geo.anchors.find(n => n.id === a.id);
      if (node && typeof a.distance === 'number' && Number.isFinite(a.distance) && a.distance > 0) {
        out.push({ id: a.id, x: node.x, y: node.y, distance: a.distance });
      }
    }
    return out;
  }

  update(telemetry, stateManager) {
    const now = Date.now();

    // v4: map calibration sampling — runs BEFORE anchor collection so a
    // just-locked geometry is already in effect for this update's first fix.
    if (this.mapCal.status === 'RUNNING') {
      this.sampleMeshGeometry(telemetry);
      if (now - this.mapCal.startedAt >= this.mapCalDurationMs) {
        this.finalizeMapCalibration(stateManager);
      }
    }

    const rawMotion = telemetry && telemetry.motion;
    const motion = rawMotion || {};
    const orient = (telemetry && telemetry.orientation) || {};
    const anchors = this.collectAnchors(telemetry);

    // v6: motion-agnostic mode — the packet carries no accelerometer data at
    // all; position then follows the beacon signal alone (anchor correction +
    // proximity pull) and the "moving" flag is derived from map displacement.
    const motionAbsent = rawMotion == null ||
      (motion.moving == null && motion.distance_walked_m == null && motion.step_count == null);

    // v3: EMA-smooth the anchor ranges (per anchor id) — raw per-poll ranges
    // (ML or relay) jitter and would wobble the fused position. An anchor that
    // drops out of this packet resets its state.
    // v6: STEP DETECTION — a range that jumps abruptly (> 3 m or half the
    // previous value) is genuine movement, not jitter: re-seed instead of
    // smoothing, so walking close to a node engages the proximity pull on the
    // very next packet instead of ~7 packets of EMA lag.
    const seen = new Set();
    for (const a of anchors) {
      seen.add(a.id);
      const prev = this.anchorEma[a.id];
      if (prev != null) {
        const step = Math.abs(a.distance - prev);
        a.distance = step > Math.max(3, prev * 0.5)
          ? a.distance
          : prev + (a.distance - prev) * 0.35;
      }
      this.anchorEma[a.id] = a.distance;
    }
    for (const id of Object.keys(this.anchorEma)) {
      if (!seen.has(id)) delete this.anchorEma[id];
    }
    this.lastAnchors = anchors;

    let heading = typeof orient.heading === 'number' && Number.isFinite(orient.heading) ? orient.heading : null;
    if (heading != null) {
      this.lastRawHeading = heading;
      heading = (heading + this.headingOffset + 360000) % 360;
    }

    let delta = 0;
    if (typeof motion.distance_walked_m === 'number' && Number.isFinite(motion.distance_walked_m)) {
      if (this.lastWalkedInput != null) {
        delta = Math.max(0, motion.distance_walked_m - this.lastWalkedInput);
      }
      this.lastWalkedInput = motion.distance_walked_m;
    } else if (typeof motion.step_count === 'number' && Number.isFinite(motion.step_count)) {
      if (this.lastStepInput != null) {
        delta = Math.max(0, motion.step_count - this.lastStepInput) * this.strideLength;
      }
      this.lastStepInput = motion.step_count;
    }
    this.moving = Boolean(motion.moving) || delta > 0.01;

    // v6: tracking session gate — while paused the trajectory is frozen, but
    // heading capture, odometer baselines and the map calibration ceremony
    // keep running so a resume is seamless.
    if (!this.trackingSession.active) {
      this.moving = false;
      return;
    }

    if (this.position == null) {
      // v3: 3+ ranges → trilateration; exactly 2 → circle intersection
      // (corridor-preferred candidate). Fewer than 2 → surface default.
      const solved = this.solveAnchors(anchors, null);
      if (solved && Number.isFinite(solved.x) && Number.isFinite(solved.y) && Math.hypot(solved.x, solved.y) < 500) {
        this.position = solved;
      }
      if (this.position == null) this.position = { x: 0, y: 0 };
      this.position = this.clampToCorridor(this.position);
      this.enteredTunnel = this.projectOntoPolyline(this.position).arc > this.surfaceThreshold;
      this.pushWaypoint(now);
    }

    // v6: position BEFORE this update's movement — its total displacement
    // (DR + anchor correction + proximity pull) drives waypoint growth when
    // the movement is beacon-driven rather than step-driven.
    const prevPos = this.position ? { x: this.position.x, y: this.position.y } : null;

    if (delta > 0 && heading != null) {
      const rad = heading * Math.PI / 180;
      this.position = {
        x: this.position.x + delta * Math.cos(rad),
        y: this.position.y + delta * Math.sin(rad)
      };
      this.distanceWalked += delta;
      this.sinceLastWaypoint += delta;
    }
    if (heading != null) this.heading = heading;

    // v3: anchor correction also engages with exactly 2 ranges (the deep-tunnel
    // norm: helmet near N2/N3, direct N1 range too weak) — the two-circle
    // solver picks the candidate nearest the current position for continuity.
    if (anchors.length >= 2) {
      const solved = this.solveAnchors(anchors, this.position);
      if (solved && Number.isFinite(solved.x) && Number.isFinite(solved.y)) {
        const offset = Math.hypot(solved.x - this.position.x, solved.y - this.position.y);
        if (offset < 200) {
          // v6: with no step displacement this update (stationary, or no
          // accelerometer data at all), the beacons are the only motion
          // signal — correct more assertively so the position tracks
          // signal-driven movement.
          let k = delta > 0 ? this.correctionStrength : this.correctionStrengthAgnostic;
          if (offset > this.resyncThreshold) {
            k = 0.5;
            if (!this.resyncFlagged && stateManager) {
              stateManager.addEvent('INFO', 'Route position resynchronized against relay beacons');
              this.resyncFlagged = true;
            }
          } else {
            this.resyncFlagged = false;
          }
          this.position = {
            x: this.position.x + (solved.x - this.position.x) * k,
            y: this.position.y + (solved.y - this.position.y) * k
          };
        }
      }
    }

    // ── v6: proximity pull ────────────────────────────────────────────────────
    // When the STRONGEST beacon signal says the helmet is within
    // proximity_radius_m of its node but the fused position DISAGREES (the
    // geometric distance to that node is far larger than the measured range),
    // the map is pulled toward the node. The mismatch gate keeps accurate
    // trilateration untouched — proximity only fixes signal-vs-map
    // disagreement, which is exactly the close-node inaccuracy case.
    this.proximity = null;
    if (anchors.length > 0 && this.position != null) {
      let best = null;
      for (const a of anchors) {
        if (a.distance > 0 && a.distance < this.proximityRadius && (!best || a.distance < best.distance)) {
          best = a;
        }
      }
      if (best) {
        const geoDist = Math.hypot(this.position.x - best.x, this.position.y - best.y);
        const mismatch = geoDist - best.distance;
        if (mismatch > this.proximityMismatch) {
          const closeness = 1 - best.distance / this.proximityRadius;
          const mismatchFactor = Math.min(1, mismatch / this.proximityRadius);
          const pull = Math.min(this.proximityMaxPull, closeness * this.proximityMaxPull * mismatchFactor);
          this.position = {
            x: this.position.x + (best.x - this.position.x) * pull,
            y: this.position.y + (best.y - this.position.y) * pull
          };
          this.proximity = {
            id: best.id,
            distance_m: Number(best.distance.toFixed(1)),
            pull: Number(pull.toFixed(2))
          };
          if (this.lastProximityId !== best.id && stateManager) {
            stateManager.addEvent('INFO', `Proximity lock — ${best.id} beacon signal ${best.distance.toFixed(1)} m: route position snapped toward the relay`);
          }
          this.lastProximityId = best.id;
        } else {
          this.lastProximityId = null;
        }
      } else {
        this.lastProximityId = null;
      }
    }

    this.position = this.clampToCorridor(this.position);

    // v6: unified displacement — beacon/proximity-driven movement (beyond the
    // step-odometry delta already counted) also grows the breadcrumb, so the
    // route draws itself even with no accelerometer data. In motion-agnostic
    // mode, real map displacement also raises the moving flag.
    if (prevPos) {
      const moved = Math.hypot(this.position.x - prevPos.x, this.position.y - prevPos.y);
      if (moved > delta) this.sinceLastWaypoint += moved - delta;
      if (motionAbsent && moved > 0.3) this.moving = true;
    }

    if (this.sinceLastWaypoint >= this.waypointInterval) {
      this.pushWaypoint(now);
      this.sinceLastWaypoint = 0;
    }

    if (this.lastUpdateMs != null) {
      const dt = Math.max(0.001, (now - this.lastUpdateMs) / 1000);
      this.speedMps = this.speedMps * 0.6 + (delta / dt) * 0.4;
    }
    this.lastUpdateMs = now;

    const arc = this.projectOntoPolyline(this.position).arc;
    this.distanceFromSurface = arc;
    if (stateManager) {
      if (!this.enteredTunnel && arc > this.surfaceThreshold) {
        this.enteredTunnel = true;
        stateManager.addEvent('INFO', 'Miner entered underground tunnel — route tracking active');
      } else if (this.enteredTunnel && arc < this.surfaceThreshold) {
        this.enteredTunnel = false;
        stateManager.addEvent('INFO', 'Miner returned to surface station');
      }
    }
  }

  pushWaypoint(t) {
    if (this.position == null) return;
    this.path.push({ x: Number(this.position.x.toFixed(2)), y: Number(this.position.y.toFixed(2)), t });
    if (this.path.length > this.maxWaypoints) this.path.shift();
  }

  getState() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x, y) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const a of this.geo.anchors) consider(a.x, a.y);
    for (const w of this.path) consider(w.x, w.y);
    if (this.position) consider(this.position.x, this.position.y);
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 10; maxY = 10; }
    const pad = 12;

    return {
      tracking: this.position != null,
      position: this.position
        ? { x: Number(this.position.x.toFixed(2)), y: Number(this.position.y.toFixed(2)), heading: this.heading }
        : null,
      path: this.path,
      distance_from_surface_m: this.distanceFromSurface != null ? Number(this.distanceFromSurface.toFixed(1)) : null,
      distance_walked_m: Number(this.distanceWalked.toFixed(1)),
      speed_mps: Number(this.speedMps.toFixed(2)),
      moving: this.moving,
      session: {
        active: this.trackingSession.active,
        started_at: this.trackingSession.startedAt
      },
      proximity: this.proximity,
      heading_offset_deg: this.headingOffset,
      raw_heading_deg: this.lastRawHeading,
      geometry: {
        source: this.geometrySource,
        calibrating: this.mapCal.status === 'RUNNING',
        locked_at: this.geometryLockedAt,
        nodes: this.geo.anchors.map(a => ({ id: a.id, x: a.x, y: a.y })),
        distances: this.measuredDistances
          ? {
              n1_n2_m: this.measuredDistances.n1_n2_m,
              n2_n3_m: this.measuredDistances.n2_n3_m,
              n1_n3_m: this.measuredDistances.n1_n3_m
            }
          : null
      },
      tunnel: this.geo.polyline,
      anchors: this.lastAnchors.map(a => ({ id: a.id, x: a.x, y: a.y, distance: Number(a.distance.toFixed(1)) })),
      bounds: {
        min_x: Number((minX - pad).toFixed(1)),
        min_y: Number((minY - pad).toFixed(1)),
        max_x: Number((maxX + pad).toFixed(1)),
        max_y: Number((maxY + pad).toFixed(1))
      },
      waypoint_count: this.path.length
    };
  }
}
