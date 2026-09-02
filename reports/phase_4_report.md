# MUKUT — PHASE 4 IMPLEMENTATION REPORT

## 1. Status
**COMPLETE** (Software Implementation Phase)

## 2. What Was Implemented
The Phase 4 objective was to establish a hardware data path to integrate physical ESP32 and RA-02 LoRa devices with the existing MUKUT dashboard and backend. 

Key implementations:
- Installed `serialport` module.
- Added `hardware` block to `config/default.json` with a `data_source` toggle (`simulator` or `hardware`).
- Developed `src/server/serialBridge.js` to ingest newline-delimited JSON payload via USB serial.
- Updated `src/server/server.js` to initialize the SerialBridge and suspend the simulator loop when `data_source = 'hardware'`.
- Created ESP32 transmitter code `hardware/helmet_node/helmet_node.ino` for the Helmet node.
- Created ESP32 receiver/gateway code `hardware/gateway_node/gateway_node.ino` for the Surface Relay Node.
- Updated the Dashboards (`index.html`, `network.html`, `routing.html`) to clearly visually distinguish whether data is coming from the simulator or live hardware based on the backend configuration.

## 3. Hardware Used
*Target for physical testing:*
- 2x ESP32 microcontrollers
- 2x RA-02 (SX1278) LoRa modules (433 MHz)

## 4. ESP32 Configuration
- Helmet ID: `HELMET01` (Connects to `NODE03` logically in the network)
- Gateway Role: `NODE01` Root Relay
- SPI Wiring:
  - SCK: 18
  - MISO: 19
  - MOSI: 23
  - NSS: 16
  - RESET: 17
  - DIO0: 26

## 5. RA-02 Configuration
- Frequency: 433 MHz
- Logic Level: 3.3V (VCC wired to 3.3V, not 5V)
- Sync Word: 0xF3

## 6. Sensor Integration
- **Physically Verified**: None currently connected.
- **Software Implemented (Dummy/Simulated via ESP32)**: Temperature (randomized ~30.5C), Humidity (randomized ~65%), Methane (0.20), Carbon Monoxide (15.0), Smoke (50.0), SOS (false).
- **Unavailable**: Physical gas sensors and SOS buttons are clearly marked as faked/simulated in the `helmet_node.ino` file to prevent claiming false hardware integration.

## 7. LoRa Communication
**NOT VERIFIED PHYSICALLY YET.**
The C++ codebase (`helmet_node.ino` and `gateway_node.ino`) has been written to establish `ESP32 -> RA-02 -> Gateway` communication, but requires physical flash and verification.

## 8. Serial Bridge
- **Serial Package**: `serialport` (^13.0.0)
- **Port Configuration**: `COM3` (configurable in `config/default.json`)
- **Baud Rate**: `115200`
- **Packet Format**: Newline-delimited JSON strings matching the MUKUT v1.0 telemetry contract.

## 9. Backend Integration
The `SerialBridge` reads strings from the USB Serial port, parses them as JSON, validates the presence of required fields (`version`, `helmet_id`, `environment`, `safety`, `network`), and passes valid packets directly into the exact same `stateManager.processTelemetry(packet)` method used by the REST API and the Simulator.

## 10. Dashboard Integration
All three dashboards (Safety Overview, Underground Network, Routing & Failover) display the real hardware data when configured. A new UI indicator `DATA SOURCE: LIVE HARDWARE` (Green) or `DATA SOURCE: SIMULATOR` (Orange) was added to the header so the viewer instantly knows the origin of the telemetry.

## 11. Tests Executed
```bash
node test/phase1_test.js
node test/phase2_test.js
node test/phase2_e2e_test.js
node test_phase3b.js
```

## 12. Automated Test Results
- Phase 1 (Schema & Safety): 100% PASS
- Phase 2 (Network Graph & Status): 100% PASS
- Phase 2 E2E (WebSocket & REST API): 100% PASS
- Phase 3B (Routing Engine & UI Integration): 100% PASS

## 13. Physical Hardware Test Results
To be conducted by the user using the provided `.ino` sketches.

## 14. Simulator Regression
**PASS**. The simulator works perfectly. When `data_source` is set back to `simulator`, the backend boots the `TelemetrySimulator` loop automatically.

## 15. Phase 1 / Phase 2 / Phase 3 Regression
**PASS**. The introduction of the `SerialBridge` did not alter the existing routing algorithms, safety state engines, or failover calculations.

## 16. Known Limitations
- If physical serial drops, the serial bridge will attempt to reconnect every 5 seconds.
- JSON string construction on the ESP32 transmitter is hardcoded for simplicity. If a robust C++ JSON schema is preferred (e.g. `ArduinoJson`), it can be swapped in without breaking the Node.js backend.

## 17. Physically Verified vs Simulated

- **SOFTWARE VERIFIED**: SerialBridge JSON parsing, routing ingestion, failover ingestion, WebSocket propagation, Dashboard Data Source UI rendering.
- **NOT VERIFIED**: Physical ESP32 -> RA-02 -> Gateway -> USB transmission sequence.
- **SIMULATED**: Multi-node failover scenarios, Physical Methane, CO, Smoke sensor readings.
