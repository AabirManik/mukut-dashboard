/*
=========================================================
        NODE 1 - SURFACE MASTER GATEWAY 
 (INDEPENDENT RANGING, TRI-NODE FUSION & AUTO-CALIBRATION)
=========================================================
*/

#include <SPI.h>
#include <LoRa.h>
#include <math.h>
#include <WiFi.h>
#include <WebServer.h>

// Wi-Fi Credentials
const char* ssid     = "Jayjit";
const char* password = "hfani358";

// Fallback Hotspot if no Wi-Fi is found
const char* ap_ssid  = "KAVACH_MASTER";
const char* ap_pass  = "12345678";

WebServer server(80);

#define LORA_SCK   18
#define LORA_MISO  19
#define LORA_MOSI  23
#define LORA_NSS   16
#define LORA_RESET 17
#define LORA_DIO0  26

unsigned long lastHelmetTime = 0, lastNode2Time = 0, lastNode3Time = 0;
unsigned long lastSerialPrint = 0; 
const unsigned long OFFLINE_TIMEOUT = 5000;

// Node 1 Independent Distance Tracking
float node1ToHelmetDist = -1.0; 
float node2ToHelmetDist = -1.0, node3ToNode2Dist = -1.0, node3ToHelmetDist = -1.0;
float rssiHelmet = 0, rssiNode2 = 0, rssiNode3 = 0;
float snrHelmet = 0.0, snrNode2 = 0.0, snrNode3 = 0.0;
bool firstHelmet = true, firstNode2 = true, firstNode3 = true;

// v2: Boot false-positive guard — a node is online ONLY if it was EVER heard.
// (millis() - 0 < OFFLINE_TIMEOUT is TRUE at boot with zero packets received,
// which made every node report online for the first 5 seconds after power-on.)
bool helmetEverHeard = false, n2EverHeard = false, n3EverHeard = false;

// v2: True helmet-link telemetry as measured by each relay's OWN radio and
// relayed via v2 packets/heartbeats. Distinct from rssiNode2/rssiNode3/snr*
// which are the N2->N1 / N3->N1 / Helmet->N1 trunk values heard by THIS gateway.
bool n2HelmetLink = false, n3HelmetLink = false;
float n2HelmetRssi = 0.0, n2HelmetSnr = 0.0, n3HelmetRssi = 0.0, n3HelmetSnr = 0.0;
float n3PeerRssi = 0.0, n3PeerSnr = 0.0; // node3's radio view of node2 (true N3-N2 link)

int n2Hazard = 0, n3Hazard = 0; 
String dWorker = "MINER 01", dStatus = "SAFE", dActiveRoute = "DIRECT";
String lastKnownNearestNode = "NODE02"; 

bool dMoving = false;
int dSteps = 0;
float dHeading = 0.0, dPosX = 0.0, dPosY = 0.0, dTemp = 24.5, dHum = 50.0;
int dMq6 = 150, dMq4 = 150, dMq8 = 150;

unsigned long bootTime = 0;
const unsigned long ANCHOR_CAL_SILENCE_MS = 8000;

// DYNAMIC RF DISTANCE PROFILES
const float RSSI_1M_HELMET = -42.0;  
const float PLE_HELMET = 2.8;        

const float RSSI_1M_STATIC = -45.0;  
const float PLE_STATIC = 2.2;

