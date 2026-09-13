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

if (isNode1Mode) {
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

// Calibration Control Endpoints (Phase 6 — RSSI Distance Calibration)
app.post('/api/calibrate', (req, res) => {
  const action = (req.body && req.body.action) || 'start';
  if (action === 'clear') {
    stateManager.calibrationEngine.clear(stateManager);
    stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
    return res.json({ success: true, calibration: stateManager.calibrationEngine.getState() });
  }

  const result = stateManager.calibrationEngine.start(stateManager);
  if (!result.started) {
    return res.status(400).json({ success: false, error: result.reason });
  }
  res.json({ success: true, calibration: stateManager.calibrationEngine.getState() });
});

app.get('/api/calibrate', (req, res) => {
  res.json(stateManager.calibrationEngine.getState());
});

// Route Mapping Control (v3 — SET HEADING runtime calibration)
// Miner faces "into the tunnel" (+x), the control is pressed, and whatever
// the helmet magnetometer reports at that moment becomes the new heading zero.
app.post('/api/trajectory/heading-zero', (req, res) => {
  const result = stateManager.trajectoryEngine.setHeadingZero();
  if (!result.success) {
    return res.status(400).json(result);
  }
  stateManager.addEvent('INFO', `Heading zero calibrated — magnetometer ${result.raw_heading_deg}° set as tunnel-forward (offset ${result.heading_offset_deg}°)`);
  stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
  res.json({ ...result, route_map: stateManager.getFullState().route_map });
});

// Route Mapping Control (v4 — dynamic map calibration)
// 8-second ceremony: samples the measured inter-node distances, rebuilds the
// map geometry from the REAL node placement, locks it (persisted across
// restarts). action 'clear' returns to the preset config layout.
app.post('/api/trajectory/calibrate-map', (req, res) => {
  const action = (req.body && req.body.action) || 'start';
  if (action === 'clear') {
    stateManager.trajectoryEngine.clearMapCalibration();
    stateManager.clearMapGeometryFile();
    stateManager.addEvent('INFO', 'Map geometry cleared — reverting to preset layout');
    stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
    return res.json({ success: true, route_map: stateManager.getFullState().route_map });
  }
  const result = stateManager.trajectoryEngine.startMapCalibration();
  if (!result.started) {
    return res.status(400).json({ success: false, error: result.reason });
  }
  stateManager.addEvent('INFO', `Map calibration started — measuring inter-node distances for ${result.duration_ms / 1000} s (keep all nodes stationary)`);
  stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
  res.json({ success: true, ...result });
});

// Range Calibration Control (v5 — two-point live path-loss fit)
// Hold the helmet at a known distance from NODE 2, POST {action:'capture',
// point:1|2, distance_m} — 8 s averaging per point. After both points the
// real path-loss curve (A, n) is fitted and drives every live distance.
// action 'clear' discards the curve.
app.post('/api/range-cal', (req, res) => {
  const action = (req.body && req.body.action) || 'capture';
  if (action === 'clear') {
    stateManager.rangeCalibrator.clear();
    stateManager.clearRangeCalFile();
    stateManager.calibrationEngine.disableHelmetOffset = false;
    stateManager.addEvent('INFO', 'Range calibration cleared — distances revert to firmware/model sources');
    stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
    return res.json({ success: true, range_cal: stateManager.rangeCalibrator.getState() });
  }
  const point = req.body && req.body.point;
  const distanceM = req.body && req.body.distance_m;
  const result = stateManager.rangeCalibrator.startCapture(point, distanceM);
  if (!result.started) {
    return res.status(400).json({ success: false, error: result.reason });
  }
  stateManager.addEvent('INFO',
    `Range calibration point ${point} — hold the helmet EXACTLY ${distanceM} m from NODE 2 for ${(result.duration_ms / 1000).toFixed(0)} s (keep it still)`);
  stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
  res.json({ success: true, ...result });
});

// Route Tracking Control (v6 — session start/stop)
// START: fresh session — path cleared, position re-fixes from relay beacons;
// from then on the route draws itself as the miner moves (step odometry when
// present, beacon signal + proximity pull when accelerometer data is absent).
// STOP: freeze the trajectory (calibrations keep running).
app.post('/api/tracking', (req, res) => {
  const action = (req.body && req.body.action) || 'start';
  if (action === 'stop') {
    const result = stateManager.trajectoryEngine.stopTracking();
    stateManager.addEvent('INFO', 'Route tracking paused — trajectory frozen');
    stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
    return res.json({ success: true, session: result, route_map: stateManager.getFullState().route_map });
  }
  const result = stateManager.trajectoryEngine.startTracking();
  stateManager.addEvent('INFO', 'Route tracking session started — position re-fixing from relay beacons');
  stateManager.notifyListeners('STATE_UPDATE', stateManager.getFullState());
  res.json({ success: true, session: result, route_map: stateManager.getFullState().route_map });
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

app.get('/dashboard/routemap', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/route_map.html'));
});

app.get('/routemap', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/route_map.html'));
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
  console.log(` Route Map        : http://localhost:${PORT}/dashboard/routemap`);
  console.log(` API Endpoint      : http://localhost:${PORT}/api/telemetry`);
  console.log(` Active Sources    : ${activeSources.join(' + ')}`);
  console.log(`=======================================================`);
});
