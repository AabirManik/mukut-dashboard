/**
 * MUKUT Trajectory Engine (Phase 5 — Route Mapping)
 * Fuses pedestrian dead reckoning (heading + distance walked) with anchor
 * beacon ranges (distance to fixed relay nodes) into a live 2D trajectory.
 *
 * Map frame: metres. x = deeper into the tunnel, y = lateral (right bend positive).
 * Heading convention: degrees, 0 = +x, increasing toward +y (counter-clockwise).
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
    const n = polyline.length;
    const last = polyline[n - 1];
    const prev = polyline[n - 2];
    const dx = last.x - prev.x;
    const dy = last.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    polyline.push({ x: last.x + (dx / len) * faceExt, y: last.y + (dy / len) * faceExt });
  }

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

    this.geo = computeTunnelGeometry(this.config);
    this.reset();
  }

  reset() {
    this.position = null;
    this.heading = null;
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
    const motion = (telemetry && telemetry.motion) || {};
    const orient = (telemetry && telemetry.orientation) || {};
    const anchors = this.collectAnchors(telemetry);
    this.lastAnchors = anchors;

    let heading = typeof orient.heading === 'number' && Number.isFinite(orient.heading) ? orient.heading : null;
    if (heading != null) heading = (heading + this.headingOffset + 360000) % 360;

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

    if (this.position == null) {
      if (anchors.length >= 3) {
        const solved = trilaterate(anchors, { x: 0, y: 0 });
        if (Number.isFinite(solved.x) && Number.isFinite(solved.y) && Math.hypot(solved.x, solved.y) < 500) {
          this.position = solved;
        }
      }
      if (this.position == null) this.position = { x: 0, y: 0 };
      this.position = this.clampToCorridor(this.position);
      this.enteredTunnel = this.projectOntoPolyline(this.position).arc > this.surfaceThreshold;
      this.pushWaypoint(now);
    }

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

    if (anchors.length >= 3) {
      const solved = trilaterate(anchors, this.position);
      if (Number.isFinite(solved.x) && Number.isFinite(solved.y)) {
        const offset = Math.hypot(solved.x - this.position.x, solved.y - this.position.y);
        if (offset < 200) {
          let k = this.correctionStrength;
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

    this.position = this.clampToCorridor(this.position);

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