//=========================================================
// MUKUT-STYLE EMBEDDED WEBPAGE (HTML + CSS + JS)
//=========================================================
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MUKUT / Underground Network Monitoring</title>
    <style>
        :root { 
            --bg: #f5f6f8; --text: #1a1e23; --border: #ced4da; --card-bg: #ffffff; 
            --primary: #112031; --green-bg: #e6f9f0; --green-txt: #1b8755; --green-brd: #a3e7c8;
            --red-bg: #feebec; --red-txt: #d32f2f; --red-brd: #f8b4b4;
            --yel-bg: #fff8e6; --yel-txt: #b07d0b; --yel-brd: #ffe1a8;
            --mono: 'Consolas', 'Courier New', monospace;
        }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; text-transform: uppercase; font-size: 13px; }
        .container { max-width: 1200px; margin: 0 auto; }
        
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--primary); padding-bottom: 15px; margin-bottom: 20px; }
        .logo { font-size: 20px; font-weight: 900; letter-spacing: 2px; color: var(--primary); }
        .logo span { font-weight: 400; color: #6c757d; font-size: 14px; letter-spacing: 1px; }
        .tabs { display: flex; gap: 5px; }
        .tab { padding: 10px 15px; background: #e9ecef; color: #495057; font-weight: 700; cursor: pointer; border: 1px solid var(--border); transition: 0.2s; font-family: var(--mono); font-size: 12px; }
        .tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }
        
        .subheader { display: flex; justify-content: space-between; background: var(--card-bg); padding: 12px 20px; border: 1px solid var(--border); margin-bottom: 20px; font-family: var(--mono); font-size: 12px; }
        .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green-txt); margin-right: 5px; }
        .status-dot.red { background: var(--red-txt); }
        
        .view { display: none; }
        .view.active { display: block; }
        .card { background: var(--card-bg); border: 1px solid var(--border); padding: 20px; margin-bottom: 20px; }
        .card-header { font-weight: 700; color: #6c757d; margin-bottom: 15px; display: flex; justify-content: space-between; border-bottom: 1px dashed var(--border); padding-bottom: 10px; font-family: var(--mono); font-size: 11px; letter-spacing: 1px;}
        .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        
        .status-box { padding: 30px; border: 2px solid var(--green-brd); background: var(--green-bg); display: flex; flex-direction: column; justify-content: center; }
        .status-box.critical { border-color: var(--red-brd); background: var(--red-bg); }
        .status-box.warning { border-color: var(--yel-brd); background: var(--yel-bg); }
        .status-box h1 { margin: 0; font-size: 48px; color: var(--green-txt); letter-spacing: 2px; }
        .status-box.critical h1 { color: var(--red-txt); }
        .status-box.warning h1 { color: var(--yel-txt); }
        .status-box p { margin: 5px 0 0 0; color: #495057; font-family: var(--mono); }

        .metric-card { border: 1px solid var(--border); padding: 15px; position: relative; background: #fff; }
        .metric-card .badge { position: absolute; top: 15px; right: 15px; }
        .metric-card h2 { margin: 10px 0 0 0; font-size: 32px; font-weight: 900; color: var(--primary); }
        .metric-card span.unit { font-size: 16px; font-weight: 400; color: #6c757d; }
        .metric-card p { margin: 10px 0 0 0; font-size: 11px; color: #6c757d; font-family: var(--mono); }

        .gas-row { display: flex; align-items: center; justify-content: space-between; padding: 15px 0; border-bottom: 1px solid var(--border); font-family: var(--mono); }
        .gas-row:last-child { border-bottom: none; }
        .gas-name { width: 160px; font-weight: 700; font-family: sans-serif;}
        .gas-bar-container { flex-grow: 1; height: 8px; background: #e9ecef; margin: 0 20px; position: relative; }
        .gas-bar { height: 100%; background: var(--primary); transition: width 0.3s ease-out; }
        .gas-val { width: 120px; text-align: right; font-size: 18px; font-weight: 700; }
        
        .badge { padding: 4px 8px; font-family: var(--mono); font-weight: 800; border: 1px solid transparent; font-size: 11px; }
        .b-green { color: var(--green-txt); border-color: var(--green-brd); background: var(--green-bg); }
        .b-red { color: var(--red-txt); border-color: var(--red-brd); background: var(--red-bg); }
        .b-yel { color: var(--yel-txt); border-color: var(--yel-brd); background: var(--yel-bg); }

        table { width: 100%; border-collapse: collapse; font-family: var(--mono); }
        th { color: #6c757d; padding: 12px 10px; border-bottom: 2px solid var(--border); text-align: left; font-size: 11px; }
        td { padding: 15px 10px; border-bottom: 1px solid #e9ecef; vertical-align: middle; font-size: 12px; }
        .signal-bars { letter-spacing: -2px; font-weight: 900; font-size: 14px; }

        .slider-container { background: var(--border); height: 4px; border-radius: 2px; position: relative; margin: 40px 10px 20px 10px; }
        .slider-helmet { position: absolute; top: -18px; font-size: 26px; transition: left 0.4s ease-out; transform: translateX(-50%); }
        .nodes-label { display: flex; justify-content: space-between; font-weight: 600; font-size: 11px; color: #6c757d; font-family: var(--mono); }

        .topo-wrapper { display: flex; flex-direction: column; align-items: center; padding: 10px 0; }
        .topo-box { width: 480px; border: 2px solid var(--primary); padding: 14px 20px; background: #fff; position: relative; text-align: left; }
        .topo-box .node-tag { font-size: 10px; color: #6c757d; font-family: var(--mono); font-weight: 700; }
        .topo-box .node-name { font-size: 20px; font-weight: 900; margin: 2px 0; color: var(--primary); }
        .topo-box .node-desc { font-size: 11px; color: #6c757d; font-family: var(--mono); }
        .topo-box .badge { position: absolute; top: 14px; right: 18px; }
        .topo-pipe { width: 4px; height: 26px; background: var(--primary); margin: 0 auto; }
        .topo-pipe.red { background: var(--red-txt); }
        .topo-link { width: 340px; border: 1px solid var(--border); background: #f8fafc; padding: 6px 14px; font-family: var(--mono); display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin: 0 auto; }

        .route-path { display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-weight: 700; margin-top: 15px; }
        .route-box { border: 2px solid var(--primary); padding: 6px 12px; background: #fff; color: var(--primary); }
        .route-box.active { background: var(--primary); color: #fff; }
        .route-box.dead { background: var(--red-txt); border-color: var(--red-txt); color: #fff; }
        
        .alert-box { background: var(--red-bg); border-left: 4px solid var(--red-txt); padding: 12px; margin-bottom: 15px; font-family: sans-serif; font-weight: bold; }
        
        #pathCanvas { background: #0b131d; width: 100%; height: 480px; border: 2px solid var(--primary); }
    </style>
</head>
<body>
    <div class="container">
        <!-- HEADER -->
        <div class="header">
            <div class="logo">MUKUT <span>/ UNDERGROUND NETWORK MONITORING</span></div>
            <div class="tabs">
                <div class="tab" onclick="switchTab('safety', this)">SAFETY OVERVIEW</div>
                <div class="tab" onclick="switchTab('network', this)">UNDERGROUND NETWORK</div>
                <div class="tab active" onclick="switchTab('mapping', this)">PATH MAPPING</div>
                <div class="tab" onclick="switchTab('routing', this)">ROUTING & FAILOVER</div>
            </div>
        </div>

        <div class="subheader">
            <div>DATA SOURCE: <span style="color:#d9730d">LIVE TELEMETRY</span> &nbsp;|&nbsp; LAST UPDATE: <span id="uptime">Just now</span></div>
            <div style="border:1px solid var(--border); padding: 2px 8px; background: #fff;">
                <span class="status-dot" id="dot-main"></span><span id="helmet-conn-state">HELMET01 ONLINE</span>
            </div>
        </div>

        <div id="alerts-container"></div>

        <!-- VIEW 1: SAFETY OVERVIEW -->
        <div id="safety" class="view">
            <div class="card status-box" id="safe-banner">
                <div class="card-header" style="border:none; padding:0; margin-bottom:5px;">WORKER SAFETY STATUS <span style="font-family:var(--mono)" id="safe-code">[ CODE 00: NOMINAL ]</span></div>
                <h1 id="safe-h1">SAFE</h1>
                <p id="safe-p">Nominal conditions — No emergency detected</p>
            </div>

            <div class="grid-3">
                <div class="metric-card">
                    <div class="card-header" style="border:none; padding:0; margin:0;">TEMPERATURE</div>
                    <span class="badge b-green" id="b-temp">NORMAL</span>
                    <h2><span id="ui-temp">--</span><span class="unit"> °C</span></h2>
                    <p>Threshold: >38.0°C Warn | >45.0°C Crit</p>
                </div>
                <div class="metric-card">
                    <div class="card-header" style="border:none; padding:0; margin:0;">HUMIDITY</div>
                    <span class="badge b-green" id="b-hum">NORMAL</span>
                    <h2><span id="ui-hum">--</span><span class="unit"> %</span></h2>
                    <p>Threshold: >85% Warn | >95% Crit</p>
                </div>
                <div class="metric-card">
                    <div class="card-header" style="border:none; padding:0; margin:0;">EMERGENCY SOS</div>
                    <span class="badge b-green" id="b-sos">INACTIVE</span>
                    <h2 id="ui-sos" style="color:var(--text)">INACTIVE</h2>
                    <p>Hardware Panic Button State</p>
                </div>
            </div>

            <div class="card">
                <div class="card-header">ATMOSPHERIC GAS MONITORING <span class="badge b-green" id="b-gas-all">ATMOSPHERE: NORMAL</span></div>
                <div class="gas-row">
                    <div class="gas-name">CH₄ <span style="color:#6c757d; font-weight:normal">Methane</span></div>
                    <div class="gas-bar-container"><div class="gas-bar" id="fill-ch4" style="width: 0%;"></div></div>
                    <div class="gas-val"><span id="txt-ch4">--</span> <span style="font-size:12px; color:#6c757d">ppm</span></div>
                    <div style="width:80px; text-align:right;"><span class="badge b-green" id="bad-ch4">NORMAL</span></div>
                </div>
                <div class="gas-row">
                    <div class="gas-name">CO / LPG <span style="color:#6c757d; font-weight:normal">Combustible</span></div>
                    <div class="gas-bar-container"><div class="gas-bar" id="fill-lpg" style="width: 0%;"></div></div>
                    <div class="gas-val"><span id="txt-lpg">--</span> <span style="font-size:12px; color:#6c757d">ppm</span></div>
                    <div style="width:80px; text-align:right;"><span class="badge b-green" id="bad-lpg">NORMAL</span></div>
                </div>
                <div class="gas-row">
                    <div class="gas-name">H₂ <span style="color:#6c757d; font-weight:normal">Hydrogen/Smoke</span></div>
                    <div class="gas-bar-container"><div class="gas-bar" id="fill-h2" style="width: 0%;"></div></div>
                    <div class="gas-val"><span id="txt-h2">--</span> <span style="font-size:12px; color:#6c757d">ppm</span></div>
                    <div style="width:80px; text-align:right;"><span class="badge b-green" id="bad-h2">NORMAL</span></div>
                </div>
            </div>
        </div>

        <!-- VIEW 2: UNDERGROUND NETWORK -->
        <div id="network" class="view">
            <div class="subheader" style="background:#fff; border-color:var(--border);">
                <div>OVERALL NETWORK HEALTH: <span class="badge b-green" id="net-health-badge">HEALTH: GOOD</span></div>
                <div style="font-weight:bold; font-family:var(--mono)" id="net-active-route">HELMET01 ➔ NODE03 ➔ NODE02 ➔ GATEWAY</div>
                <div>CONNECTED TARGET: <b id="net-target">NODE03</b></div>
            </div>

            <div style="display:flex; gap:20px; margin-bottom:20px;">
                <div class="card" style="flex-grow:2; margin:0;">
                    <div class="card-header">INTER-NODE LINK METRICS <span style="float:right; color:var(--text)" id="active-link-count">3 / 3 ACTIVE LINKS</span></div>
                    <table>
                        <tr><th>LINK SEGMENT</th><th>RSSI</th><th>SIGNAL</th><th>EST. DISTANCE</th><th>QUALITY</th><th>STATUS</th></tr>
                        <tr>
                            <td>HELMET01 ⟷ <span id="tbl-h-dest">NODE02</span></td>
                            <td id="t-h-rssi">-- dBm</td>
                            <td id="t-h-sig" class="signal-bars">||||</td>
                            <td id="t-h-dist">-- m</td>
                            <td><span class="badge b-green" id="t-h-qual">EXCELLENT</span></td>
                            <td><span class="badge b-green" id="t-h-stat">CONNECTED</span></td>
                        </tr>
                        <tr>
                            <td>NODE03 ⟷ NODE02</td>
                            <td id="t-n3-rssi">-- dBm</td>
                            <td id="t-n3-sig" class="signal-bars">||||</td>
                            <td id="t-n3-dist">-- m</td>
                            <td><span class="badge b-green" id="t-n3-qual">EXCELLENT</span></td>
                            <td><span class="badge b-green" id="t-n3-stat">CONNECTED</span></td>
                        </tr>
                        <tr>
                            <td>NODE02 ⟷ SURFACE</td>
                            <td id="t-n2-rssi">-- dBm</td>
                            <td id="t-n2-sig" class="signal-bars">|||</td>
                            <td>FIXED</td>
                            <td><span class="badge b-green" id="t-n2-qual">GOOD</span></td>
                            <td><span class="badge b-green" id="t-n2-stat">CONNECTED</span></td>
                        </tr>
                    </table>
                </div>
                <div class="card" style="flex-grow:1; margin:0;">
                    <div class="card-header">SYSTEM DIAGNOSTICS <span class="badge b-green" style="float:right" id="diag-status-badge">ALL NOMINAL</span></div>
                    <div style="display:flex; justify-content:space-between; padding:15px 0; border-bottom:1px solid #f0f0f0; font-family:var(--mono)"><span>NODES ONLINE:</span><strong id="diag-nodes">3 / 3 ONLINE</strong></div>
                    <div style="display:flex; justify-content:space-between; padding:15px 0; border-bottom:1px solid #f0f0f0; font-family:var(--mono)"><span>LORA FREQUENCY:</span><strong>433.00 MHz</strong></div>
                    <div style="display:flex; justify-content:space-between; padding:15px 0; border-bottom:1px solid #f0f0f0; font-family:var(--mono)"><span>NODE 2 STRUCT:</span><strong id="diag-n2-h" style="color:var(--green-txt)">STABLE</strong></div>
                    <div style="display:flex; justify-content:space-between; padding:15px 0; font-family:var(--mono)"><span>NODE 3 STRUCT:</span><strong id="diag-n3-h" style="color:var(--green-txt)">STABLE</strong></div>
                </div>
            </div>

            <!-- THE SLIDER -->
            <div class="card">
                <div class="card-header">1D SPATIAL PROXIMITY SOLVER <span style="float:right">ENGINE: MUKUT RELATIVE RSSI</span></div>
                <div class="slider-container">
                    <div id="helmet-slider" class="slider-helmet">👷</div>
                </div>
                <div class="nodes-label">
                    <span>[ NODE 2 ] <span id="dist-n2">-- m</span></span>
                    <span>[ NODE 3 ] <span id="dist-n3">-- m</span></span>
                </div>
                <div style="text-align:center; color:#6c757d; font-family:var(--mono); margin-top:20px; font-size:11px;">
                    STATIC ANCHOR SPACING: <span id="fixed-dist">--</span> m &nbsp;|&nbsp; LAST KNOWN LOCATION: <b style="color:var(--text)" id="ui-last">--</b>
                </div>
            </div>
        </div>

        <!-- VIEW 3: 2D PATH MAPPING (STEP-DRIVEN HARDCODED CORRIDOR PROGRESSION) -->
        <div id="mapping" class="view active">
            <div class="card">
                <div class="card-header">MAGNETOMETER & ODOMETRY 2D CORRIDOR MAPPING <span>[ ENGINE: STEP-DRIVEN CORRIDOR PROGRESSION ]</span></div>
                <p style="font-family:var(--mono); color:var(--muted); margin-bottom:15px;">Real-time linear tracking along the hardcoded underground corridor with controlled micro zig-zag motion. Position updates exclusively on active step counts and remains completely frozen during stationary periods.</p>
                <canvas id="pathCanvas"></canvas>
                <div style="display:flex; justify-content:space-between; margin-top:15px; font-family:var(--mono); font-size:12px;">
                    <div>TOTAL STEPS: <b id="map-steps">0</b></div>
                    <div>TOTAL DISTANCE: <b id="map-dist">0.0 m</b></div>
                    <div>MOTION STATE: <b id="map-state">STATIONARY</b></div>
                </div>
            </div>
        </div>

        <!-- VIEW 4: ROUTING & FAILOVER -->
        <div id="routing" class="view">
            <div class="card status-box" id="route-banner" style="background:#e6f9f0; border-color:#a3e7c8; padding:30px;">
                <div class="card-header" style="border:none; padding:0; margin-bottom:15px;">DYNAMIC ROUTE CONTROLLER <span style="font-family:var(--mono)" id="route-mode-code">[ STATUS: NORMAL / PRIMARY ROUTE ]</span></div>
                <h1 id="route-h1">NORMAL</h1>
                <p id="route-desc" style="margin-bottom: 20px;">Optimal multi-hop path nominal across underground relay stations.</p>
                <div style="font-family:var(--mono); font-weight:bold; font-size:14px;" id="route-boxes-wrap"></div>
            </div>
        </div>
    </div>

    <script>
        function switchTab(tab, el) {
            document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
            document.getElementById(tab).classList.add('active');
            el.classList.add('active');
            if(tab === 'mapping') initCanvas();
        }

        function safeSetText(id, txt) { let el = document.getElementById(id); if (el) el.innerText = txt; }
        function safeSetHTML(id, html) { let el = document.getElementById(id); if (el) el.innerHTML = html; }
        function safeSetClass(id, cls) { let el = document.getElementById(id); if (el) el.className = cls; }

        function getSigBar(rssi, online) {
            if (!online || rssi == 0 || rssi <= -100) return "<span style='color:#ced4da'>||||</span>";
            if (rssi > -60) return "||||";
            if (rssi > -75) return "|||<span style='color:#ced4da'>|</span>";
            if (rssi > -88) return "||<span style='color:#ced4da'>||</span>";
            return "|<span style='color:#ced4da'>|||</span>";
        }

        // Step-Driven Corridor Path Mapping Engine
        let lastKnownSteps = -1;
        let stepIndex = 0;
        const maxStepsForCrossing = 20; // total steps to traverse from Node 02 to Node 03

        function initCanvas() {
            let canvas = document.getElementById('pathCanvas');
            if(!canvas) return;
            canvas.width = canvas.parentElement.clientWidth - 40;
            canvas.height = 480;
            drawCorridor(stepIndex / maxStepsForCrossing);
        }

        function drawCorridor(progress) {
            let canvas = document.getElementById('pathCanvas');
            if(!canvas) return;
            let ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0b131d';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw technical grid background
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            let gridSize = 45;
            for(let x=0; x<canvas.width; x+=gridSize) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
            for(let y=0; y<canvas.height; y+=gridSize) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }

            let cx = canvas.width / 2;
            let cy = canvas.height / 2;

            // Hardcoded corridor start and end points
            let startX = cx - 180, startY = cy - 120;
            let endX = cx + 180, endY = cy + 120;

            // Draw straight underground tunnel track
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 36;
            ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();

            // Draw Node 02 & Node 03 Markers
            ctx.fillStyle = '#38bdf8';
            ctx.font = '12px monospace';
            ctx.fillText("NODE 02 (START HUB)", startX - 60, startY - 20);
            ctx.beginPath(); ctx.arc(startX, startY, 7, 0, 2*Math.PI); ctx.fill();

            ctx.fillStyle = '#34d399';
            ctx.fillText("NODE 03 (WORKING FACE)", endX - 80, endY + 25);
            ctx.beginPath(); ctx.arc(endX, endY, 7, 0, 2*Math.PI); ctx.fill();

            // Clamped progression
            let p = Math.max(0, Math.min(1, progress));

            // Calculate current exact position along corridor vector
            let minerX = startX + (endX - startX) * p;
            let minerY = startY + (endY - startY) * p;

            // Add controlled minor zig-zag motion for realistic tunnel walk
            if (p > 0 && p < 1) {
                let zigZag = Math.sin(p * 25) * 6;
                minerX += zigZag * 0.7;
                minerY -= zigZag * 0.7;
            }

            // Draw yellow traversed path
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(minerX, minerY); ctx.stroke();

            // Draw Miner Avatar properly offset so it's fully visible
            ctx.fillStyle = '#ef4444';
            ctx.beginPath(); ctx.arc(minerX, minerY, 8, 0, 2*Math.PI); ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = '11px monospace';
            ctx.fillText("👷 MINER 01", minerX + 12, minerY + 4);
        }

        function updateUI() {
            fetch('/api/telemetry')
                .then(r => r.json())
                .then(d => {
                    let hOn  = d.mesh_topology.helmet_direct.online;
                    let n2On = d.mesh_topology.node2_relay.online;
                    let n3On = d.mesh_topology.node3_relay.online;
                    let risk = d.system.overall_risk_index;
                    let nearest = d.mesh_topology.tunnel_position.nearest_node || "NODE02";

                    safeSetText('helmet-conn-state', hOn ? "HELMET01 ONLINE" : "HELMET01 OFFLINE");
                    safeSetClass('dot-main', hOn ? "status-dot" : "status-dot red");

                    // Step & Motion Tracking for 2D Map
                    let steps = d.miner.step_count;
                    let isMoving = d.miner.motion_state === "MOVING";
                    safeSetText('map-steps', steps);
                    safeSetText('map-dist', d.miner.total_distance_m + " m");
                    safeSetText('map-state', isMoving ? "MOVING (STEP INCREMENT)" : "STATIONARY (FROZEN)");

                    // Initialize baseline step count on first load
                    if (lastKnownSteps === -1) {
                        lastKnownSteps = steps;
                    }

                    // Only advance position when step count physically increases
                    if (steps > lastKnownSteps) {
                        let stepDelta = steps - lastKnownSteps;
                        lastKnownSteps = steps;
                        stepIndex += stepDelta;
                        if (stepIndex > maxStepsForCrossing) stepIndex = maxStepsForCrossing;
                        drawCorridor(stepIndex / maxStepsForCrossing);
                    } else if (steps === 0 && stepIndex > 0) {
                        stepIndex = 0;
                        drawCorridor(0);
                    }

                    let alertsHtml = "";
                    if(d.active_emergencies) {
                        d.active_emergencies.forEach(e => {
                            alertsHtml += `<div class="alert-box">🚨 <b>${e.source} EMERGENCY:</b> ${e.message}</div>`;
                        });
                    }
                    if(d.active_alerts) {
                        d.active_alerts.forEach(e => {
                            alertsHtml += `<div class="alert-box" style="background:#fff8e6; border-color:#d97706; color:#d97706;">⚠️ <b>${e.source} WARNING:</b> ${e.message}</div>`;
                        });
                    }
                    safeSetHTML('alerts-container', alertsHtml);

                    // Safety View Banner
                    let safeBox = document.getElementById('safe-banner');
                    if (safeBox) {
                        if (!hOn || risk === "HIGH") {
                            safeBox.className = "card status-box critical";
                            safeSetText('safe-code', "[ CODE 99: CRITICAL HAZARD ]");
                            safeSetText('safe-h1', !hOn ? "CONNECTION LOST" : d.miner.status);
                            safeSetText('safe-p', !hOn ? "Casualty detected. Helmet offline. Dispatch rescue to last known location: " + nearest : "Hazardous condition detected.");
                        } else {
                            safeBox.className = "card status-box";
                            safeSetText('safe-code', "[ CODE 00: NOMINAL ]");
                            safeSetText('safe-h1', "SAFE");
                            safeSetText('safe-p', "Nominal conditions — No emergency detected");
                        }
                    }

                    safeSetText('ui-temp', d.environment.temperature_c);
                    safeSetText('ui-hum', d.environment.humidity_pct);
                    let isSos = d.miner.status === "SOS EMERGENCY";
                    safeSetText('b-sos', isSos ? "ACTIVE" : "INACTIVE");
                    safeSetText('ui-sos', isSos ? "ACTIVE" : "INACTIVE");

                    let ch4 = d.environment.mq4_methane_ppm;
                    safeSetText('txt-ch4', ch4);
                    let fCh4 = document.getElementById('fill-ch4');
                    if (fCh4) fCh4.style.width = Math.min((ch4/800)*100, 100) + "%";

                    let lpg = d.environment.mq6_lpg_ppm;
                    safeSetText('txt-lpg', lpg);
                    let fLpg = document.getElementById('fill-lpg');
                    if (fLpg) fLpg.style.width = Math.min((lpg/800)*100, 100) + "%";

                    let h2 = d.environment.mq8_hydrogen_ppm;
                    safeSetText('txt-h2', h2);
                    let fH2 = document.getElementById('fill-h2');
                    if (fH2) fH2.style.width = Math.min((h2/800)*100, 100) + "%";

                    // Network Tab
                    let onCount = (hOn?1:0) + (n2On?1:0) + (n3On?1:0);
                    safeSetText('net-health-badge', onCount === 3 ? "HEALTH: GOOD" : "HEALTH: DEGRADED");
                    safeSetText('net-target', nearest);
                    safeSetText('net-active-route', d.system.active_route);

                    let hDistVal = 0;
                    if(nearest === "NODE03") hDistVal = d.mesh_topology.node3_relay.distance_to_helmet_m;
                    else if (nearest === "SURFACE") hDistVal = d.mesh_topology.helmet_direct.distance_to_helmet_m;
                    else hDistVal = d.mesh_topology.node2_relay.distance_to_helmet_m;

                    let hRssiVal = d.mesh_topology.helmet_direct.rssi_dbm;

                    safeSetText('tbl-h-dest', nearest);
                    safeSetText('t-h-rssi', hOn ? hRssiVal + " dBm" : "---");
                    safeSetHTML('t-h-sig', getSigBar(hRssiVal, hOn));
                    safeSetText('t-h-dist', hDistVal > 0 ? "EST. " + hDistVal + " m" : "---");

                    let fixedD = d.mesh_topology.node2_relay.distance_to_node3_m;
                    let n3R = d.mesh_topology.node3_relay.rssi_dbm;
                    safeSetText('t-n3-rssi', n3On ? n3R + " dBm" : "---");
                    safeSetHTML('t-n3-sig', getSigBar(n3R, n3On));
                    safeSetText('t-n3-dist', fixedD > 0 ? "EST. " + fixedD + " m" : "---");

                    let n2R = d.mesh_topology.node2_relay.rssi_dbm;
                    safeSetText('t-n2-rssi', n2On ? n2R + " dBm" : "---");
                    safeSetHTML('t-n2-sig', getSigBar(n2R, n2On));

                    safeSetText('active-link-count', onCount + " / 3 ACTIVE LINKS");
                    safeSetText('diag-nodes', onCount + " / 3 ONLINE");

                    // Slider & Proximity Solver
                    let sEl = document.getElementById('helmet-slider');
                    if (sEl) sEl.style.left = d.mesh_topology.tunnel_position.relative_slider_pct + "%";
                    safeSetText('dist-n2', d.mesh_topology.node2_relay.distance_to_helmet_m > 0 ? d.mesh_topology.node2_relay.distance_to_helmet_m + " m" : "--");
                    safeSetText('dist-n3', d.mesh_topology.node3_relay.distance_to_helmet_m > 0 ? d.mesh_topology.node3_relay.distance_to_helmet_m + " m" : "--");
                    safeSetText('fixed-dist', fixedD > 0 ? fixedD : "--");
                    safeSetText('ui-last', nearest);

                    // Routing Tab
                    let rb = document.getElementById('route-banner');
                    let rtStr = d.system.active_route;
                    if (rb) {
                        if (!hOn) {
                            rb.className = "card status-box critical";
                            safeSetText('route-mode-code', "[ STATUS: CRITICAL / NO ROUTE ]");
                            safeSetText('route-h1', "NO ROUTE");
                            safeSetHTML('route-boxes-wrap', "<div class='route-box dead' style='display:inline-block'>NO USABLE PATH (HELMET OFFLINE)</div>");
                        } else {
                            rb.className = "card status-box"; rb.style.borderColor = "var(--green-brd)"; rb.style.background = "var(--green-bg)";
                            safeSetText('route-mode-code', "[ STATUS: NORMAL / PRIMARY ROUTE ]");
                            safeSetText('route-h1', "NORMAL");
                            let rHtml = "<div class='route-path'><div class='route-box active'>HELMET01</div> ➔ ";
                            if (rtStr.indexOf("Node 3") !== -1) {
                                rHtml += "<div class='route-box'>NODE03</div> ➔ <div class='route-box'>NODE02</div> ➔ ";
                            } else if (rtStr.indexOf("Node 2") !== -1) {
                                rHtml += "<div class='route-box'>NODE02</div> ➔ ";
                            }
                            rHtml += "<div class='route-box active'>GATEWAY</div></div>";
                            safeSetHTML('route-boxes-wrap', rHtml);
                        }
                    }
                })
                .catch(e => console.log("Fetch Er:", e));
        }

        window.onload = () => { initCanvas(); };
        setInterval(updateUI, 500);
        updateUI();
    </script>
</body>
</html>
)rawliteral";

//=========================================================
// SIGNAL & MATH HELPERS
//=========================================================
float smoothValue(float current, float target, float lockFactor) {
    if (current <= 0.0) return target; 
    return (current * lockFactor) + (target * (1.0 - lockFactor));
}

float calculateDistance(float rssi, bool isHelmet) {
    if (rssi == 0 || rssi < -120) return -1.0; 
    float refRSSI = isHelmet ? RSSI_1M_HELMET : RSSI_1M_STATIC;
    float ple = isHelmet ? PLE_HELMET : PLE_STATIC;

    if (rssi > refRSSI) {
        float subMeter = 1.0 - ((rssi - refRSSI) * 0.05);
        return (subMeter < 0.1) ? 0.1 : subMeter; 
    }
    
    float distance = pow(10.0, (refRSSI - rssi) / (10.0 * ple));
    if (distance > 30.0) return 30.0; 
    return distance;
}

float smoothRSSI(float current, int raw, bool &isFirst) {
    if (isFirst) { isFirst = false; return raw; }
    float alpha = (raw < current) ? 0.30 : 0.10;
    return (alpha * raw) + ((1.0 - alpha) * current);
}

int calculateSignalPct(float rssi) {
    if (rssi == 0 || rssi <= -100) return 0;
    if (rssi >= -50) return 100;
    return map((int)rssi, -100, -50, 10, 100);
}

String getSignalQuality(float rssi) {
    if (rssi == 0) return "N/A";
    if (rssi >= -55) return "EXCELLENT";
    if (rssi >= -70) return "GOOD";
    if (rssi >= -85) return "FAIR";
    return "POOR";
}

String getHazardStatusText(int level) {
    if (level == 2) return "CRITICAL_HAZARD";
    if (level == 1) return "WARNING_SHIFT";
    return "STABLE";
}

String getCardinalDirection(float h) {
    if (h >= 337.5 || h < 22.5)  return "NORTH";
    if (h >= 22.5  && h < 67.5)  return "NORTH-EAST";
    if (h >= 67.5  && h < 112.5) return "EAST";
    if (h >= 112.5 && h < 157.5) return "SOUTH-EAST";
    if (h >= 157.5 && h < 202.5) return "SOUTH";
    if (h >= 202.5 && h < 247.5) return "SOUTH-WEST";
    if (h >= 247.5 && h < 292.5) return "WEST";
    if (h >= 292.5 && h < 337.5) return "NORTH-WEST";
    return "UNKNOWN";
}

String getValue(String data, char separator, int index) {
    int found = 0; int strIndex[] = {0, -1}; int maxIndex = data.length() - 1;
    for (int i = 0; i <= maxIndex && found <= index; i++) {
        if (data.charAt(i) == separator || i == maxIndex) { found++; strIndex[0] = strIndex[1] + 1; strIndex[1] = (i == maxIndex) ? i + 1 : i; }
    } return found > index ? data.substring(strIndex[0], strIndex[1]) : "";
}

String getRSSIBar(float rssi) {
    if (rssi == 0) return "[          ]";
    if (rssi >= -55) return "[||||||||||]";
    if (rssi >= -70) return "[||||||||  ]";
    if (rssi >= -85) return "[||||||    ]";
    if (rssi >= -100) return "[||||      ]";
    return "[||        ]";
}

String generateSlider(float d2, float d3) {
    if (d2 < 0 || d3 < 0) return "   [ NODE 2 ] ???????????????????? [ NODE 3 ]";
    int barLen = 20;
    float total = d2 + d3;
    int pos = (total > 0) ? round((d2 / total) * barLen) : barLen / 2;
    if (pos < 0) pos = 0;
    if (pos > barLen) pos = barLen;
    
    String slider = "   [ NODE 2 ] ";
    for (int i = 0; i <= barLen; i++) {
        if (i == pos) slider += "👷";
        else slider += "-";
    }
    slider += " [ NODE 3 ]";
    return slider;
}

//=========================================================
// API & WEBSERVER HANDLERS
//=========================================================
void handleRoot() { server.send(200, "text/html", index_html); }

void handleTelemetryAPI() {
    // v2: everHeard guard kills the boot false-positive (all-online window).
    bool helmetOnline = helmetEverHeard && (millis() - lastHelmetTime) < OFFLINE_TIMEOUT;
    bool node2Online  = n2EverHeard  && (millis() - lastNode2Time)  < OFFLINE_TIMEOUT;
    bool node3Online  = n3EverHeard  && (millis() - lastNode3Time)  < OFFLINE_TIMEOUT;

    // v2: true helmet-link / peer measurements as JSON values
    // ("null" when the relay never measured one — dashboard falls back).
    String n2HRssi = (n2HelmetRssi != 0.0) ? String(n2HelmetRssi, 1) : String("null");
    String n2HSnr  = (n2HelmetSnr  != 0.0) ? String(n2HelmetSnr, 2)  : String("null");
    String n3HRssi = (n3HelmetRssi != 0.0) ? String(n3HelmetRssi, 1) : String("null");
    String n3HSnr  = (n3HelmetSnr  != 0.0) ? String(n3HelmetSnr, 2)  : String("null");
    String n3PRssi = (n3PeerRssi   != 0.0) ? String(n3PeerRssi, 1)   : String("null");
    String n3PSnr  = (n3PeerSnr    != 0.0) ? String(n3PeerSnr, 2)    : String("null");

    float relSliderPct = 50.0;
    if (node2ToHelmetDist >= 0 && node3ToHelmetDist >= 0) { 
        relSliderPct = (node2ToHelmetDist / (node2ToHelmetDist + node3ToHelmetDist)) * 100.0;
    }

    String json;
    json.reserve(2600);
    
    json = "{";
    json += "\"system\":{\"gateway_id\":\"NODE_1_SURFACE\",\"uptime_ms\":" + String(millis()) + ",\"active_route\":\"" + dActiveRoute + "\",\"overall_risk_index\":\"" + String((n2Hazard == 2 || n3Hazard == 2 || dStatus != "SAFE" || !helmetOnline) ? "HIGH" : (n2Hazard == 1 || n3Hazard == 1 ? "ELEVATED" : "LOW")) + "\"},";
    json += "\"miner\":{\"worker_id\":\"" + dWorker + "\",\"motion_state\":\"" + String(dMoving ? "MOVING" : "STATIONARY") + "\",\"step_count\":" + String(dSteps) + ",\"total_distance_m\":" + String(dSteps * 0.70, 1) + ",\"heading_deg\":" + String(dHeading, 1) + ",\"direction_cardinal\":\"" + getCardinalDirection(dHeading) + "\",\"battery_pct\":94,\"status\":\"" + String(helmetOnline ? dStatus : "OFFLINE_CASUALTY") + "\"},";
    json += "\"environment\":{\"temperature_c\":" + String(dTemp, 1) + ",\"humidity_pct\":" + String(dHum, 1) + ",\"mq6_lpg_ppm\":" + String(dMq6) + ",\"mq4_methane_ppm\":" + String(dMq4) + ",\"mq8_hydrogen_ppm\":" + String(dMq8) + "},";
    json += "\"mesh_topology\":{";
    json += "\"node2_relay\":{\"online\":" + String(node2Online ? "true" : "false") + ",\"rssi_dbm\":" + String((int)rssiNode2) + ",\"snr_db\":" + String(snrNode2, 2) + ",\"signal_pct\":" + String(calculateSignalPct(rssiNode2)) + ",\"signal_quality\":\"" + getSignalQuality(rssiNode2) + "\",\"distance_to_helmet_m\":" + String(node2ToHelmetDist, 1) + ",\"distance_to_node3_m\":" + String(node3ToNode2Dist, 1) + ",\"hazard_level\":" + String(node2Online ? n2Hazard : 0) + ",\"hazard_status\":\"" + getHazardStatusText(node2Online ? n2Hazard : 0) + "\",\"helmet_link\":" + String(n2HelmetLink ? "true" : "false") + ",\"helmet_rssi_db\":" + n2HRssi + ",\"helmet_snr_db\":" + n2HSnr + "},";
    json += "\"node3_relay\":{\"online\":" + String(node3Online ? "true" : "false") + ",\"rssi_dbm\":" + String((int)rssiNode3) + ",\"snr_db\":" + String(snrNode3, 2) + ",\"signal_pct\":" + String(calculateSignalPct(rssiNode3)) + ",\"signal_quality\":\"" + getSignalQuality(rssiNode3) + "\",\"distance_to_helmet_m\":" + String(node3ToHelmetDist, 1) + ",\"hazard_level\":" + String(node3Online ? n3Hazard : 0) + ",\"hazard_status\":\"" + getHazardStatusText(node3Online ? n3Hazard : 0) + "\",\"helmet_link\":" + String(n3HelmetLink ? "true" : "false") + ",\"helmet_rssi_db\":" + n3HRssi + ",\"helmet_snr_db\":" + n3HSnr + ",\"peer_rssi_db\":" + n3PRssi + ",\"peer_snr_db\":" + n3PSnr + "},";
    json += "\"helmet_direct\":{\"online\":" + String(helmetOnline ? "true" : "false") + ",\"rssi_dbm\":" + String((int)rssiHelmet) + ",\"snr_db\":" + String(snrHelmet, 2) + ",\"signal_pct\":" + String(calculateSignalPct(rssiHelmet)) + ",\"signal_quality\":\"" + getSignalQuality(rssiHelmet) + "\",\"distance_to_helmet_m\":" + String(node1ToHelmetDist, 1) + "},";
    json += "\"tunnel_position\":{\"nearest_node\":\"" + lastKnownNearestNode + "\",\"relative_slider_pct\":" + String(relSliderPct, 1) + "}},";
    
    json += "\"active_alerts\":[";
    bool hasAlert = false;
    if (helmetOnline && dTemp >= 40.0) { json += "{\"type\":\"WARNING\",\"source\":\"HELMET\",\"message\":\"High Ambient Temperature (" + String(dTemp, 1) + "°C)\"}"; hasAlert = true; }
    if (node2Online && n2Hazard == 1) { if (hasAlert) json += ","; json += "{\"type\":\"WARNING\",\"source\":\"NODE_2\",\"message\":\"Minor Pipeline Tilt/Vibration Detected\"}"; hasAlert = true; }
    if (node3Online && n3Hazard == 1) { if (hasAlert) json += ","; json += "{\"type\":\"WARNING\",\"source\":\"NODE_3\",\"message\":\"Minor Pipeline Tilt/Vibration Detected\"}"; }
    json += "],";

    json += "\"active_emergencies\":[";
    bool hasEmerg = false;
    if (!helmetOnline && dWorker != "WAITING...") { json += "{\"type\":\"CRITICAL\",\"source\":\"SYSTEM\",\"message\":\"MINER SIGNAL LOST! Last seen near: " + lastKnownNearestNode + "\"}"; hasEmerg = true; }
    if (helmetOnline && dStatus == "SOS EMERGENCY") { if (hasEmerg) json += ","; json += "{\"type\":\"CRITICAL\",\"source\":\"HELMET\",\"message\":\"SOS Alarm! Dispatch Rescue to: " + lastKnownNearestNode + "\"}"; hasEmerg = true; }
    if (helmetOnline && dMq6 >= 1000) { if (hasEmerg) json += ","; json += "{\"type\":\"CRITICAL\",\"source\":\"HELMET\",\"message\":\"Hazardous LPG Gas Leak\"}"; hasEmerg = true; }
    if (helmetOnline && dMq4 >= 1000) { if (hasEmerg) json += ","; json += "{\"type\":\"CRITICAL\",\"source\":\"HELMET\",\"message\":\"Hazardous Methane Leak\"}"; hasEmerg = true; }
    if (node2Online && n2Hazard == 2) { if (hasEmerg) json += ","; json += "{\"type\":\"CRITICAL\",\"source\":\"NODE_2\",\"message\":\"Structural Collapse at Node 2\"}"; hasEmerg = true; }
    if (node3Online && n3Hazard == 2) { if (hasEmerg) json += ","; json += "{\"type\":\"CRITICAL\",\"source\":\"NODE_3\",\"message\":\"Structural Collapse at Node 3\"}"; }
    json += "]}";

    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(200, "application/json", json);
}

//=========================================================
// SERIAL MONITOR DASHBOARD
//=========================================================
void printSerialDashboard() {
    // v2: everHeard guard (same fix as the API handler)
    bool node2Online  = n2EverHeard  && (millis() - lastNode2Time)  < OFFLINE_TIMEOUT;
    bool node3Online  = n3EverHeard  && (millis() - lastNode3Time)  < OFFLINE_TIMEOUT;
    bool helmetOnline = helmetEverHeard && (millis() - lastHelmetTime) < OFFLINE_TIMEOUT;
    
    String riskIndex = (n2Hazard == 2 || n3Hazard == 2 || dStatus != "SAFE" || !helmetOnline) ? "🔴 HIGH" : (n2Hazard == 1 || n3Hazard == 1 ? "🟠 ELEVATED" : "🟢 LOW");

    Serial.println("\n\n======================================================================");
    Serial.println("                  🏔️ KAVACH SURFACE CONTROL CENTER");
    Serial.println("======================================================================");
    Serial.printf("> OVERALL RISK INDEX : %s\n", riskIndex.c_str());
    Serial.printf("> Active Data Route  : %s\n", dActiveRoute.c_str());
    Serial.println("----------------------------------------------------------------------");

    Serial.println("\n[ 📍 SPATIAL TRACKING & RESCUE LOCATOR ]");
    if (!helmetOnline && dWorker != "WAITING...") {
        Serial.println("  🚨 CASUALTY ALERT: MINER CONNECTION LOST!");
        Serial.printf("  Last Known Location: Near %s\n", lastKnownNearestNode.c_str());
    } else {
        Serial.printf("  Current Proximity: Near %s\n", lastKnownNearestNode.c_str());
    }

    if (dStatus == "SOS EMERGENCY") {
        Serial.println("  🚨 [ MANUAL OVERRIDE ] WORKER TRIGGERED SOS BUTTON!");
    }

    if (node2ToHelmetDist >= 0 && node3ToHelmetDist >= 0) {
        Serial.println("\n" + generateSlider(node2ToHelmetDist, node3ToHelmetDist));
        Serial.printf("                (%.1fm)                  (%.1fm)\n", node2ToHelmetDist, node3ToHelmetDist);
        Serial.printf("\n  * Fixed Distance (N2 to N3): %.1f m (🔒 99%% Locked)\n", node3ToNode2Dist);
        if (!node2Online || !node3Online || !helmetOnline) {
            Serial.println("  ⚠️ USING LAST KNOWN COORDINATES (Relay/Helmet Offline)");
        }
    } else {
        Serial.println("  * Not enough relay data to calculate tunnel position slider.");
    }

    Serial.println("\n[ 🦺 MINER TELEMETRY & ENVIRONMENT ]");
    Serial.printf("  > 👤 %s is currently %s and %s.\n\n", dWorker.c_str(), helmetOnline || dStatus == "SOS EMERGENCY" ? dStatus.c_str() : "OFFLINE", dMoving ? "MOVING" : "STATIONARY");
    Serial.println("  | 🌬️ Atmosphere       | ☢️ Gas Levels       | 🧭 Navigation       |");
    Serial.println("  |--------------------|--------------------|--------------------|");
    Serial.printf("  | Temp: %4.1f °C     | LPG: %4d ppm     | Head: %5.1f°       |\n", dTemp, dMq6, dHeading);
    Serial.printf("  | Hum : %4.1f %%      | CH4: %4d ppm     | Dir : %-12s |\n", dHum, dMq4, getCardinalDirection(dHeading).c_str());
    Serial.printf("  |                    | H2 : %4d ppm     | Dist: %.1f m       |\n", dMq8, dSteps * 0.70);

    Serial.println("\n[ 📡 MESH TOPOLOGY & SIGNAL STRENGTH ]");
    Serial.println("  | Node Link          | Status  | RSSI    | SNR     | Signal Quality |");
    Serial.println("  |--------------------|---------|---------|---------|----------------|");
    
    if(node2Online) Serial.printf("  | Node 2 (Relay B)   | 🟢 ON  | %4.0fdBm | %6.2f | %s %s |\n", rssiNode2, snrNode2, getRSSIBar(rssiNode2).c_str(), getSignalQuality(rssiNode2).substring(0,4).c_str());
    else            Serial.println( "  | Node 2 (Relay B)   | 🔴 OFF | ----dBm | [ OFFLINE  ] DEAD |");

    if(node3Online) Serial.printf("  | Node 3 (Relay C)   | 🟢 ON  | %4.0fdBm | %6.2f | %s %s |\n", rssiNode3, snrNode3, getRSSIBar(rssiNode3).c_str(), getSignalQuality(rssiNode3).substring(0,4).c_str());
    else            Serial.println( "  | Node 3 (Relay C)   | 🔴 OFF | ----dBm | [ OFFLINE  ] DEAD |");

    if(helmetOnline || dStatus == "SOS EMERGENCY") Serial.printf("  | Helmet (Direct)    | 🟢 ON  | %4.0fdBm | %6.2f | %s %s |\n", rssiHelmet, snrHelmet, getRSSIBar(rssiHelmet).c_str(), getSignalQuality(rssiHelmet).substring(0,4).c_str());
    else             Serial.println( "  | Helmet (Direct)    | 🔴 OFF | ----dBm | [ OFFLINE  ] DEAD |");

    Serial.println("\n[ 🏗️ STRUCTURAL HEALTH MONITORING ]");
    Serial.printf("  * Node 2 Station: %s\n", node2Online ? getHazardStatusText(n2Hazard).c_str() : "OFFLINE");
    Serial.printf("  * Node 3 Station: %s\n", node3Online ? getHazardStatusText(n3Hazard).c_str() : "OFFLINE");
    Serial.println("======================================================================\n");
}

//=========================================================
// SETUP
//=========================================================
void setup() {
    Serial.begin(115200);
    while (!Serial);

    Serial.println("\n================================");
    Serial.println("NODE 1: STARTING MUKUT GATEWAY");
    Serial.println("================================");

    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(ap_ssid, ap_pass);
    Serial.print("📡 Hotspot Active: KAVACH_MASTER | URL: http://"); Serial.println(WiFi.softAPIP());

    WiFi.begin(ssid, password);
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 15) {
        delay(400); attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("✅ Connected to Jayjit! Webview URL: http://"); Serial.println(WiFi.localIP());
    } else {
        Serial.println("⚠️ Could not connect to Jayjit. Using Hotspot only.");
    }

    server.on("/", handleRoot);
    server.on("/api/telemetry", handleTelemetryAPI); 
    server.begin();

    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
    LoRa.setPins(LORA_NSS, LORA_RESET, LORA_DIO0);
    if (!LoRa.begin(433E6)) { while (true) delay(100); }
    LoRa.setTxPower(12);
    Serial.println("LoRa Receiver Active. Awaiting Mesh Data...");
    
    bootTime = millis();
}

//=========================================================
// MAIN LOOP
//=========================================================
void loop() {
    server.handleClient();

    int packetSize = LoRa.parsePacket();
    if (packetSize) {
        String incomingData = "";
        while (LoRa.available()) incomingData += (char)LoRa.read();
        
        if (incomingData.indexOf("MINER") == -1 && incomingData.indexOf("CAL") == -1 && incomingData.indexOf("STATION") == -1) return;

        String senderID = getValue(incomingData, ',', 0);
        unsigned long currentTime = millis();
        int rawRSSI = LoRa.packetRssi();
        float rawSNR = LoRa.packetSnr();

        // 🔴 Process Calibration packets to set network baseline silently
        if (senderID == "CAL") {
            String calNode = getValue(incomingData, ',', 1);
            if (calNode == "N2") {
                 float staticDist = calculateDistance(rawRSSI, false);
                 Serial.printf("🔧 [CALIBRATION] Anchor Ping from N2 | RSSI: %d dBm -> Est Dist: %.1fm\n", rawRSSI, staticDist);
            }
            return; // Skip normal telemetry processing
        }

        // v2 STATION HEARTBEATS: relays announce liveness when no helmet
        // traffic exists (station powered, helmet absent). They carry NO
        // helmet payload — handled and returned BEFORE the generic helmet
        // field parsing, otherwise their fields would corrupt dWorker/dStatus.
        //   N2,STATION,<helmetAlive>,<hazard>,<rssiHelmet>,<snrHelmet>,<distN2N3>,<snrN3>,<rssiN3>
        //   N3,STATION,<helmetAlive>,<hazard>,<rssiHelmet>,<snrHelmet>,<rssiNode2>,<snrNode2>
        if ((senderID == "N2" || senderID == "N3") && getValue(incomingData, ',', 1) == "STATION") {
            if (senderID == "N2") {
                lastNode2Time = currentTime;
                n2EverHeard = true;
                rssiNode2 = smoothRSSI(rssiNode2, rawRSSI, firstNode2);
                snrNode2 = rawSNR;
                n2HelmetLink = getValue(incomingData, ',', 2).toInt() == 1;
                n2Hazard     = getValue(incomingData, ',', 3).toInt();
                n2HelmetRssi = getValue(incomingData, ',', 4).toFloat();
                n2HelmetSnr  = getValue(incomingData, ',', 5).toFloat();
                float hbDistN3 = getValue(incomingData, ',', 6).toFloat();
                if (hbDistN3 > 0) node3ToNode2Dist = hbDistN3;
            } else {
                lastNode3Time = currentTime;
                n3EverHeard = true;
                rssiNode3 = smoothRSSI(rssiNode3, rawRSSI, firstNode3);
                snrNode3 = rawSNR;
                n3HelmetLink = getValue(incomingData, ',', 2).toInt() == 1;
                n3Hazard     = getValue(incomingData, ',', 3).toInt();
                n3HelmetRssi = getValue(incomingData, ',', 4).toFloat();
                n3HelmetSnr  = getValue(incomingData, ',', 5).toFloat();
                n3PeerRssi   = getValue(incomingData, ',', 6).toFloat();
                n3PeerSnr    = getValue(incomingData, ',', 7).toFloat();
            }
            return; // heartbeats carry no helmet payload — skip generic parsing
        }

        dWorker = getValue(incomingData, ',', 1); 
        
        String newStatus = getValue(incomingData, ',', 2);
        dStatus = newStatus;
        
        dMoving = getValue(incomingData, ',', 3).toInt() == 1; 

        // Only update physical telemetry if it's a real sensor packet (not a forced SOS packet containing zeros)
        float inTemp = getValue(incomingData, ',', 8).toFloat();
        if (inTemp > 0.0) {
            dSteps   = getValue(incomingData, ',', 4).toInt();
            dHeading = smoothValue(dHeading, getValue(incomingData, ',', 5).toFloat(), 0.85);
            dPosX    = getValue(incomingData, ',', 6).toFloat(); dPosY    = getValue(incomingData, ',', 7).toFloat();
            dTemp    = smoothValue(dTemp, inTemp, 0.85);
            dHum     = smoothValue(dHum, getValue(incomingData, ',', 9).toFloat(), 0.85);
            dMq6     = smoothValue(dMq6, getValue(incomingData, ',', 10).toFloat(), 0.85);
            dMq4     = smoothValue(dMq4, getValue(incomingData, ',', 11).toFloat(), 0.85);
            dMq8     = smoothValue(dMq8, getValue(incomingData, ',', 12).toFloat(), 0.85);
        }

        if (senderID == "H") {
            lastHelmetTime = currentTime;
            helmetEverHeard = true;
            rssiHelmet = smoothRSSI(rssiHelmet, rawRSSI, firstHelmet);
            snrHelmet = rawSNR;
            dActiveRoute = "DIRECT (Helmet -> Surface)";
            // 🔴 INDEPENDENT RANGING: Calculate independent helmet distance
            node1ToHelmetDist = calculateDistance(rssiHelmet, true);
        }
        else if (senderID == "N2") {
            lastNode2Time = currentTime;
            n2EverHeard = true;
            rssiNode2 = smoothRSSI(rssiNode2, rawRSSI, firstNode2);
            snrNode2 = rawSNR;
            node2ToHelmetDist = getValue(incomingData, ',', 13).toFloat();
            node3ToNode2Dist  = getValue(incomingData, ',', 14).toFloat();
            node3ToHelmetDist = getValue(incomingData, ',', 15).toFloat();
            n2Hazard          = getValue(incomingData, ',', 16).toInt();
            n3Hazard          = getValue(incomingData, ',', 17).toInt();
            // v2: node2's own helmet-link measurements (fields 18/19; 0.0 on
            // old node2 firmware -> dashboard falls back to trunk values).
            // A relay packet only exists because node2 just heard the helmet.
            n2HelmetSnr  = getValue(incomingData, ',', 18).toFloat();
            n2HelmetRssi = getValue(incomingData, ',', 19).toFloat();
            n2HelmetLink = true;
            dActiveRoute = "RELAY (Helmet -> Node 2 -> Surface)";
        }
        else if (senderID == "N3") {
            lastNode3Time = currentTime;
            n3EverHeard = true;
            rssiNode3 = smoothRSSI(rssiNode3, rawRSSI, firstNode3);
            snrNode3 = rawSNR;
            node3ToHelmetDist = getValue(incomingData, ',', 13).toFloat();
            n3Hazard          = getValue(incomingData, ',', 14).toInt();
            // v2: node3's own helmet-link (17) + peer node2 (18) measurements
            // and SNR values (15/16); 0.0 on old firmware -> trunk fallback.
            n3HelmetSnr  = getValue(incomingData, ',', 15).toFloat();
            n3PeerSnr    = getValue(incomingData, ',', 16).toFloat();
            n3HelmetRssi = getValue(incomingData, ',', 17).toFloat();
            n3PeerRssi   = getValue(incomingData, ',', 18).toFloat();
            n3HelmetLink = true;
            dActiveRoute = "RELAY (Helmet -> Node 3 -> Surface)";
        }
        
        bool helmetOnlineNow = (millis() - lastHelmetTime) < OFFLINE_TIMEOUT;
        bool node2OnlineNow = (millis() - lastNode2Time) < OFFLINE_TIMEOUT;
        bool node3OnlineNow = (millis() - lastNode3Time) < OFFLINE_TIMEOUT;

        if (helmetOnlineNow || dStatus == "SOS EMERGENCY") {
            // 🔴 TRI-NODE FUSION LOGIC: Compare all 3 independent vectors to find the true nearest node
            float d1 = (helmetOnlineNow && node1ToHelmetDist >= 0) ? node1ToHelmetDist : 999.0;
            float d2 = (node2OnlineNow && node2ToHelmetDist >= 0) ? node2ToHelmetDist : 999.0;
            float d3 = (node3OnlineNow && node3ToHelmetDist >= 0) ? node3ToHelmetDist : 999.0;
            
            if (d1 == 999.0 && d2 == 999.0 && d3 == 999.0) {
                 // Keep last known position if all signals drop
            } else if (d1 <= d2 && d1 <= d3) {
                lastKnownNearestNode = "SURFACE";
            } else if (d2 <= d1 && d2 <= d3) {
                lastKnownNearestNode = "NODE02";
            } else {
                lastKnownNearestNode = "NODE03";
            }
        }
    }

    if (millis() - lastSerialPrint >= 1500) {
        lastSerialPrint = millis();
        printSerialDashboard();
    }
}