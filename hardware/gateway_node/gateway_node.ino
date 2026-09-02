#include <SPI.h>
#include <LoRa.h>

// RA-02 / SX1278 Pins
#define ss 16
#define rst 17
#define dio0 26
#define SCK_PIN 18
#define MISO_PIN 19
#define MOSI_PIN 23

// LoRa Frequency
#define FREQUENCY 433E6

// We parse simple string json on the Gateway to inject network link data.
// For robust JSON parsing on ESP32, ArduinoJson is recommended, 
// but for this prototype we will use string manipulation to keep it simple.

void setup() {
  Serial.begin(115200);
  while (!Serial);

  // Note: We don't print human-readable debug logs to Serial if possible 
  // because the Node.js backend is reading this serial port for JSON.
  // The backend serialBridge expects newline-delimited JSON.
  // We can print a startup message, but SerialBridge might log it as a malformed packet (which is handled gracefully).
  Serial.println("{\"type\":\"GATEWAY_STARTUP\",\"msg\":\"MUKUT Gateway Initialized\"}");

  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, ss);
  LoRa.setPins(ss, rst, dio0);

  if (!LoRa.begin(FREQUENCY)) {
    Serial.println("{\"type\":\"GATEWAY_ERROR\",\"msg\":\"Starting LoRa failed!\"}");
    while (1);
  }
  
  LoRa.setSyncWord(0xF3); // Must match Helmet
}

void loop() {
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    // 1. Read packet
    String incoming = "";
    while (LoRa.available()) {
      incoming += (char)LoRa.read();
    }
    
    // 2. Capture RSSI
    int rssi = LoRa.packetRssi();

    // 3. Inject Network block into JSON
    // The helmet sends: {"version":"1.0","helmet_id":"HELMET01",..."safety":{"sos":false}}
    // We want to add the `network` block before the final closing brace.
    // Hackathon simple parsing: find the last '}' and replace it with our network array, then close it.
    
    int lastBraceIndex = incoming.lastIndexOf('}');
    if (lastBraceIndex != -1) {
      String networkBlock = ",\"network\":{";
      networkBlock += "\"connected_node\":\"NODE03\",";
      networkBlock += "\"links\":[";
      
      // We physically only have HELMET01 -> GATEWAY in a 2-device setup,
      // but logically we map it to HELMET01 -> NODE03 for the backend graph to work.
      networkBlock += "{";
      networkBlock += "\"id\":\"link_helmet_node03\",";
      networkBlock += "\"source\":\"HELMET01\",";
      networkBlock += "\"destination\":\"NODE03\",";
      networkBlock += "\"rssi\":" + String(rssi) + ",";
      networkBlock += "\"distance\":18,"; // Hardcoded estimate
      networkBlock += "\"status\":\"CONNECTED\",";
      networkBlock += "\"available\":true";
      networkBlock += "}";
      
      networkBlock += "]}"; // Close network object
      
      incoming = incoming.substring(0, lastBraceIndex) + networkBlock + "}";
    }

    // 4. Output structured data over USB Serial
    // The Node.js SerialBridge will pick this up.
    Serial.println(incoming);
  }
}
