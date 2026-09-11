import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Node1Bridge } from './node1Bridge.js';

/**
 * MUKUT Hardware Serial Bridge
 * Reads telemetry packets from the Gateway ESP32 via USB Serial.
 * Supports:
 *  1. Direct MUKUT v1.0 JSON packets
 *  2. Node1 ESP32 JSON schema (/api/telemetry JSON payload)
 *  3. Node1 ESP32 ASCII text dashboard output (printSerialDashboard)
 */
export class SerialBridge {
  constructor(stateManager, portPath = 'COM7', baudRate = 115200) {
    this.stateManager = stateManager;
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.port = null;
    this.parser = null;
    this.reconnectTimer = null;
    this.isRunning = false;
    this.node1BridgeHelper = new Node1Bridge(stateManager);

    // Buffer for building telemetry state from Node 1 ASCII output
    this.asciiState = {
      temp: 25.2,
      hum: 53.0,
      lpg: 150,
      ch4: 136,
      h2: 153,
      status: 'SAFE',
      sos: false,
      helmetOnline: true,
      helmetRssi: -46,
      node2Online: true,
      node2Rssi: -47,
      node2HazardStatus: 'STABLE',
      node2HazardLevel: 0,
      node3Online: true,
      node3Rssi: -44,
      node3HazardStatus: 'STABLE',
      node3HazardLevel: 0,
      nearestNode: 'NODE03',
      activeRoute: '',
      riskIndex: 'LOW',
      distN2: 9.8,
      distN3: 2.7,
      fixedDist: 3.5
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  stop() {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.port && this.port.isOpen) {
      this.port.close();
    }
  }

  connect() {
    this.stateManager.addEvent('INFO', `Hardware Mode: Attempting to connect SerialBridge to ${this.portPath} at ${this.baudRate} baud...`);

    try {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        autoOpen: false
      });

      this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));

      this.port.on('open', () => {
        this.stateManager.addEvent('INFO', `Hardware Serial connected on ${this.portPath}`);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.port.on('close', () => {
        this.stateManager.addEvent('WARNING', `Hardware Serial closed on ${this.portPath}`);
        this.handleDisconnect();
      });

      this.port.on('error', (err) => {
        this.stateManager.addEvent('WARNING', `Hardware Serial Error: ${err.message}`);
        this.handleDisconnect();
      });

      this.parser.on('data', (data) => {
        this.handleData(data);
      });

      this.port.open((err) => {
        if (err) {
          this.stateManager.addEvent('WARNING', `Hardware Serial failed to open: ${err.message}`);
          this.handleDisconnect();
        }
      });
    } catch (err) {
      this.stateManager.addEvent('WARNING', `Hardware Serial exception: ${err.message}`);
      this.handleDisconnect();
    }
  }

  handleDisconnect() {
    if (!this.isRunning) return;
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 5000);
    }
  }

  handleData(data) {
    const rawString = data.toString().trim();
    if (!rawString) return;

    // 1. Try parsing JSON
    if (rawString.startsWith('{') && rawString.endsWith('}')) {
      try {
        const packet = JSON.parse(rawString);

        if (packet.mesh_topology || packet.miner || packet.environment) {
          const mukutPacket = this.node1BridgeHelper.translate(packet);
          this.stateManager.processTelemetry(mukutPacket);
          return;
        }

        if (packet.version && packet.helmet_id && packet.timestamp) {
          this.stateManager.processTelemetry(packet);
          return;
        }
      } catch (err) {
        // Fall through to ASCII parsing
      }
    }

    // 2. Parse ASCII Serial output from Node 1 ESP32 (printSerialDashboard)
    this.parseAsciiLine(rawString);
  }

  parseAsciiLine(line) {
    if (line.includes('======================================================================') ||
      line.includes('🏔️ KAVACH SURFACE CONTROL CENTER')) {
      this.flushAsciiState();
      return;
    }

    // Overall Risk Index
    if (line.includes('OVERALL RISK INDEX')) {
      if (line.includes('HIGH')) this.asciiState.riskIndex = 'HIGH';
      else if (line.includes('ELEVATED')) this.asciiState.riskIndex = 'ELEVATED';
      else if (line.includes('LOW')) this.asciiState.riskIndex = 'LOW';
    }

    // Active Data Route
    if (line.includes('Active Data Route')) {
      const match = line.match(/Active Data Route\s*:\s*(.+)/);
      if (match) this.asciiState.activeRoute = match[1].trim();
    }

    // Proximity & Location
    if (line.includes('Current Proximity:')) {
      const match = line.match(/Current Proximity:\s*Near\s*(.+)/);
      if (match) this.asciiState.nearestNode = match[1].trim();
    } else if (line.includes('Last Known Location:')) {
      const match = line.match(/Last Known Location:\s*Near\s*(.+)/);
      if (match) this.asciiState.nearestNode = match[1].trim();
    }

    // Fixed Distance
    if (line.includes('Fixed Distance (N2 to N3):')) {
      const match = line.match(/Fixed Distance \(N2 to N3\):\s*([\d.]+)/);
      if (match) this.asciiState.fixedDist = parseFloat(match[1]);
    }

    // Distances line: (9.8m) (2.7m)
    const distMatch = line.match(/\(([\d.]+)m\)\s+\(([\d.]+)m\)/);
    if (distMatch) {
      this.asciiState.distN2 = parseFloat(distMatch[1]);
      this.asciiState.distN3 = parseFloat(distMatch[2]);
    }

    // Miner Status
    if (line.includes('MINER 01 is currently')) {
      if (line.includes('SOS EMERGENCY')) {
        this.asciiState.status = 'SOS EMERGENCY';
        this.asciiState.sos = true;
      } else if (line.includes('SAFE')) {
        this.asciiState.status = 'SAFE';
        this.asciiState.sos = false;
      } else if (line.includes('OFFLINE')) {
        this.asciiState.status = 'OFFLINE';
      }
    }

    // Temperature & Humidity
    const tempMatch = line.match(/Temp:\s*([\d.]+)/i);
    if (tempMatch) this.asciiState.temp = parseFloat(tempMatch[1]);

    const humMatch = line.match(/Hum\s*:\s*([\d.]+)/i);
    if (humMatch) this.asciiState.hum = parseFloat(humMatch[1]);

    // Gas Readings
    const lpgMatch = line.match(/LPG:\s*(\d+)/i);
    if (lpgMatch) this.asciiState.lpg = parseInt(lpgMatch[1], 10);

    const ch4Match = line.match(/CH4:\s*(\d+)/i);
    if (ch4Match) this.asciiState.ch4 = parseInt(ch4Match[1], 10);

    const h2Match = line.match(/H2\s*:\s*(\d+)/i);
    if (h2Match) this.asciiState.h2 = parseInt(h2Match[1], 10);

    // Link Statuses & RSSI
    if (line.includes('Helmet (Direct)')) {
      this.asciiState.helmetOnline = line.includes('🟢 ON');
      const rssiMatch = line.match(/(-?\d+)\s*dBm/i);
      if (rssiMatch) this.asciiState.helmetRssi = parseInt(rssiMatch[1], 10);
    }

    if (line.includes('Node 2 (Relay B)')) {
      this.asciiState.node2Online = line.includes('🟢 ON');
      const rssiMatch = line.match(/(-?\d+)\s*dBm/i);
      if (rssiMatch) this.asciiState.node2Rssi = parseInt(rssiMatch[1], 10);
    }

    if (line.includes('Node 3 (Relay C)')) {
      this.asciiState.node3Online = line.includes('🟢 ON');
      const rssiMatch = line.match(/(-?\d+)\s*dBm/i);
      if (rssiMatch) this.asciiState.node3Rssi = parseInt(rssiMatch[1], 10);
    }

    // Structural Health Monitoring
    if (line.includes('Node 2 Station:')) {
      if (line.includes('CRITICAL_HAZARD')) {
        this.asciiState.node2HazardStatus = 'CRITICAL_HAZARD';
        this.asciiState.node2HazardLevel = 2;
      } else if (line.includes('WARNING_SHIFT')) {
        this.asciiState.node2HazardStatus = 'WARNING_SHIFT';
        this.asciiState.node2HazardLevel = 1;
      } else {
        this.asciiState.node2HazardStatus = 'STABLE';
        this.asciiState.node2HazardLevel = 0;
      }
    }

    if (line.includes('Node 3 Station:')) {
      if (line.includes('CRITICAL_HAZARD')) {
        this.asciiState.node3HazardStatus = 'CRITICAL_HAZARD';
        this.asciiState.node3HazardLevel = 2;
      } else if (line.includes('WARNING_SHIFT')) {
        this.asciiState.node3HazardStatus = 'WARNING_SHIFT';
        this.asciiState.node3HazardLevel = 1;
      } else {
        this.asciiState.node3HazardStatus = 'STABLE';
        this.asciiState.node3HazardLevel = 0;
      }
    }
  }

  flushAsciiState() {
    let sliderPct = 50.0;
    if (this.asciiState.distN2 >= 0 && this.asciiState.distN3 >= 0) {
      const tot = this.asciiState.distN2 + this.asciiState.distN3;
      sliderPct = tot > 0 ? (this.asciiState.distN2 / tot) * 100.0 : 50.0;
    }

    const node1Obj = {
      system: {
        active_route: this.asciiState.activeRoute,
        overall_risk_index: this.asciiState.riskIndex
      },
      miner: {
        worker_id: 'MINER 01',
        status: this.asciiState.status
      },
      environment: {
        temperature_c: this.asciiState.temp,
        humidity_pct: this.asciiState.hum,
        mq4_methane_ppm: this.asciiState.ch4,
        mq6_lpg_ppm: this.asciiState.lpg,
        mq8_hydrogen_ppm: this.asciiState.h2
      },
      mesh_topology: {
        node2_relay: {
          online: this.asciiState.node2Online,
          rssi_dbm: this.asciiState.node2Rssi,
          hazard_status: this.asciiState.node2HazardStatus,
          hazard_level: this.asciiState.node2HazardLevel,
          distance_to_helmet_m: this.asciiState.distN2,
          distance_to_node3_m: this.asciiState.fixedDist
        },
        node3_relay: {
          online: this.asciiState.node3Online,
          rssi_dbm: this.asciiState.node3Rssi,
          hazard_status: this.asciiState.node3HazardStatus,
          hazard_level: this.asciiState.node3HazardLevel,
          distance_to_helmet_m: this.asciiState.distN3
        },
        helmet_direct: {
          online: this.asciiState.helmetOnline,
          rssi_dbm: this.asciiState.helmetRssi
        },
        tunnel_position: {
          nearest_node: this.asciiState.nearestNode,
          relative_slider_pct: sliderPct
        }
      }
    };

    const mukutPacket = this.node1BridgeHelper.translate(node1Obj);
    this.stateManager.processTelemetry(mukutPacket);
  }
}
