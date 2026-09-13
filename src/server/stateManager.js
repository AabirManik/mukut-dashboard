import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TrajectoryEngine } from './trajectoryEngine.js';
import { CalibrationEngine } from './calibrationEngine.js';
import { MLEstimator } from './mlEstimator.js';
import { SignalFilter } from './signalFilter.js';
import { RangeCalibrator } from './rangeCalibrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '../../config/default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

export class StateManager {
  constructor(customConfig = null) {
    this.config = customConfig || config;
    this.helmetId = this.config.helmet.default_id;
    this.online = false;
    this.lastSeen = null;
    this.status = 'SAFE';
    this.statusReason = 'System initialized — awaiting telemetry';
    this.sos = false;

    this.environment = {
      temperature: 28.5,
      humidity: 65.0,
      methane: 0.15,
      carbon_monoxide: 12.0,
      smoke: 45.0
    };

    this.gasStatus = {
      overall: 'NORMAL',
      methane: { value: 0.15, status: 'NORMAL', percentage: 5 },
      carbon_monoxide: { value: 12.0, status: 'NORMAL', percentage: 6 },
      smoke: { value: 45.0, status: 'NORMAL', percentage: 9 }
    };

    this.tempStatus = 'NORMAL';
    this.humidityStatus = 'NORMAL';
    this.events = [];
    this.listeners = [];

    this.structuralHealth = {
      node2: { status: 'STABLE', level: 0, online: true },
      node3: { status: 'STABLE', level: 0, online: true }
    };
    this.spatialPosition = {
      nearest_node: 'NODE03',
      relative_slider_pct: 50.0,
      dist_n2: -1.0,
      dist_n3: -1.0,
      fixed_dist: 3.5
    };
    this.activeAlerts = [];
    this.activeEmergencies = [];

    // Phase 5: Route mapping trajectory engine — must exist BEFORE initNetworkState,
    // because the initial route calculation broadcasts a full state snapshot.
    this.trajectoryEngine = new TrajectoryEngine(this.config);

    // Phase 6: RSSI distance calibration engine (same pre-init requirement)
    this.calibrationEngine = new CalibrationEngine(this.config);

    // Phase 7: ML distance estimator (ONNX Random Forest — async init)
    this.mlEstimator = new MLEstimator();
    this.mlEstimator.init().catch(err => {
      console.error('[ML] Estimator init failed:', err.message);
    });

    // Phase 8: Temporal median filter for RSSI/SNR before ML inference
    this.signalFilter = new SignalFilter(this.config);

    // v5: two-point range calibrator — fits the real path-loss curve from two
    // known helmet placements; the fitted curve then drives every distance.
    this.rangeCalibrator = new RangeCalibrator(this.config);
    this.rangeCalibrator.onEvent = (severity, message) => this.addEvent(severity, message);
    this.rangeCalibrator.onLock = (data) => this.saveRangeCal(data);

    // v4/v5: persisted calibrations (locked map geometry + fitted range curve)
    // restore ONLY in live hardware modes — a simulator session must never
    // inherit live-hardware calibrations (keeps simulator demos/tests on the
    // preset narrative geometry, deterministic regardless of leftover files).
    const persistentLiveMode = ['node1', 'node1_wifi', 'hardware', 'serial']
      .includes((this.config.hardware && this.config.hardware.data_source) || '');
    if (persistentLiveMode) {
      const savedGeo = this._loadMapGeometry();
      if (savedGeo && savedGeo.distances
          && this.trajectoryEngine.applyLockedGeometry(savedGeo.distances, savedGeo.locked_at)) {
        this.events.unshift({
          id: `evt_geo_${Date.now()}`,
          timestamp: Date.now(),
          timeStr: new Date().toTimeString().split(' ')[0],
          severity: 'INFO',
          message: `Calibrated map geometry restored (locked ${new Date(savedGeo.locked_at || Date.now()).toLocaleTimeString()})`
        });
      }
      const savedRC = this._loadRangeCal();
      if (savedRC && this.rangeCalibrator.restore(savedRC)) {
        this.calibrationEngine.disableHelmetOffset = true;
      }
    }

    // Phase 2 + Phase 3A: Network & Route State Initialization
    this.initNetworkState();

    // Add initial event
    this.addEvent('INFO', 'MUKUT Safety & Network Monitoring System initialized');

    // Start background heartbeat watchdog
    this.watchdogInterval = setInterval(() => {
      this.checkWatchdog();
    }, 1000);
  }

  initNetworkState() {
    const netConfig = this.config.network || {};
    this.nodes = (netConfig.nodes || []).map(n => ({ ...n, available: n.available !== false }));
    this.links = (netConfig.default_links || []).map(l => {
      const evalRssi = this.evaluateRssi(l.rssi);
      return {
        ...l,
        quality: evalRssi.quality,
        percentage: evalRssi.percentage,
        available: l.available !== false
      };
    });
    this.connectedNode = 'NODE03';
    this.networkHealth = 'GOOD';
    
    // Phase 3A: Route State
    this.currentRoute = [];
    this.previousRoute = [];
    this.routeStatus = 'NORMAL'; // NORMAL | FAILOVER | NO_ROUTE
    this.failoverActive = false;
    this.failedNode = null;
    
    // Perform initial route calculation
    this.recalculateRoute('Initialization');
  }

