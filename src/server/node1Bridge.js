/**
 * MUKUT Node1 WiFi Bridge
 * Polls the Node1 Surface Gateway's WiFi /api/telemetry endpoint,
 * translates its JSON schema into the MUKUT v1.0 telemetry contract,
 * and feeds the result into StateManager.processTelemetry().
 */

function scale(raw, inMin, inMax, outMin, outMax) {
  if (raw <= inMin) return outMin;
  if (raw >= inMax) return outMax;
  return outMin + ((raw - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export class Node1Bridge {
  constructor(stateManager, node1Ip, pollIntervalMs = 1500) {
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

    const rawMq4 = env.mq4_methane_ppm != null ? env.mq4_methane_ppm : 150;
    const rawMq6 = env.mq6_lpg_ppm != null ? env.mq6_lpg_ppm : 150;
    const rawMq8 = env.mq8_hydrogen_ppm != null ? env.mq8_hydrogen_ppm : 150;

    const isSos = miner.status === 'SOS EMERGENCY';

    const links = [];

    const nearestNode = tunnelPos.nearest_node || 'NODE03';

    const helmetToN3 = {
      id: 'link_helmet_node03',
      source: 'HELMET01',
      destination: 'NODE03',
      rssi: helmetDirect.rssi_dbm || -80,
      distance: Math.round((node3Relay.distance_to_helmet_m || 18) * 10) / 10,
      status: 'CONNECTED',
      available: true
    };

    const n3ToN2 = {
      id: 'link_node03_node02',
      source: 'NODE03',
      destination: 'NODE02',
      rssi: node3Relay.rssi_dbm || -70,
      distance: Math.round((node2Relay.distance_to_node3_m || 35) * 10) / 10,
      status: 'CONNECTED',
      available: true
    };

    const n2ToN1 = {
      id: 'link_node02_node01',
      source: 'NODE02',
      destination: 'NODE01',
      rssi: node2Relay.rssi_dbm || -70,
      distance: 52,
      status: 'CONNECTED',
      available: true
    };

    const n3ToN1 = {
      id: 'link_node03_node01',
      source: 'NODE03',
      destination: 'NODE01',
      rssi: node3Relay.rssi_dbm || -79,
      distance: Math.round((node2Relay.distance_to_node3_m || 64) * 10) / 10,
      status: 'CONNECTED',
      available: true
    };

    if (!helmetDirect.online) {
      helmetToN3.status = 'DISCONNECTED';
      helmetToN3.available = false;
      helmetToN3.rssi = -100;
      helmetToN3.distance = 0;
    }

    if (!node3Relay.online) {
      n3ToN2.status = 'DISCONNECTED';
      n3ToN2.available = false;
      n3ToN1.status = 'DISCONNECTED';
      n3ToN1.available = false;
    }

    if (!node2Relay.online) {
      n2ToN1.status = 'DISCONNECTED';
      n2ToN1.available = false;
    }

    links.push(helmetToN3, n3ToN2, n2ToN1, n3ToN1);

    return {
      version: '1.0',
      helmet_id: miner.worker_id || 'HELMET01',
      timestamp: Math.floor(Date.now() / 1000),
      environment: {
        temperature: Number((env.temperature_c || 28.5).toFixed(1)),
        humidity: Number((env.humidity_pct || 65.0).toFixed(1)),
        methane: Number(scale(rawMq4, 150, 2000, 0.0, 3.0).toFixed(2)),
        carbon_monoxide: Number(scale(rawMq6, 150, 2000, 0, 200).toFixed(1)),
        smoke: Number(scale(rawMq8, 150, 2000, 0, 500).toFixed(1))
      },
      safety: {
        sos: isSos
      },
      network: {
        connected_node: nearestNode,
        links
      }
    };
  }

  async poll() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const response = await fetch(`http://${this.node1Ip}/api/telemetry`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Node1 responded with HTTP ${response.status}`);
      }

      const node1Data = await response.json();
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
