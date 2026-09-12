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
    this.demoted = false;
    this.lastValidSliderPct = null;
    this.lastRelayLog = {};
  }

  // Live-measurement validators. Each returns the value only when it is a genuine
  // reading; otherwise null. The bridge must never substitute a static value (or
  // another relay's value) for a missing reading — null means "no measurement".
  static validRssi(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v < 0) ? v : null;
  }
  static validSnr(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  }
  static validDist(v) {
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
  }

  // Debug telemetry log — emitted only when a relay's values change, so the
  // 1.5 s poll cadence does not flood the console.
  _logRelay(tag, values) {
    const line =
      `RSSI: ${values.rssi != null ? values.rssi : 'N/A'} | ` +
      `SNR: ${values.snr != null ? values.snr : 'N/A'} | ` +
      `DISTANCE TO HELMET: ${values.distHelmet != null ? `${values.distHelmet} m` : 'N/A'}` +
      (tag === 'NODE2' ? ` | DISTANCE TO NODE3: ${values.distN3 != null ? `${values.distN3} m` : 'N/A'}` : '');
    if (this.lastRelayLog[tag] === line) return;
    this.lastRelayLog[tag] = line;
    console.log(`[${tag} TELEMETRY] ${line}`);
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

    // Validated live measurements. null = no valid reading this packet.
    // Each relay only ever contributes its OWN readings (no cross-relay
    // fallback), and offline relays contribute nothing (no stale values).
    const n1Rssi = isHelmetOnline ? Node1Bridge.validRssi(helmetDirect.rssi_dbm) : null;
    const n2Rssi = isNode2Online ? Node1Bridge.validRssi(node2Relay.rssi_dbm) : null;
    const n3Rssi = isNode3Online ? Node1Bridge.validRssi(node3Relay.rssi_dbm) : null;
    const n1Snr = Node1Bridge.validSnr(helmetDirect.snr_db);
    const n2Snr = Node1Bridge.validSnr(node2Relay.snr_db);
    const n3Snr = Node1Bridge.validSnr(node3Relay.snr_db);
    const n1DistHelmet = isHelmetOnline ? Node1Bridge.validDist(miner.total_distance_m) : null;
    const n2DistHelmet = isNode2Online ? Node1Bridge.validDist(node2Relay.distance_to_helmet_m) : null;
    const n3DistHelmet = isNode3Online ? Node1Bridge.validDist(node3Relay.distance_to_helmet_m) : null;
    const n2DistN3 = Node1Bridge.validDist(node2Relay.distance_to_node3_m)
      ?? Node1Bridge.validDist(node3Relay.distance_to_node3_m);

    // New-firmware (v2) relay telemetry: true helmet-link measurements made by
    // each relay's own radio, plus node3's peer view of node2. Feature-detected —
    // these fields are absent on old firmware, in which case the legacy trunk
    // values are used as fallback (backward compatible).
    const n2HelmLink = node2Relay.helmet_link !== undefined ? Boolean(node2Relay.helmet_link) : null;
    const n3HelmLink = node3Relay.helmet_link !== undefined ? Boolean(node3Relay.helmet_link) : null;
    const n2HelmRssi = n2HelmLink === true ? Node1Bridge.validRssi(node2Relay.helmet_rssi_db) : null;
    const n2HelmSnr = n2HelmLink === true ? Node1Bridge.validSnr(node2Relay.helmet_snr_db) : null;
    const n3HelmRssi = n3HelmLink === true ? Node1Bridge.validRssi(node3Relay.helmet_rssi_db) : null;
    const n3HelmSnr = n3HelmLink === true ? Node1Bridge.validSnr(node3Relay.helmet_snr_db) : null;
    const n3PeerRssi = isNode3Online ? Node1Bridge.validRssi(node3Relay.peer_rssi_db) : null;
    const n3PeerSnr = isNode3Online ? Node1Bridge.validSnr(node3Relay.peer_snr_db) : null;

    // The helmet is alive when the gateway hears it directly OR any relay
    // reports a live helmet link (deep-tunnel relay-only operation).
    const isHelmetAlive = isHelmetOnline || n2HelmLink === true || n3HelmLink === true;

    // Helmet-link up states. Old firmware: link follows the station-online
    // flags (legacy behavior). New firmware: the relay's own helmet_link flag
    // decides, independent of station liveness.
    const hN1Up = isHelmetOnline;
    const hN2Up = isHelmetAlive && isNode2Online && (n2HelmLink !== null ? n2HelmLink : true);
    const hN3Up = isHelmetAlive && isNode3Online && (n3HelmLink !== null ? n3HelmLink : true);

    // Route mapping — two-anchor position between Node 2 and Node 3.
    // When BOTH live anchor distances are valid, the physical ratio
    // D2 / (D2 + D3) (0% = at Node 2, 100% = at Node 3) takes priority;
    // while anchors are unavailable, retain the last valid position rather
    // than jumping on the firmware's step-driven slider.
    let sliderPct;
    if (n2DistHelmet != null && n3DistHelmet != null && (n2DistHelmet + n3DistHelmet) > 0) {
      sliderPct = Math.min(100, Math.max(0, (n2DistHelmet / (n2DistHelmet + n3DistHelmet)) * 100));
      this.lastValidSliderPct = sliderPct;
    } else if (this.lastValidSliderPct != null) {
      sliderPct = this.lastValidSliderPct;
    } else if (typeof tunnelPos.relative_slider_pct === 'number' && Number.isFinite(tunnelPos.relative_slider_pct)) {
      sliderPct = Math.min(100, Math.max(0, tunnelPos.relative_slider_pct));
    } else {
      sliderPct = 50.0;
    }

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

    // 2. Node 2 ◄──► Node 3: Inter-node relay link with RSSI and distance.
    // New firmware: prefer node3's own radio view of node2 (true N3↔N2 link);
    // legacy: node3_relay.rssi_dbm (trunk) as before.
    const n3ToN2 = {
      id: 'link_node03_node02',
      source: 'NODE03',
      destination: 'NODE02',
      rssi: (isNode3Online && isNode2Online)
        ? (n3PeerRssi != null ? n3PeerRssi : n3Rssi)
        : -100,
      snr: n3PeerSnr != null ? n3PeerSnr : n3Snr,
      distance: n2DistN3,
      status: (isNode3Online && isNode2Online) ? 'CONNECTED' : 'DISCONNECTED',
      available: (isNode3Online && isNode2Online)
    };

    // 3. Node 3 ◄──► Helmet: Stope access link with RSSI and distance.
    // New firmware: true helmet-link RSSI/SNR measured by node3's radio;
    // legacy: trunk values (previous behavior).
    const helmetToN3 = {
      id: 'link_helmet_node03',
      source: 'HELMET01',
      destination: 'NODE03',
      rssi: hN3Up ? (n3HelmRssi != null ? n3HelmRssi : n3Rssi) : -100,
      snr: n3HelmSnr != null ? n3HelmSnr : n3Snr,
      distance: n3DistHelmet != null ? Math.round(n3DistHelmet * 10) / 10 : null,
      status: hN3Up ? 'CONNECTED' : 'DISCONNECTED',
      available: hN3Up
    };

    // 4. Node 2 ◄──► Helmet: Mid-tunnel secondary link with RSSI and distance
    const helmetToN2 = {
      id: 'link_helmet_node02',
      source: 'HELMET01',
      destination: 'NODE02',
      rssi: hN2Up ? (n2HelmRssi != null ? n2HelmRssi : n2Rssi) : -100,
      snr: n2HelmSnr != null ? n2HelmSnr : n2Snr,
      distance: n2DistHelmet != null ? Math.round(n2DistHelmet * 10) / 10 : null,
      status: hN2Up ? 'CONNECTED' : 'DISCONNECTED',
      available: hN2Up
    };

    // 5. Node 1 ◄──► Helmet: Surface direct link with RSSI and distance
    const helmetToN1 = {
      id: 'link_helmet_node01',
      source: 'HELMET01',
      destination: 'NODE01',
      rssi: hN1Up ? n1Rssi : -100,
      snr: n1Snr,
      distance: n1DistHelmet,
      status: hN1Up ? 'CONNECTED' : 'DISCONNECTED',
      available: hN1Up
    };

    // 6. Node 3 ◄──► Node 1: Failover bypass segment — presence/state only.
    // Metrics are intentionally omitted so the config-layer display values
    // are preserved; only connectivity follows node3 station liveness.
    const n3ToN1 = {
      id: 'link_node03_node01',
      source: 'NODE03',
      destination: 'NODE01',
      status: isNode3Online ? 'CONNECTED' : 'DISCONNECTED',
      available: isNode3Online
    };

    links.push(n2ToN1, n3ToN2, helmetToN3, helmetToN2, helmetToN1, n3ToN1);

    // Debug: relay telemetry, logged only when values change
    this._logRelay('NODE2', { rssi: n2Rssi, snr: n2Snr, distHelmet: n2DistHelmet, distN3: n2DistN3 });
    this._logRelay('NODE3', { rssi: n3Rssi, snr: n3Snr, distHelmet: n3DistHelmet });

    const anchorsList = [];
    if (n1DistHelmet != null) anchorsList.push({ id: 'NODE01', distance: n1DistHelmet });
    if (n2DistHelmet != null) anchorsList.push({ id: 'NODE02', distance: n2DistHelmet });
    if (n3DistHelmet != null) anchorsList.push({ id: 'NODE03', distance: n3DistHelmet });

    // Synchronize Node availability in StateManager
    if (this.stateManager) {
      // translate() only runs on a successful poll — the gateway (NODE01) is
      // therefore reachable and online. It was previously never synced and
      // stayed on whatever the config default said.
      const n1Node = this.stateManager.nodes.find(n => n.id === 'NODE01');
      if (n1Node) {
        n1Node.status = 'ONLINE';
        n1Node.available = true;
      }
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
      // Helmet liveness: heard directly by the gateway OR relayed alive by any
      // station — a deep-tunnel helmet is still alive when only relays hear it.
      const hNode = this.stateManager.nodes.find(n => n.id === 'HELMET01');
      if (hNode) {
        hNode.status = isHelmetAlive ? 'ONLINE' : 'OFFLINE';
        hNode.available = isHelmetAlive;
      }

      // 1. Update spatial position first with distances and RSSI.
      // Helmet-link RSSI prefers the relay's own radio measurement (new
      // firmware) over the trunk value.
      const spatial = {
        nearest_node: nearestNode,
        relative_slider_pct: sliderPct,
        dist_n2: n2DistHelmet != null ? n2DistHelmet : -1.0,
        dist_n3: n3DistHelmet != null ? n3DistHelmet : -1.0,
        rssi_n2: n2HelmRssi != null ? n2HelmRssi : n2Rssi,
        rssi_n3: n3HelmRssi != null ? n3HelmRssi : n3Rssi
      };
      // fixed_dist (physical N2↔N3 separation) only from a live reading —
      // otherwise the previously stored value is retained (never a default)
      if (n2DistN3 != null) spatial.fixed_dist = n2DistN3;
      this.stateManager.updateSpatialPosition(spatial);

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
      motion: {
        moving: miner.motion_state === 'MOVING',
        step_count: typeof miner.step_count === 'number' ? miner.step_count : 0,
        distance_walked_m: typeof miner.total_distance_m === 'number' ? miner.total_distance_m : 0
      },
      orientation: { heading: typeof miner.heading_deg === 'number' ? miner.heading_deg : 0 },
      anchors: anchorsList,
      network: {
        connected_node: connectedNode,
        active_route: sys.active_route || '',
        overall_risk_index: sys.overall_risk_index || 'LOW',
        links
      }
    };
  }

  // Layer A honesty guard: when the gateway cannot be reached, NO live data
  // exists — mark every node OFFLINE and every link DISCONNECTED so the
  // dashboard stops displaying stale config-default state (the phantom
  // ONLINE bug). Fires once per outage (gated by `demoted`); the next
  // successful poll restores everything via translate().
  _demoteAllNodes() {
    this.demoted = true;
    const sm = this.stateManager;
    if (!sm) return;
    for (const n of sm.nodes) {
      n.status = 'OFFLINE';
      n.available = false;
    }
    for (const l of sm.links) {
      l.status = 'DISCONNECTED';
      l.available = false;
    }
    sm.networkHealth = sm.calculateNetworkHealth();
    sm.addEvent('WARNING', `Node1 Bridge: Gateway unreachable at ${this.node1Ip} — all nodes marked OFFLINE (no live telemetry)`);
    sm.recalculateRoute('Gateway unreachable');
    sm.notifyListeners('STATE_UPDATE', sm.getFullState());
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
      await this.stateManager.processTelemetry(mukutPacket);
      this.consecutiveFailures = 0;
      if (this.demoted) {
        this.demoted = false;
        this.stateManager.addEvent('INFO', `Node1 Bridge: Gateway reachable again at ${this.node1Ip} — network state restored`);
      }
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures <= 2) {
        this.stateManager.addEvent('WARNING', `Node1 Bridge: Poll failed — ${err.message}`);
      } else if (this.consecutiveFailures === 3) {
        this.stateManager.addEvent('WARNING', `Node1 Bridge: Multiple poll failures — node may be unreachable at ${this.node1Ip}`);
      }
      // After 3 consecutive failures the gateway is unreachable — demote the
      // whole network so the dashboard shows the truth instead of stale
      // config defaults (nodes showing ONLINE with no connection).
      if (this.consecutiveFailures >= 3 && !this.demoted) {
        this._demoteAllNodes();
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