  getConfig() {
    return this.config;
  }

  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notifyListeners(type = 'STATE_UPDATE', payload = null) {
    const fullState = this.getFullState();
    const message = {
      type,
      payload: payload || fullState,
      timestamp: Date.now()
    };
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        console.error('Error in state listener:', err);
      }
    }
  }

  addEvent(severity, message) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      timestamp: Date.now(),
      timeStr,
      severity, // 'INFO' | 'WARNING' | 'EMERGENCY'
      message
    };

    this.events.unshift(event);
    if (this.events.length > 50) {
      this.events.pop();
    }

    this.notifyListeners('EVENT', event);
    return event;
  }

  evaluateGasLevel(gasKey, value) {
    const threshold = this.config.thresholds[gasKey];
    if (!threshold) return { status: 'NORMAL', percentage: 0 };

    let status = 'NORMAL';
    if (value >= threshold.critical) {
      status = 'CRITICAL';
    } else if (value >= threshold.warning) {
      status = 'WARNING';
    }

    const percentage = Math.min(100, Math.max(0, (value / threshold.max_scale) * 100));
    return {
      name: threshold.name,
      formula: threshold.formula,
      value: Number(value.toFixed(threshold.decimals)),
      unit: threshold.unit,
      status,
      percentage: Number(percentage.toFixed(1))
    };
  }

  evaluateRssi(rssi) {
    const thresh = this.config.network?.rssi_thresholds || {
      excellent: -65,
      good: -75,
      fair: -85,
      min_dbm: -110,
      max_dbm: -40
    };

    let quality = 'WEAK';
    if (rssi >= thresh.excellent) {
      quality = 'EXCELLENT';
    } else if (rssi >= thresh.good) {
      quality = 'GOOD';
    } else if (rssi >= thresh.fair) {
      quality = 'FAIR';
    }

    const minDbm = thresh.min_dbm || -110;
    const maxDbm = thresh.max_dbm || -40;
    const clamped = Math.max(minDbm, Math.min(maxDbm, rssi));
    const percentage = Math.round(((clamped - minDbm) / (maxDbm - minDbm)) * 100);

    return { quality, percentage };
  }

  calculateNetworkHealth() {
    const helmetNode = this.nodes.find(n => n.id === 'HELMET01');
    const rootNode = this.nodes.find(n => n.id === 'NODE01');

    if (helmetNode?.status === 'OFFLINE' || rootNode?.status === 'OFFLINE') {
      return 'OFFLINE';
    }

    const hasOfflineNode = this.nodes.some(n => n.status === 'OFFLINE' && n.id !== 'HELMET01');
    const hasDegradedLink = this.links.some(l => l.quality === 'WEAK' || l.status === 'DISCONNECTED');

    if (hasOfflineNode || hasDegradedLink) {
      return 'DEGRADED';
    }

    return 'GOOD';
  }

  // Phase 3A: Graph Pathfinding
  findAllPaths(source, destination) {
    let paths = [];
    let queue = [[source]];
    
    while(queue.length > 0) {
      let path = queue.shift();
      let current = path[path.length - 1];
      
      if(current === destination) {
        paths.push(path);
        continue;
      }
      
      for(let link of this.links) {
        if(!link.available || link.status === 'DISCONNECTED' || link.status === 'OFFLINE') continue;
        
        let neighbor = null;
        if(link.source === current) neighbor = link.destination;
        else if(link.destination === current) neighbor = link.source;
        
        if(neighbor) {
          let node = this.nodes.find(n => n.id === neighbor);
          // A node must be ONLINE and available to be part of a path
          if(node && node.status !== 'OFFLINE' && node.available !== false && !path.includes(neighbor)) {
            queue.push([...path, neighbor]);
          }
        }
      }
    }
    return paths;
  }

  calculatePathCost(path) {
    let cost = 0;
    for(let i = 0; i < path.length - 1; i++) {
      let u = path[i];
      let v = path[i+1];
      let link = this.links.find(l => (l.source === u && l.destination === v) || (l.source === v && l.destination === u));
      if(link) {
        cost += 1; // Base hop cost
        // Penalize poor quality links heavily to ensure deterministic routing
        if (link.quality === 'EXCELLENT') cost += 10;
        else if (link.quality === 'GOOD') cost += 50;
        else if (link.quality === 'FAIR') cost += 1000;
        else if (link.quality === 'WEAK') cost += 5000;
        else cost += 10000;
      }
    }
    return cost;
  }

  findRoute(source, destination) {
    const paths = this.findAllPaths(source, destination);
    if(paths.length === 0) return [];
    
    let bestPath = paths[0];
    let bestCost = this.calculatePathCost(paths[0]);
    
    for(let i = 1; i < paths.length; i++) {
      let cost = this.calculatePathCost(paths[i]);
      if(cost < bestCost) {
        bestCost = cost;
        bestPath = paths[i];
      }
    }
    
    return bestPath;
  }

  recalculateRoute(reason = null) {
    const newRoute = this.findRoute('HELMET01', 'NODE01');
    
    // Check if route changed
    const currentRouteStr = this.currentRoute.join('->');
    const newRouteStr = newRoute.join('->');
    
    if(currentRouteStr !== newRouteStr) {
      this.previousRoute = [...this.currentRoute];
      this.currentRoute = newRoute;
      
      // Determine Status
      if(newRoute.length === 0) {
        this.routeStatus = 'NO_ROUTE';
        this.failoverActive = false;
        this.addEvent('EMERGENCY', `Communication path unavailable! (Reason: ${reason || 'Network change'})`);
      } else {
        // Did we lose a node that was in our previous route?
        const lostNode = this.previousRoute.find(n => !newRoute.includes(n) && n !== 'HELMET01' && n !== 'NODE01');
        
        // Define normal expected route for the new topology
        const normalRouteStr = 'HELMET01->NODE03->NODE02->NODE01';
        
        if (newRouteStr === normalRouteStr) {
          this.routeStatus = 'NORMAL';
          this.failoverActive = false;
          this.failedNode = null;
          if (this.previousRoute.length > 0) {
            this.addEvent('INFO', `Primary network route restored.`);
          }
        } else {
          this.routeStatus = 'FAILOVER';
          this.failoverActive = true;
          if (lostNode && this.nodes.find(n => n.id === lostNode && n.status === 'OFFLINE')) {
            this.failedNode = lostNode;
          }
          this.addEvent('WARNING', `NETWORK ROUTE CHANGED. Failover active. ${this.failedNode ? `Failed node: ${this.failedNode}` : ''}`);
        }
      }
      
      // Broadcast route change
      this.notifyListeners('ROUTE_CHANGED', {
        route: this.currentRoute,
        previous_route: this.previousRoute,
        status: this.routeStatus,
        failed_node: this.failedNode
      });
    }
  }

  updateNetworkTelemetry(linkUpdates) {
    const prevHealth = this.networkHealth;
    let topologyChanged = false;

    if (Array.isArray(linkUpdates)) {
      for (const update of linkUpdates) {
        let link = this.links.find(l => l.id === update.id || (l.source === update.source && l.destination === update.destination));
        if (link) {
          if (update.rssi !== undefined) {
            if (typeof update.rssi === 'number' && Number.isFinite(update.rssi)) {
              link.rssi = update.rssi;
              const evalRssi = this.evaluateRssi(link.rssi);
              link.quality = evalRssi.quality;
              link.percentage = evalRssi.percentage;
            } else {
              // No valid reading this packet — never fabricate quality
              // (evaluateRssi(null) would coerce null→0 and report "EXCELLENT").
              link.rssi = null;
              link.quality = 'N/A';
              link.percentage = null;
            }
          }
          if (update.distance !== undefined) {
            link.distance = update.distance;
          }
          if (update.snr !== undefined) {
            link.snr = update.snr;
          }
          if (update.status !== undefined && link.status !== update.status) {
            link.status = update.status;
            topologyChanged = true;
          }
          if (update.available !== undefined && link.available !== update.available) {
            link.available = update.available;
            topologyChanged = true;
          }
        } else {
          const hasRssi = typeof update.rssi === 'number' && Number.isFinite(update.rssi);
          const evalRssi = hasRssi ? this.evaluateRssi(update.rssi) : { quality: 'N/A', percentage: null };
          this.links.push({
            id: update.id || `link_${update.source}_${update.destination}`.toLowerCase(),
            source: update.source,
            destination: update.destination,
            rssi: hasRssi ? update.rssi : null,
            snr: update.snr !== undefined ? update.snr : null,
            distance: update.distance !== undefined ? update.distance : null,
            status: update.status || 'CONNECTED',
            available: update.available !== undefined ? update.available : true,
            quality: evalRssi.quality,
            percentage: evalRssi.percentage
          });
          topologyChanged = true;
        }
      }
    }

    this.networkHealth = this.calculateNetworkHealth();

    if (this.networkHealth !== prevHealth) {
      if (this.networkHealth === 'DEGRADED') {
        this.addEvent('WARNING', 'Underground network health degraded: weak link or offline relay detected');
      } else if (this.networkHealth === 'GOOD') {
        this.addEvent('INFO', 'Underground network health restored to GOOD');
      }
    }

    if (topologyChanged) {
      this.recalculateRoute('Link status changed');
    }

    this.notifyListeners('STATE_UPDATE', this.getFullState());
  }

  setNodeStatus(nodeId, status) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;

    const prevStatus = node.status;
    node.status = status;

    if (status === 'OFFLINE') {
      node.available = false;
      this.links.forEach(link => {
        if (link.source === nodeId || link.destination === nodeId) {
          link.status = 'DISCONNECTED';
          link.available = false;
        }
      });
      this.addEvent('WARNING', `Network Node ${nodeId} is now OFFLINE`);
    } else if (status === 'ONLINE' && prevStatus === 'OFFLINE') {
      node.available = true;
      this.links.forEach(link => {
        if (link.source === nodeId || link.destination === nodeId) {
          // Verify both endpoints are online before re-connecting
          const otherNodeId = link.source === nodeId ? link.destination : link.source;
          const otherNode = this.nodes.find(n => n.id === otherNodeId);
          if (otherNode && otherNode.status === 'ONLINE') {
            link.status = 'CONNECTED';
            link.available = true;
          }
        }
      });
      this.addEvent('INFO', `Network Node ${nodeId} restored to ONLINE`);
    }

    this.networkHealth = this.calculateNetworkHealth();
    this.recalculateRoute(`Node ${nodeId} changed to ${status}`);
    this.notifyListeners('STATE_UPDATE', this.getFullState());
  }

  async processTelemetry(telemetry) {
    const now = Date.now();
    const wasOnline = this.online;
    const prevStatus = this.status;
    const prevSos = this.sos;
    const prevGasOverall = this.gasStatus.overall;

    this.helmetId = telemetry.helmet_id || this.helmetId;
    this.lastSeen = now;
    
    // Only transition helmet to ONLINE if it wasn't already
    if (!this.online) {
      this.online = true;
      const helmetNode = this.nodes.find(n => n.id === 'HELMET01');
      if (helmetNode) {
        helmetNode.status = 'ONLINE';
        helmetNode.available = true;
      }
      this.addEvent('INFO', `Helmet ${this.helmetId} connection established`);
      this.recalculateRoute('Helmet online');
    }

    // Process environment
    if (telemetry.environment) {
      this.environment = {
        temperature: Number(telemetry.environment.temperature.toFixed(1)),
        humidity: Number(telemetry.environment.humidity.toFixed(1)),
        methane: Number(telemetry.environment.methane.toFixed(2)),
        carbon_monoxide: Number(telemetry.environment.carbon_monoxide.toFixed(1)),
        smoke: Number(telemetry.environment.smoke.toFixed(1))
      };
    }

    // Process gas states
    const ch4 = this.evaluateGasLevel('methane', this.environment.methane);
    const co = this.evaluateGasLevel('carbon_monoxide', this.environment.carbon_monoxide);
    const smoke = this.evaluateGasLevel('smoke', this.environment.smoke);

    let gasOverall = 'NORMAL';
    if (ch4.status === 'CRITICAL' || co.status === 'CRITICAL' || smoke.status === 'CRITICAL') {
      gasOverall = 'CRITICAL';
    } else if (ch4.status === 'WARNING' || co.status === 'WARNING' || smoke.status === 'WARNING') {
      gasOverall = 'WARNING';
    }

    this.gasStatus = {
      overall: gasOverall,
      methane: ch4,
      carbon_monoxide: co,
      smoke: smoke
    };

    // Temperature & Humidity evaluation
    const tempThresh = this.config.thresholds.temperature;
    if (this.environment.temperature >= tempThresh.critical) {
      this.tempStatus = 'CRITICAL';
    } else if (this.environment.temperature >= tempThresh.warning) {
      this.tempStatus = 'WARNING';
    } else {
      this.tempStatus = 'NORMAL';
    }

    const humThresh = this.config.thresholds.humidity;
    if (this.environment.humidity >= humThresh.critical) {
      this.humidityStatus = 'CRITICAL';
    } else if (this.environment.humidity >= humThresh.warning) {
      this.humidityStatus = 'WARNING';
    } else {
      this.humidityStatus = 'NORMAL';
    }

    // Process SOS
    this.sos = Boolean(telemetry.safety && telemetry.safety.sos);

    if (this.sos && !prevSos) {
      const assessment = this.computeCasualtyAssessment();
      const closestInfo = assessment.closest_node ? `Closest Extraction Station: ${assessment.closest_node.id} (${assessment.closest_node.distance_m != null ? `${assessment.closest_node.distance_m}m` : '--'}, RSSI: ${assessment.closest_node.rssi_dbm != null ? `${assessment.closest_node.rssi_dbm} dBm` : 'N/A'})` : 'SURFACE GATEWAY';
      const altNodes = assessment.active_nodes.filter(n => !assessment.closest_node || n.id !== assessment.closest_node.id).map(n => `${n.id}: ${n.distance_m != null ? `${n.distance_m}m` : '--'} (${n.rssi_dbm != null ? `${n.rssi_dbm} dBm` : 'N/A'})`).join(', ');
      this.addEvent('EMERGENCY', `🚨 [EMERGENCY SOS DISPATCH] Miner 01 pressed panic switch! ${closestInfo}${altNodes ? ` | Alt: ${altNodes}` : ''}`);
    } else if (!this.sos && prevSos) {
      this.addEvent('INFO', `SOS alert cleared on ${this.helmetId}`);
    }

    if (gasOverall === 'CRITICAL' && prevGasOverall !== 'CRITICAL') {
      this.addEvent('EMERGENCY', `EMERGENCY — Critical toxic/combustible gas levels detected!`);
    } else if (gasOverall === 'WARNING' && prevGasOverall === 'NORMAL') {
      this.addEvent('WARNING', `WARNING — Elevated gas concentration detected`);
    } else if (gasOverall === 'NORMAL' && prevGasOverall !== 'NORMAL') {
      this.addEvent('INFO', `Gas levels returned to NORMAL`);
    }

    if (this.sos) {
      this.status = 'EMERGENCY';
      this.statusReason = 'EMERGENCY — SOS alert manually activated by miner';
    } else if (gasOverall === 'CRITICAL' || this.tempStatus === 'CRITICAL') {
      this.status = 'EMERGENCY';
      this.statusReason = 'EMERGENCY — Hazardous underground atmosphere';
    } else if (gasOverall === 'WARNING' || this.tempStatus === 'WARNING' || this.humidityStatus === 'WARNING') {
      this.status = 'WARNING';
      this.statusReason = 'WARNING — Environmental parameters elevated above normal thresholds';
    } else {
      this.status = 'SAFE';
      this.statusReason = 'Nominal conditions — No emergency detected';
    }

    if (this.status !== prevStatus && !this.sos && !(this.sos && !prevSos)) {
      if (this.status === 'SAFE') {
        this.addEvent('INFO', `Worker status updated: SAFE`);
      } else if (this.status === 'WARNING') {
        this.addEvent('WARNING', `Worker status updated: WARNING`);
      } else if (this.status === 'EMERGENCY') {
        this.addEvent('EMERGENCY', `Worker status updated: EMERGENCY`);
      }
    }

    // Phase 6: calibration sampling on RAW telemetry (before display overrides)
    try {
      this.calibrationEngine.collect(telemetry, this);
    } catch (err) {
      console.error('Calibration engine error:', err);
    }

    // v5: two-point range calibration sampling (closes its own window) and
    // the display-offset gate — offsets only apply to the uncalibrated model.
    try {
      this.rangeCalibrator.sample(telemetry);
    } catch (err) {
      console.error('Range calibrator error:', err);
    }
    this.calibrationEngine.disableHelmetOffset = this.rangeCalibrator.isCalibrated();

    // v3: ML inference runs BEFORE the trajectory update — the user-validated
    // calculated distances then drive BOTH the display layer AND the route-map
    // anchor fusion (raw relay ranges stay as the per-anchor fallback).
    let mlMap = {};
    if (telemetry.network) {
      if (telemetry.network.connected_node) {
        this.connectedNode = telemetry.network.connected_node;
      }
      if (Array.isArray(telemetry.network.links)) {
        const links = telemetry.network.links;
        if (this.mlEstimator.isReady()) {
          const inferencePromises = links.map(async (link) => {
            if (link.rssi != null && link.status !== 'DISCONNECTED' && !link.hide_metrics && link.id !== 'link_node02_node01') {
              const rawRssi = link.rssi;
              const rawSnr = link.snr ?? null;

              this.signalFilter.push(link.id, rawRssi, rawSnr);
              const filtered = this.signalFilter.getFiltered(link.id);

              const result = await this.mlEstimator.estimateDistance(filtered.rssi, filtered.snr);
              result.rawRssi = rawRssi;
              result.rawSnr = rawSnr;
              result.filteredRssi = filtered.rssi;
              result.filteredSnr = filtered.snr;
              mlMap[link.id] = result;

              if (result.method === 'ml' && result.distance != null) {
                const snrInfo = result.defaultSnr ? ' (default SNR)' : '';
                console.log(`[ML] ${link.source}→${link.destination}: Raw RSSI=${rawRssi} SNR=${rawSnr} → Filtered RSSI=${filtered.rssi} SNR=${filtered.snr}${snrInfo} | ML=${result.distance} m`);
              }
            }
          });
          await Promise.all(inferencePromises);
          this.calibrationEngine.setMLDistances(mlMap);
        }
        this.updateNetworkTelemetry(this.calibrationEngine.applyToLinks(links));
      }
    }

    // Phase 5/v3: trajectory update — dead reckoning from the helmet IMU
    // (accelerometer step odometry + magnetometer heading), anchor fusion on
    // the ML-calculated distances (raw relay range as per-anchor fallback).
    // ML enrichment applies in LIVE hardware modes only — the model was
    // trained on live-helmet radio values; simulator-mode synthetic RSSI
    // would saturate it (1–2 m) and collapse the demo's narrative anchors.
    // v5: when a two-point range calibration is active, the bridge already
    // provides fitted-curve anchor distances (measured on the real hardware)
    // — the saturating ML estimate must not override them.
    const liveMode = ['node1', 'node1_wifi', 'hardware', 'serial']
      .includes((this.config.hardware && this.config.hardware.data_source) || '');
    const useMlAnchors = liveMode && !this.rangeCalibrator.isCalibrated();
    try {
      this.trajectoryEngine.update(useMlAnchors ? this.enrichAnchorsWithML(telemetry, mlMap) : telemetry, this);
    } catch (err) {
      console.error('Trajectory engine error:', err);
    }

    // Phase 6: spatial readouts follow the display distances (locked or live model)
    const helmetN3 = this.links.find(l => l.id === 'link_helmet_node03');
    const helmetN2 = this.links.find(l => l.id === 'link_helmet_node02');
    if (helmetN3 && helmetN3.distance != null) {
      this.spatialPosition.dist_n3 = Number(helmetN3.distance.toFixed(1));
    }
    if (helmetN2 && helmetN2.distance != null) {
      this.spatialPosition.dist_n2 = Number(helmetN2.distance.toFixed(1));
    }

    this.notifyListeners('STATE_UPDATE', this.getFullState());
    return this.getFullState();
  }

  checkWatchdog() {
    if (!this.online || !this.lastSeen) return;

    const timeout = this.config.helmet.offline_timeout_ms;
    const elapsed = Date.now() - this.lastSeen;

    if (elapsed > timeout) {
      this.online = false;
      const helmetNode = this.nodes.find(n => n.id === 'HELMET01');
      if (helmetNode) {
        helmetNode.status = 'OFFLINE';
        helmetNode.available = false;
      }

      this.links.forEach(l => {
        if (l.source === 'HELMET01' || l.destination === 'HELMET01') {
          l.status = 'DISCONNECTED';
          l.available = false;
        }
      });

      this.networkHealth = this.calculateNetworkHealth();
      this.addEvent('WARNING', `Helmet ${this.helmetId} connectivity lost (Offline timeout exceeded)`);
      this.recalculateRoute('Helmet offline timeout');
      this.notifyListeners('STATE_UPDATE', this.getFullState());
    }
  }

  reset() {
    this.online = true;
    this.lastSeen = Date.now();
    this.sos = false;
    this.status = 'SAFE';
    this.statusReason = 'Nominal conditions — No emergency detected';
    this.environment = {
      temperature: 29.2,
      humidity: 68.0,
      methane: 0.18,
      carbon_monoxide: 14.0,
      smoke: 48.0
    };
    this.gasStatus = {
      overall: 'NORMAL',
      methane: this.evaluateGasLevel('methane', 0.18),
      carbon_monoxide: this.evaluateGasLevel('carbon_monoxide', 14.0),
      smoke: this.evaluateGasLevel('smoke', 48.0)
    };
    this.tempStatus = 'NORMAL';
    this.humidityStatus = 'NORMAL';

    this.initNetworkState();
    this.trajectoryEngine.reset();
    this.calibrationEngine.reset();

    this.addEvent('INFO', 'System state reset to nominal');
    this.notifyListeners('STATE_UPDATE', this.getFullState());
  }

  computeCasualtyAssessment() {
    // 1. Gather all active nodes and their distances & RSSI to helmet
    const activeNodes = [];
    
    // Node 3
    const n3Node = this.nodes.find(n => n.id === 'NODE03');
    const n3Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE03') || (l.source === 'NODE03' && l.destination === 'HELMET01'));
    const n3Dist = this.spatialPosition.dist_n3 >= 0 ? this.spatialPosition.dist_n3 : (n3Link?.distance || null);
    const n3Rssi = this.spatialPosition.rssi_n3 != null ? this.spatialPosition.rssi_n3 : (n3Link ? n3Link.rssi : null);
    const n3Hazard = this.structuralHealth.node3?.status || 'STABLE';
    const n3Online = n3Node?.status === 'ONLINE';

    if (n3Online) {
      activeNodes.push({
        id: 'NODE03',
        name: 'Node 3 Working Face Access',
        distance_m: n3Dist != null ? Number(n3Dist.toFixed(1)) : null,
        rssi_dbm: n3Rssi,
        hazard: n3Hazard,
        status: n3Node.status
      });
    }

    // Node 2
    const n2Node = this.nodes.find(n => n.id === 'NODE02');
    const n2Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE02') || (l.source === 'NODE02' && l.destination === 'HELMET01'));
    const n2Dist = this.spatialPosition.dist_n2 >= 0 ? this.spatialPosition.dist_n2 : (n2Link?.distance || null);
    const n2Rssi = this.spatialPosition.rssi_n2 != null ? this.spatialPosition.rssi_n2 : (n2Link ? n2Link.rssi : null);
    const n2Hazard = this.structuralHealth.node2?.status || 'STABLE';
    const n2Online = n2Node?.status === 'ONLINE';

    if (n2Online) {
      activeNodes.push({
        id: 'NODE02',
        name: 'Node 2 Mid-Tunnel Relay',
        distance_m: n2Dist != null ? Number(n2Dist.toFixed(1)) : null,
        rssi_dbm: n2Rssi,
        hazard: n2Hazard,
        status: n2Node.status
      });
    }

    // Node 1 (Surface)
    const n1Node = this.nodes.find(n => n.id === 'NODE01');
    const n1Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE01') || (l.source === 'NODE01' && l.destination === 'HELMET01'));
    const n1Online = n1Node?.status === 'ONLINE';
    if (n1Online) {
      activeNodes.push({
        id: 'NODE01',
        name: 'Node 1 Surface Master Gateway',
        distance_m: n1Link?.distance != null ? n1Link.distance : null,
        rssi_dbm: n1Link ? n1Link.rssi : null,
        hazard: 'STABLE',
        status: 'ONLINE'
      });
    }

    // Find closest active node by distance (or RSSI if distance missing)
    let closestNode = null;
    if (activeNodes.length > 0) {
      closestNode = activeNodes.reduce((prev, curr) => {
        if (prev.distance_m != null && curr.distance_m != null) {
          return curr.distance_m < prev.distance_m ? curr : prev;
        }
        return curr.rssi_dbm > prev.rssi_dbm ? curr : prev;
      });
    }

    // Check active hazards (node tilt/vibrations)
    const hazards = [];
    if (this.structuralHealth.node2?.status === 'CRITICAL_HAZARD' || this.structuralHealth.node2?.status === 'WARNING_SHIFT') {
      hazards.push({
        node_id: 'NODE02',
        name: 'Node 2 Station',
        status: this.structuralHealth.node2.status,
        miner_distance_m: n2Dist != null ? Number(n2Dist.toFixed(1)) : null,
        rssi_dbm: n2Rssi
      });
    }
    if (this.structuralHealth.node3?.status === 'CRITICAL_HAZARD' || this.structuralHealth.node3?.status === 'WARNING_SHIFT') {
      hazards.push({
        node_id: 'NODE03',
        name: 'Node 3 Station',
        status: this.structuralHealth.node3.status,
        miner_distance_m: n3Dist != null ? Number(n3Dist.toFixed(1)) : null,
        rssi_dbm: n3Rssi
      });
    }

    return {
      has_incident: this.sos || hazards.length > 0,
      is_sos: this.sos,
      hazards,
      closest_node: closestNode,
      active_nodes: activeNodes,
      nearest_location_summary: closestNode ? `${closestNode.id} (${closestNode.distance_m != null ? `${closestNode.distance_m}m` : '--'}, ${closestNode.rssi_dbm != null ? `${closestNode.rssi_dbm} dBm` : 'N/A'})` : 'SURFACE ROOT'
    };
  }

  updateStructuralHealth(health) {
    if (!health) return;
    const prevN2 = this.structuralHealth.node2?.status;
    const prevN3 = this.structuralHealth.node3?.status;

    this.structuralHealth = { ...this.structuralHealth, ...health };

    const assessment = this.computeCasualtyAssessment();
    const closestSummary = assessment.closest_node ? `Nearest Active Rescue Node: ${assessment.closest_node.id} @ ${assessment.closest_node.distance_m != null ? `${assessment.closest_node.distance_m}m` : '--'} (${assessment.closest_node.rssi_dbm != null ? `${assessment.closest_node.rssi_dbm} dBm` : 'N/A'})` : 'Surface Gateway direct';

    if (health.node2?.status === 'CRITICAL_HAZARD' && prevN2 !== 'CRITICAL_HAZARD') {
      const distStr = this.spatialPosition.dist_n2 >= 0 ? `${this.spatialPosition.dist_n2.toFixed(1)}m` : '--';
      const n2Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE02') || (l.source === 'NODE02' && l.destination === 'HELMET01'));
      const rssiVal = this.spatialPosition.rssi_n2 != null ? this.spatialPosition.rssi_n2 : (n2Link ? n2Link.rssi : null);
      const rssiStr = rssiVal != null ? `${rssiVal} dBm` : 'N/A';
      this.addEvent('EMERGENCY', `🚨 [CRITICAL TILT/COLLAPSE] Node 2 Station has severe structural vibration/tilt! Miner location: ${distStr} from N2 (RSSI: ${rssiStr}). ${closestSummary}`);
    } else if (health.node2?.status === 'WARNING_SHIFT' && prevN2 !== 'WARNING_SHIFT') {
      const distStr = this.spatialPosition.dist_n2 >= 0 ? `${this.spatialPosition.dist_n2.toFixed(1)}m` : '--';
      const n2Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE02') || (l.source === 'NODE02' && l.destination === 'HELMET01'));
      const rssiVal = this.spatialPosition.rssi_n2 != null ? this.spatialPosition.rssi_n2 : (n2Link ? n2Link.rssi : null);
      const rssiStr = rssiVal != null ? `${rssiVal} dBm` : 'N/A';
      this.addEvent('WARNING', `⚠️ [STRUCTURAL WARNING] Node 2 Station minor shift/tilt detected. Miner is ${distStr} away (RSSI: ${rssiStr}). ${closestSummary}`);
    }

    if (health.node3?.status === 'CRITICAL_HAZARD' && prevN3 !== 'CRITICAL_HAZARD') {
      const distStr = this.spatialPosition.dist_n3 >= 0 ? `${this.spatialPosition.dist_n3.toFixed(1)}m` : '--';
      const n3Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE03') || (l.source === 'NODE03' && l.destination === 'HELMET01'));
      const rssiVal = this.spatialPosition.rssi_n3 != null ? this.spatialPosition.rssi_n3 : (n3Link ? n3Link.rssi : null);
      const rssiStr = rssiVal != null ? `${rssiVal} dBm` : 'N/A';
      this.addEvent('EMERGENCY', `🚨 [CRITICAL TILT/COLLAPSE] Node 3 Station has severe structural vibration/tilt! Miner location: ${distStr} from N3 (RSSI: ${rssiStr}). ${closestSummary}`);
    } else if (health.node3?.status === 'WARNING_SHIFT' && prevN3 !== 'WARNING_SHIFT') {
      const distStr = this.spatialPosition.dist_n3 >= 0 ? `${this.spatialPosition.dist_n3.toFixed(1)}m` : '--';
      const n3Link = this.links.find(l => (l.source === 'HELMET01' && l.destination === 'NODE03') || (l.source === 'NODE03' && l.destination === 'HELMET01'));
      const rssiVal = this.spatialPosition.rssi_n3 != null ? this.spatialPosition.rssi_n3 : (n3Link ? n3Link.rssi : null);
      const rssiStr = rssiVal != null ? `${rssiVal} dBm` : 'N/A';
      this.addEvent('WARNING', `⚠️ [STRUCTURAL WARNING] Node 3 Station minor shift/tilt detected. Miner is ${distStr} away (RSSI: ${rssiStr}). ${closestSummary}`);
    }
  }

  updateSpatialPosition(pos) {
    if (!pos) return;
    this.spatialPosition = { ...this.spatialPosition, ...pos };
  }

  setNode1Alerts(alerts, emergencies) {
    this.activeAlerts = alerts || [];
    this.activeEmergencies = emergencies || [];
  }

  applyCalibrationToRouteMap(routeMap) {
    if (!routeMap || !Array.isArray(routeMap.anchors) || routeMap.anchors.length === 0) return routeMap;
    routeMap.anchors = routeMap.anchors.map(a => ({ ...a, distance: this.calibrationEngine.anchorDisplay(a) }));
    return routeMap;
  }

  // v4: replace anchor ranges with the ML-calculated distances when available.
  // Per-anchor raw relay range stays the fallback (model not ready, inference
  // failed, or prediction outside the validated 1–20 m band).
  enrichAnchorsWithML(telemetry, mlMap) {
    const anchorLink = { NODE01: 'link_helmet_node01', NODE02: 'link_helmet_node02', NODE03: 'link_helmet_node03' };
    const anchors = Array.isArray(telemetry && telemetry.anchors) ? telemetry.anchors : null;
    if (!anchors || !mlMap || Object.keys(mlMap).length === 0) return telemetry;
    let changed = false;
    const enriched = anchors.map(a => {
      const linkId = anchorLink[a.id];
      const ml = linkId ? mlMap[linkId] : null;
      if (ml && ml.method === 'ml' && ml.distance != null && ml.distance > 0 && ml.inRange !== false) {
        changed = true;
        return { ...a, distance: ml.distance, source: 'ml' };
      }
      return a;
    });
    return changed ? { ...telemetry, anchors: enriched } : telemetry;
  }

  // ── v4: map geometry persistence ────────────────────────────────────────────

  _mapGeometryPath() {
    const t = this.config.trajectory || {};
    return t.map_geometry_file
      ? path.resolve(t.map_geometry_file)
      : path.resolve(__dirname, '../../config/map_geometry.json');
  }

  saveMapGeometry(data) {
    try {
      fs.writeFileSync(this._mapGeometryPath(), JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error('Map geometry save failed:', err.message);
      return false;
    }
  }

  clearMapGeometryFile() {
    try {
      const p = this._mapGeometryPath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return true;
    } catch (err) {
      console.error('Map geometry clear failed:', err.message);
      return false;
    }
  }

  _loadMapGeometry() {
    try {
      const p = this._mapGeometryPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.error('Map geometry load failed:', err.message);
    }
    return null;
  }

  // ── v5: range calibration persistence ───────────────────────────────────────

  _rangeCalPath() {
    const rc = this.config.range_calibration || {};
    return rc.file
      ? path.resolve(rc.file)
      : path.resolve(__dirname, '../../config/range_calibration.json');
  }

  saveRangeCal(data) {
    try {
      fs.writeFileSync(this._rangeCalPath(), JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      console.error('Range calibration save failed:', err.message);
      return false;
    }
  }

  clearRangeCalFile() {
    try {
      const p = this._rangeCalPath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return true;
    } catch (err) {
      console.error('Range calibration clear failed:', err.message);
      return false;
    }
  }

  _loadRangeCal() {
    try {
      const p = this._rangeCalPath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.error('Range calibration load failed:', err.message);
    }
    return null;
  }

  getFullState() {
    const elapsedSec = this.lastSeen ? Math.max(0, Math.floor((Date.now() - this.lastSeen) / 1000)) : null;
    const onlineNodesCount = this.nodes.filter(n => n.status === 'ONLINE').length;
    const totalNodesCount = this.nodes.length;
    const activeLinksCount = this.links.filter(l => l.status === 'CONNECTED').length;

    return {
      helmet_id: this.helmetId,
      online: this.online,
      last_seen: this.lastSeen,
      last_seen_seconds_ago: elapsedSec,
      status: this.status,
      status_reason: this.statusReason,
      sos: this.sos,
      environment: this.environment,
      gas_status: this.gasStatus,
      temp_status: this.tempStatus,
      humidity_status: this.humidityStatus,
      structural_health: this.structuralHealth,
      spatial_position: this.spatialPosition,
      casualty_assessment: this.computeCasualtyAssessment(),
      active_alerts: this.activeAlerts,
      active_emergencies: this.activeEmergencies,
      network: {
        health: this.networkHealth,
        connected_node: this.connectedNode,
        nodes: this.nodes,
        links: this.links,
        summary: {
          online_nodes_count: onlineNodesCount,
          total_nodes_count: totalNodesCount,
          active_links_count: activeLinksCount,
          helmet_connected: this.online
        },
        route: {
          current_route: this.currentRoute,
          previous_route: this.previousRoute,
          status: this.routeStatus,
          failover_active: this.failoverActive,
          failed_node: this.failedNode
        }
      },
      route_map: this.applyCalibrationToRouteMap(this.trajectoryEngine.getState()),
      calibration: this.calibrationEngine.getState(),
      range_cal: this.rangeCalibrator.getState(),
      events: this.events.slice(0, 20),
      thresholds: this.config.thresholds
    };
  }

  destroy() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
  }
}
