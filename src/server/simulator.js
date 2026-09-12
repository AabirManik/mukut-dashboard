/**
 * MUKUT Telemetry & Network Simulator
 * Produces realistic environmental and network telemetry matching the MUKUT data contract.
 * Topology: HELMET01 -> NODE03 -> (NODE02 or NODE01) -> NODE01
 * Route mapping: a scripted miner journey walks the tunnel polyline and emits
 * motion / orientation / anchor-range blocks for the trajectory engine.
 */

import { computeTunnelGeometry } from './trajectoryEngine.js';

export class TelemetrySimulator {
  constructor(stateManager, intervalMs = 2000) {
    this.stateManager = stateManager;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.currentScenario = 'NORMAL';
    this.isRunning = false;

    // Environmental baseline values
    this.values = {
      temperature: 30.2,
      humidity: 68.0,
      methane: 0.22,
      carbon_monoxide: 16.0,
      smoke: 52.0,
      sos: false
    };

    // Network baseline values (4 links: chain HELMET01->NODE03->NODE02->NODE01 + bypass NODE03->NODE01)
    this.networkLinks = {
      link_helmet_node03: { rssi: -61, distance: 18, status: 'CONNECTED', available: true },
      link_node03_node02: { rssi: -70, distance: 35, status: 'CONNECTED', available: true },
      link_node02_node01: { rssi: -68, distance: 52, status: 'CONNECTED', available: true },
      link_node03_node01: { rssi: -79, distance: 64, status: 'CONNECTED', available: true }
    };

    // Route mapping: miner journey along the tunnel polyline (map frame from config)
    const simConfig = (stateManager && typeof stateManager.getConfig === 'function') ? stateManager.getConfig() : {};
    this.geo = computeTunnelGeometry(simConfig);
    this.geoValid = this.geo.polyline.length >= 2;
    this.walkSpeed = (simConfig.trajectory && simConfig.trajectory.sim_walk_speed_mps) || 1.5;
    this.journeyMode = 'STATIONARY';
    this.minerArc = this.geoValid ? this.geo.totalLength : 0;
    this.minerSway = 0;
    this.minerMoving = false;
    this.distanceWalkedTotal = 0;
  }

  walk(current, min, max, maxStep, decimals = 1) {
    const delta = (Math.random() * 2 - 1) * maxStep;
    let next = current + delta;
    if (next < min) next = min + Math.abs(delta);
    if (next > max) next = max - Math.abs(delta);
    return Number(next.toFixed(decimals));
  }

  updateValuesForScenario() {
    switch (this.currentScenario) {
      case 'NORMAL':
      case 'NETWORK_NORMAL':
      case 'MINER_WALK_IN':
      case 'MINER_WALK_OUT':
      case 'MINER_STATIONARY':
        this.values.temperature = this.walk(this.values.temperature, 28.5, 33.0, 0.15, 1);
        this.values.humidity = this.walk(this.values.humidity, 64.0, 74.0, 0.4, 0);
        this.values.methane = this.walk(this.values.methane, 0.12, 0.38, 0.02, 2);
        this.values.carbon_monoxide = this.walk(this.values.carbon_monoxide, 10.0, 24.0, 0.8, 1);
        this.values.smoke = this.walk(this.values.smoke, 40.0, 85.0, 1.5, 1);
        this.values.sos = false;

        this.networkLinks.link_helmet_node03.rssi = Math.round(this.walk(this.networkLinks.link_helmet_node03.rssi, -65, -58, 0.8, 0));
        this.networkLinks.link_helmet_node03.status = 'CONNECTED';

        this.networkLinks.link_node03_node02.rssi = Math.round(this.walk(this.networkLinks.link_node03_node02.rssi, -74, -66, 0.8, 0));
        this.networkLinks.link_node03_node02.status = 'CONNECTED';

        this.networkLinks.link_node02_node01.rssi = Math.round(this.walk(this.networkLinks.link_node02_node01.rssi, -71, -65, 0.8, 0));
        this.networkLinks.link_node02_node01.status = 'CONNECTED';

        this.networkLinks.link_node03_node01.rssi = Math.round(this.walk(this.networkLinks.link_node03_node01.rssi, -83, -76, 0.8, 0));
        this.networkLinks.link_node03_node01.status = 'CONNECTED';
        break;

      case 'WEAK_LINK':
        this.networkLinks.link_helmet_node03.rssi = Math.round(this.walk(this.networkLinks.link_helmet_node03.rssi, -89, -86, 0.8, 0)); // WEAK
        break;

      case 'NODE02_OFFLINE':
        this.networkLinks.link_node03_node02.status = 'DISCONNECTED';
        this.networkLinks.link_node03_node02.available = false;
        this.networkLinks.link_node02_node01.status = 'DISCONNECTED';
        this.networkLinks.link_node02_node01.available = false;
        break;
      
      case 'NODE03_OFFLINE':
        break;
        
      case 'NO_ROUTE':
        this.networkLinks.link_node03_node02.status = 'DISCONNECTED';
        this.networkLinks.link_node03_node02.available = false;
        this.networkLinks.link_node02_node01.status = 'DISCONNECTED';
        this.networkLinks.link_node02_node01.available = false;
        this.networkLinks.link_node03_node01.status = 'DISCONNECTED';
        this.networkLinks.link_node03_node01.available = false;
        break;

      case 'GAS_WARNING':
        this.values.methane = this.walk(this.values.methane, 320, 450, 5, 0);
        break;

      case 'GAS_CRITICAL':
        this.values.methane = this.walk(this.values.methane, 650, 850, 10, 0);
        break;

      case 'SOS':
        this.values.sos = true;
        break;

      default:
        break;
    }
  }

