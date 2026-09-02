import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import fs from 'fs';

/**
 * MUKUT Hardware Serial Bridge
 * Reads telemetry packets from the Gateway ESP32 via USB Serial.
 * Parses, validates, and forwards JSON packets to the StateManager.
 */
export class SerialBridge {
  constructor(stateManager, portPath = 'COM3', baudRate = 115200) {
    this.stateManager = stateManager;
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.port = null;
    this.parser = null;
    this.reconnectTimer = null;
    this.isRunning = false;
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
      }, 5000); // Retry every 5 seconds
    }
  }

  handleData(data) {
    const rawString = data.toString().trim();
    if (!rawString) return;

    try {
      const packet = JSON.parse(rawString);
      
      // Basic validation based on MUKUT v1.0 telemetry contract
      if (!packet.version || !packet.helmet_id || !packet.timestamp) {
        throw new Error('Missing required root fields (version, helmet_id, timestamp)');
      }

      if (!packet.environment || !packet.safety || !packet.network) {
         throw new Error('Missing required object structures (environment, safety, network)');
      }

      // If valid, pass to StateManager
      this.stateManager.processTelemetry(packet);

    } catch (err) {
      // Don't flood logs for every bad parse, but it's useful to log it to StateManager if it happens rarely
      // console.error(`[SerialBridge] Malformed packet received: ${err.message}`);
    }
  }
}
