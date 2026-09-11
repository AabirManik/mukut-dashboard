import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import { StateManager } from './stateManager.js';
import { TelemetrySimulator } from './simulator.js';
import { SerialBridge } from './serialBridge.js';
import { Node1Bridge } from './node1Bridge.js';
import { validateTelemetry } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../client')));
app.use('/dashboard/css', express.static(path.resolve(__dirname, '../client/css')));
app.use('/dashboard/js', express.static(path.resolve(__dirname, '../client/js')));

// Initialize Core State Manager and Simulator
const stateManager = new StateManager();
const config = stateManager.getConfig();
const simulator = new TelemetrySimulator(stateManager, config.helmet.heartbeat_interval_ms || 2000);

const isHardwareMode = config.hardware && (config.hardware.data_source === 'hardware' || config.hardware.data_source === 'serial');
const isNode1Mode = config.hardware && (config.hardware.data_source === 'node1' || config.hardware.data_source === 'node1_wifi');

let serialBridge = null;
let node1Bridge = null;

if (isHardwareMode) {
  serialBridge = new SerialBridge(
    stateManager,
    config.hardware.serial_port || 'COM7',
    config.hardware.baud_rate || 115200
  );
}

if (isNode1Mode || (config.hardware && config.hardware.node1_ip)) {
  node1Bridge = new Node1Bridge(
    stateManager,
    config.hardware.node1_ip || '10.251.147.60',
    config.hardware.node1_poll_interval_ms || 1500
  );
}

// Broadcast helper for WebSockets
function broadcast(messageObj) {
  const data = JSON.stringify(messageObj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Hook state manager updates to WebSocket broadcaster
stateManager.addListener((msg) => {
  broadcast(msg);
});

// REST Endpoints - Safety & State
app.get('/api/state', (req, res) => {
  res.json(stateManager.getFullState());
});

app.get('/api/config', (req, res) => {
  res.json(stateManager.getConfig());
});

app.get('/api/events', (req, res) => {
  res.json(stateManager.getFullState().events);
});

// Phase 2: REST Endpoints - Network State
app.get('/api/network', (req, res) => {
  res.json(stateManager.getFullState().network);
});

app.post('/api/network/node', (req, res) => {
  const { nodeId, status } = req.body;
  if (!nodeId || !status) {
    return res.status(400).json({ error: 'Fields "nodeId" and "status" are required' });
  }
  stateManager.setNodeStatus(nodeId, status);
  res.json({ success: true, network: stateManager.getFullState().network });
});

app.post('/api/network/telemetry', (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links)) {
    return res.status(400).json({ error: 'Field "links" must be an array' });
  }
  stateManager.updateNetworkTelemetry(links);
  res.json({ success: true, network: stateManager.getFullState().network });
});

// Telemetry Ingestion Endpoint (Hardware / Gateway Contract)
app.post('/api/telemetry', (req, res) => {
  const validation = validateTelemetry(req.body);
  if (!validation.valid) {
    return res.status(400).json({
      success: false,
      error: 'Invalid telemetry payload',
      details: validation.errors
    });
  }

  const updatedState = stateManager.processTelemetry(req.body);
  res.json({
    success: true,
    helmet_id: updatedState.helmet_id,
    status: updatedState.status,
    timestamp: Date.now()
  });
});

// Simulator Control Endpoints
app.post('/api/simulator/scenario', (req, res) => {
  const { scenario } = req.body;
  if (!scenario) {
    return res.status(400).json({ error: 'Field "scenario" is required' });
  }

  try {
    const result = simulator.setScenario(scenario);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/simulator/status', (req, res) => {
  res.json(simulator.getScenario());
});

// Page Routes
app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/index.html'));
});

app.get('/dashboard/network', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/network.html'));
});

app.get('/network', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/network.html'));
});

app.get('/dashboard/routing', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/routing.html'));
});

app.get('/routing', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/routing.html'));
});

// WebSocket Connection Management
wss.on('connection', (ws) => {
  // Send initial full state immediately
  const initialState = {
    type: 'INIT_STATE',
    payload: stateManager.getFullState(),
    simulator: simulator.getScenario(),
    timestamp: Date.now()
  };
  ws.send(JSON.stringify(initialState));

  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.action === 'SET_SCENARIO') {
        simulator.setScenario(data.scenario);
      } else if (data.action === 'SET_NODE_STATUS') {
        stateManager.setNodeStatus(data.nodeId, data.status);
      } else if (data.action === 'GET_STATE') {
        ws.send(JSON.stringify({
          type: 'STATE_UPDATE',
          payload: stateManager.getFullState(),
          timestamp: Date.now()
        }));
      }
    } catch (err) {
      console.error('WebSocket message parsing error:', err);
    }
  });
});

// Start data source (Hardware, Node1 WiFi, or Simulator)
let activeSources = [];

if (serialBridge) {
  console.log(`[INIT] Starting SerialBridge on port ${serialBridge.portPath}`);
  serialBridge.start();
  activeSources.push(`SERIAL (${serialBridge.portPath})`);
}

if (node1Bridge) {
  console.log(`[INIT] Starting Node1 WiFi Bridge — polling http://${node1Bridge.node1Ip}/api/telemetry`);
  node1Bridge.start();
  activeSources.push(`NODE1 WiFi (http://${node1Bridge.node1Ip}/api/telemetry)`);
}

if (!serialBridge && !node1Bridge) {
  console.log(`[INIT] Starting in SIMULATOR mode`);
  simulator.start();
  activeSources.push(`SIMULATOR`);
}

const PORT = process.env.PORT || config.server.port || 3000;
const HOST = config.server.host || '0.0.0.0';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ERROR] Port ${PORT} is already in use.`);
    console.error(`[ERROR] Run: netstat -ano | findstr :${PORT}  to find and kill the process.`);
    console.error(`[ERROR] Or set a different port via the PORT environment variable, e.g.:  PORT=3001 npm start`);
  } else {
    console.error(`[ERROR] Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(` MUKUT Smart Coal Miner Helmet — Phase 4 Server`);
  console.log(` Safety Dashboard  : http://localhost:${PORT}/dashboard`);
  console.log(` Network Dashboard : http://localhost:${PORT}/dashboard/network`);
  console.log(` Routing Dashboard : http://localhost:${PORT}/dashboard/routing`);
  console.log(` API Endpoint      : http://localhost:${PORT}/api/telemetry`);
  console.log(` Active Sources    : ${activeSources.join(' + ')}`);
  console.log(`=======================================================`);
});