  polylinePos(arc) {
    const pts = this.geo.polyline;
    const cum = this.geo.cumulative;
    for (let i = 0; i < pts.length - 1; i++) {
      const segLen = cum[i + 1] - cum[i];
      if (arc <= cum[i + 1] || i === pts.length - 2) {
        const t = segLen > 0 ? Math.max(0, Math.min(1, (arc - cum[i]) / segLen)) : 0;
        return {
          x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
          y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
          heading: (Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) * 180 / Math.PI + 360) % 360
        };
      }
    }
    return { x: pts[0].x, y: pts[0].y, heading: 0 };
  }

  distToNode(px, py, id) {
    const a = this.geo.anchors.find(n => n.id === id);
    return a ? Math.hypot(px - a.x, py - a.y) : null;
  }

  stepJourney(dtSec) {
    if (!this.geoValid || this.journeyMode === 'STATIONARY') {
      this.minerMoving = false;
      return;
    }
    const target = this.journeyMode === 'IN' ? this.geo.totalLength : 0;
    const remaining = target - this.minerArc;
    if (Math.abs(remaining) < 0.05) {
      this.journeyMode = 'STATIONARY';
      this.minerMoving = false;
      return;
    }
    const dir = Math.sign(remaining);
    const jitter = 0.85 + Math.random() * 0.3;
    const step = Math.min(Math.abs(remaining), this.walkSpeed * dtSec * jitter);
    this.minerArc += dir * step;
    this.distanceWalkedTotal += step;
    this.minerMoving = true;
    this.minerSway = Math.max(-0.3, Math.min(0.3, this.minerSway + (Math.random() - 0.5) * 0.15));
    if (Math.abs(target - this.minerArc) < 0.05) {
      this.journeyMode = 'STATIONARY';
    }
  }

  resetJourney() {
    this.journeyMode = 'STATIONARY';
    this.minerArc = this.geoValid ? this.geo.totalLength : 0;
    this.minerSway = 0;
    this.minerMoving = false;
    this.distanceWalkedTotal = 0;
  }

  generatePacket() {
    this.updateValuesForScenario();

    let mapPayload = null;
    if (this.geoValid) {
      const pos = this.polylinePos(this.minerArc);
      const swayRad = (pos.heading + 90) * Math.PI / 180;
      const px = pos.x + Math.cos(swayRad) * this.minerSway;
      const py = pos.y + Math.sin(swayRad) * this.minerSway;
      const headingNoise = this.minerMoving ? (Math.random() - 0.5) * 6 : 0;
      const heading = (pos.heading + headingNoise + 360) % 360;

      const d3 = this.distToNode(px, py, 'NODE03');
      if (d3 != null) {
        this.networkLinks.link_helmet_node03.distance = Number(d3.toFixed(1));
        if (this.currentScenario !== 'WEAK_LINK') {
          this.networkLinks.link_helmet_node03.rssi = Math.round(Math.max(-90, Math.min(-45, -61 - 20 * Math.log10(Math.max(1, d3) / 18))));
        }
      }

      const a1 = this.distToNode(px, py, 'NODE01');
      const a2 = this.distToNode(px, py, 'NODE02');
      mapPayload = {
        motion: {
          moving: this.minerMoving,
          step_count: Math.round(this.distanceWalkedTotal / 0.75),
          distance_walked_m: Number(this.distanceWalkedTotal.toFixed(1))
        },
        orientation: { heading: Number(heading.toFixed(1)) },
        anchors: [
          { id: 'NODE01', distance: Number(a1.toFixed(1)) },
          { id: 'NODE02', distance: Number(a2.toFixed(1)) },
          { id: 'NODE03', distance: Number(d3.toFixed(1)) }
        ]
      };
    }

    const linksList = [
      { id: 'link_helmet_node03', source: 'HELMET01', destination: 'NODE03', ...this.networkLinks.link_helmet_node03 },
      { id: 'link_node03_node02', source: 'NODE03', destination: 'NODE02', ...this.networkLinks.link_node03_node02 },
      { id: 'link_node02_node01', source: 'NODE02', destination: 'NODE01', ...this.networkLinks.link_node02_node01 },
      { id: 'link_node03_node01', source: 'NODE03', destination: 'NODE01', ...this.networkLinks.link_node03_node01 }
    ];

    return {
      version: "1.0",
      helmet_id: this.stateManager.helmetId || "HELMET01",
      timestamp: Math.floor(Date.now() / 1000),
      environment: {
        temperature: this.values.temperature,
        humidity: this.values.humidity,
        methane: this.values.methane,
        carbon_monoxide: this.values.carbon_monoxide,
        smoke: this.values.smoke
      },
      safety: {
        sos: this.values.sos
      },
      ...(mapPayload || {}),
      network: {
        connected_node: 'NODE03',
        links: linksList
      }
    };
  }

  tick() {
    if (this.currentScenario === 'HELMET_OFFLINE') {
      return;
    }

    this.stepJourney(this.intervalMs / 1000);
    const packet = this.generatePacket();
    this.stateManager.processTelemetry(packet);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setScenario(scenario) {
    const validScenarios = [
      'NORMAL', 'GAS_WARNING', 'GAS_CRITICAL', 'SOS', 'HELMET_OFFLINE', 'RESET',
      'NETWORK_NORMAL', 'WEAK_LINK', 'NODE02_OFFLINE', 'NODE03_FAILURE', 'NO_ROUTE', 'NODE02_RESTORE', 'RESET_NETWORK',
      'MINER_WALK_IN', 'MINER_WALK_OUT', 'MINER_STATIONARY'
    ];
    if (!validScenarios.includes(scenario)) {
      throw new Error(`Invalid scenario "${scenario}". Must be one of: ${validScenarios.join(', ')}`);
    }

    if (scenario === 'RESET' || scenario === 'RESET_NETWORK' || scenario === 'NORMAL' || scenario === 'NETWORK_NORMAL' || scenario === 'NODE02_RESTORE') {
      this.currentScenario = 'NORMAL';
      this.values = {
        temperature: 30.2, humidity: 68.0, methane: 0.22, carbon_monoxide: 16.0, smoke: 52.0, sos: false
      };
      this.networkLinks = {
        link_helmet_node03: { rssi: -61, distance: 18, status: 'CONNECTED', available: true },
        link_node03_node02: { rssi: -70, distance: 35, status: 'CONNECTED', available: true },
        link_node02_node01: { rssi: -68, distance: 52, status: 'CONNECTED', available: true },
        link_node03_node01: { rssi: -79, distance: 64, status: 'CONNECTED', available: true }
      };
      this.resetJourney();
      // If restore, we set node online explicitly
      if (scenario === 'NODE02_RESTORE') {
          this.stateManager.setNodeStatus('NODE02', 'ONLINE');
      } else {
          this.stateManager.reset();
      }
      this.tick();
    } else if (scenario === 'NODE02_OFFLINE') {
      this.currentScenario = scenario;
      this.stateManager.setNodeStatus('NODE02', 'OFFLINE');
      this.updateValuesForScenario();
    } else if (scenario === 'NODE03_FAILURE') {
      this.currentScenario = scenario;
      this.stateManager.setNodeStatus('NODE03', 'OFFLINE');
      this.updateValuesForScenario();
    } else if (scenario === 'NO_ROUTE') {
      this.currentScenario = scenario;
      this.stateManager.setNodeStatus('NODE03', 'OFFLINE');
      this.stateManager.setNodeStatus('NODE02', 'OFFLINE');
      this.updateValuesForScenario();
    } else if (scenario === 'MINER_WALK_IN') {
      this.currentScenario = scenario;
      this.journeyMode = 'IN';
      this.tick();
    } else if (scenario === 'MINER_WALK_OUT') {
      this.currentScenario = scenario;
      this.journeyMode = 'OUT';
      this.tick();
    } else if (scenario === 'MINER_STATIONARY') {
      this.currentScenario = scenario;
      this.journeyMode = 'STATIONARY';
      this.minerMoving = false;
    } else {
      this.currentScenario = scenario;
      if (scenario !== 'HELMET_OFFLINE') {
        this.tick();
      }
    }

    this.stateManager.addEvent('INFO', `Simulator mode set to: ${this.currentScenario}`);
    return {
      scenario: this.currentScenario,
      isRunning: this.isRunning
    };
  }

  getScenario() {
    return {
      scenario: this.currentScenario,
      isRunning: this.isRunning,
      currentValues: this.values,
      networkLinks: this.networkLinks,
      journey: {
        mode: this.journeyMode,
        arc_m: this.geoValid ? Number(this.minerArc.toFixed(1)) : null,
        distance_walked_m: Number(this.distanceWalkedTotal.toFixed(1))
      }
    };
  }
}
