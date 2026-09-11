/**
 * MUKUT Node1 WiFi & Serial Bridge Helper
 * Polls or translates the Node1 Surface Gateway's telemetry data
 * into the MUKUT v1.0 telemetry contract and updates StateManager.
 */

function scale(raw, inMin, inMax, outMin, outMax) {
  if (raw <= inMin) return outMin;
  if (raw >= inMax) return outMax;
  return outMin + ((raw - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export class Node1Bridge {
  constructor(stateManager, node1Ip = '10.207.160.60', pollIntervalMs = 1500) {
    this.stateManager = stateManager;
    this.node1Ip = node1Ip;
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
    this.isRunning = false;
    this.consecutiveFailures = 0;
    this.maxFailures = 5;
  }

  translate(node1) {
    const env = node1.environment || {};
    const miner = node1.miner || {};
    const topo = node1.mesh_topology || {};
    const helmetDirect = topo.helmet_direct || {};
    const node2Relay = topo.node2_relay || {};
    const node3Relay = topo.node3_relay || {};
    const tunnelPos = topo.tunnel_position || {};
    const sys = node1.system || {};

    const rawMq4 = env.mq4_methane_ppm != null ? env.mq4_methane_ppm : 0;
    const rawMq6 = env.mq6_lpg_ppm != null ? env.mq6_lpg_ppm : 0;
    const rawMq8 = env.mq8_hydrogen_ppm != null ? env.mq8_hydrogen_ppm : 0;

    const isSos = miner.status === 'SOS EMERGENCY';

    const links = [];
    const nearestNode = tunnelPos.nearest_node || 'SURFACE (Direct)';

    const isHelmetOnline = Boolean(helmetDirect.online);
    const isNode2Online = Boolean(node2Relay.online);
    const isNode3Online = Boolean(node3Relay.online);

    // Links construction per user topology specifications
    // 1. Node 1 ◄──► Node 2: Trunk connection (no RSSI / distance displayed)
    const n2ToN1 = {
      id: 'link_node02_node01',
      source: 'NODE02',
      destination: 'NODE01',
      rssi: null,
      distance: null,
      hide_metrics: true,
      status: isNode2Online ? 'CONNECTED' : 'DISCONNECTED',
      available: isNode2Online
    };

    // 2. Node 2 ◄──► Node 3: Inter-node relay link with RSSI and distance
    const n3ToN2 = {
      id: 'link_node03_node02',
      source: 'NODE03',
      destination: 'NODE02',
      rssi: isNode3Online ? (node3Relay.rssi_dbm || -50) : -100,
      distance: node2Relay.distance_to_node3_m > 0 ? node2Relay.distance_to_node3_m : (node3Relay.distance_to_node3_m > 0 ? node3Relay.distance_to_node3_m : 3.5),
      status: (isNode3Online && isNode2Online) ? 'CONNECTED' : 'DISCONNECTED',
      available: (isNode3Online && isNode2Online)
    };

    // 3. Node 3 ◄──► Helmet: Stope access link with RSSI and distance
    const helmetToN3 = {
      id: 'link_helmet_node03',
      source: 'HELMET01',
      destination: 'NODE03',
      rssi: isNode3Online ? (node3Relay.rssi_dbm != null && node3Relay.rssi_dbm !== 0 ? node3Relay.rssi_dbm : (helmetDirect.rssi_dbm || -45)) : -100,
      distance: (node3Relay.distance_to_helmet_m != null && node3Relay.distance_to_helmet_m > 0) ? Math.round(node3Relay.distance_to_helmet_m * 10) / 10 : (isNode3Online ? 0.6 : null),
      status: (isHelmetOnline && isNode3Online) ? 'CONNECTED' : 'DISCONNECTED',
      available: (isHelmetOnline && isNode3Online)
    };

    // 4. Node 2 ◄──► Helmet: Mid-tunnel secondary link with RSSI and distance
    const helmetToN2 = {
      id: 'link_helmet_node02',
      source: 'HELMET01',
      destination: 'NODE02',
      rssi: isNode2Online ? (node2Relay.rssi_dbm != null && node2Relay.rssi_dbm !== 0 ? node2Relay.rssi_dbm : (helmetDirect.rssi_dbm || -55)) : -100,
      distance: (node2Relay.distance_to_helmet_m != null && node2Relay.distance_to_helmet_m > 0) ? Math.round(node2Relay.distance_to_helmet_m * 10) / 10 : (isNode2Online ? 4.4 : null),
      status: (isHelmetOnline && isNode2Online) ? 'CONNECTED' : 'DISCONNECTED',
      available: (isHelmetOnline && isNode2Online)
    };

    // 5. Node 1 ◄──► Helmet: Surface direct link with RSSI and distance
    const helmetToN1 = {
      id: 'link_helmet_node01',
      source: 'HELMET01',
      destination: 'NODE01',
      rssi: isHelmetOnline ? (helmetDirect.rssi_dbm || -53) : -100,
      distance: (miner.total_distance_m != null && miner.total_distance_m > 0) ? miner.total_distance_m : (node2Relay.distance_to_helmet_m > 0 ? Number((node2Relay.distance_to_helmet_m + 5.0).toFixed(1)) : 9.8),
      status: isHelmetOnline ? 'CONNECTED' : 'DISCONNECTED',
      available: isHelmetOnline
    };

    links.push(n2ToN1, n3ToN2, helmetToN3, helmetToN2, helmetToN1);

    // Synchronize Node availability in StateManager
    if (this.stateManager) {
      const n2Node = this.stateManager.nodes.find(n => n.id === 'NODE02');
      if (n2Node) {
        n2Node.status = isNode2Online ? 'ONLINE' : 'OFFLINE';
        n2Node.available = isNode2Online;
      }
      const n3Node = this.stateManager.nodes.find(n => n.id === 'NODE03');
      if (n3Node) {
        n3Node.status = isNode3Online ? 'ONLINE' : 'OFFLINE';
        n3Node.available = isNode3Online;
      }
      const hNode = this.stateManager.nodes.find(n => n.id === 'HELMET01');
      if (hNode) {
        hNode.status = isHelmetOnline ? 'ONLINE' : 'OFFLINE';
        hNode.available = isHelmetOnline;
      }

      // 1. Update spatial position first with distances and RSSI
      this.stateManager.updateSpatialPosition({
        nearest_node: nearestNode,
        relative_slider_pct: tunnelPos.relative_slider_pct != null ? tunnelPos.relative_slider_pct : 50.0,
        dist_n2: node2Relay.distance_to_helmet_m != null ? node2Relay.distance_to_helmet_m : -1.0,
        dist_n3: node3Relay.distance_to_helmet_m != null ? node3Relay.distance_to_helmet_m : -1.0,
        rssi_n2: node2Relay.rssi_dbm != null ? node2Relay.rssi_dbm : -51,
        rssi_n3: node3Relay.rssi_dbm != null ? node3Relay.rssi_dbm : -45,
        fixed_dist: node2Relay.distance_to_node3_m != null ? node2Relay.distance_to_node3_m : 3.5
      });

      // 2. Update network links immediately
      this.stateManager.updateNetworkTelemetry(links);

      // 3. Pass extended node hazard levels & active alerts into StateManager
      this.stateManager.updateStructuralHealth({
        node2: {
          status: node2Relay.hazard_status || (isNode2Online ? 'STABLE' : 'OFFLINE'),
          level: node2Relay.hazard_level || 0,
          online: isNode2Online
        },
        node3: {
          status: node3Relay.hazard_status || (isNode3Online ? 'STABLE' : 'OFFLINE'),
          level: node3Relay.hazard_level || 0,
          online: isNode3Online
        }
      });

      if (Array.isArray(node1.active_alerts) || Array.isArray(node1.active_emergencies)) {
        this.stateManager.setNode1Alerts(node1.active_alerts || [], node1.active_emergencies || []);
      }
    }

    let connectedNode = 'NODE01';
    if (nearestNode.includes('NODE02')) connectedNode = 'NODE02';
    else if (nearestNode.includes('NODE03')) connectedNode = 'NODE03';

    // Return complete v1.0 payload + Node1 extensions
    return {
      version: '1.0',
      helmet_id: miner.worker_id || 'HELMET01',
      timestamp: Math.floor(Date.now() / 1000),
      environment: {
        temperature: Number((env.temperature_c != null ? env.temperature_c : 25.0).toFixed(1)),
        humidity: Number((env.humidity_pct != null ? env.humidity_pct : 53.0).toFixed(1)),
        methane: rawMq4,
        carbon_monoxide: rawMq6,
        smoke: rawMq8,
        raw_mq4: rawMq4,
        raw_mq6: rawMq6,
        raw_mq8: rawMq8
      },
      safety: {
        sos: isSos,
        miner_status: miner.status || 'SAFE',
        motion_state: miner.motion_state || 'STATIONARY',
        heading_deg: miner.heading_deg || 0,
        direction_cardinal: miner.direction_cardinal || 'NORTH',
        step_count: miner.step_count || 0
      },
      network: {
        connected_node: connectedNode,
        active_route: sys.active_route || '',
        overall_risk_index: sys.overall_risk_index || 'LOW',
        links
      }
    };
  }

  async poll() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      let response = await fetch(`http://${this.node1Ip}/api/telemetry`, {
        signal: controller.signal
      }).catch(() => null);

      if (!response || !response.ok) {
        response = await fetch(`http://${this.node1Ip}/telemetry`, {
          signal: controller.signal
        }).catch(() => null);
      }

      clearTimeout(timeout);

      if (!response || !response.ok) {
        throw new Error(`Node1 unreachable at ${this.node1Ip} (HTTP ${response ? response.status : 'No Response'})`);
      }

      const text = await response.text();
      let node1Data;
      try {
        node1Data = JSON.parse(text);
      } catch (e) {
        throw new Error(`Invalid JSON from Node1: ${text.substring(0, 50)}...`);
      }

      const mukutPacket = this.translate(node1Data);
      this.stateManager.processTelemetry(mukutPacket);
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures <= 2) {
        this.stateManager.addEvent('WARNING', `Node1 Bridge: Poll failed — ${err.message}`);
      } else if (this.consecutiveFailures === 3) {
        this.stateManager.addEvent('WARNING', `Node1 Bridge: Multiple poll failures — node may be unreachable at ${this.node1Ip}`);
      }
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stateManager.addEvent('INFO', `Node1 Bridge started — polling http://${this.node1Ip}/api/telemetry every ${this.pollIntervalMs}ms`);
    this.poll();
    this.timer = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
