import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
        const normalRouteStr = 'HELMET01->NODE02->NODE01';
        
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
        const link = this.links.find(l => l.id === update.id || (l.source === update.source && l.destination === update.destination));
        if (link) {
          if (update.rssi !== undefined) {
            link.rssi = update.rssi;
            const evalRssi = this.evaluateRssi(link.rssi);
            link.quality = evalRssi.quality;
            link.percentage = evalRssi.percentage;
          }
          if (update.distance !== undefined) {
            link.distance = update.distance;
          }
          if (update.status !== undefined && link.status !== update.status) {
            link.status = update.status;
            topologyChanged = true;
          }
          if (update.available !== undefined && link.available !== update.available) {
            link.available = update.available;
            topologyChanged = true;
          }
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

  processTelemetry(telemetry) {
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
      this.addEvent('EMERGENCY', `EMERGENCY — SOS activated by miner on ${this.helmetId}`);
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

    if (telemetry.network) {
      if (telemetry.network.connected_node) {
        this.connectedNode = telemetry.network.connected_node;
      }
      if (Array.isArray(telemetry.network.links)) {
        this.updateNetworkTelemetry(telemetry.network.links);
      }
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

    this.addEvent('INFO', 'System state reset to nominal');
    this.notifyListeners('STATE_UPDATE', this.getFullState());
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
