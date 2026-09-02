#include <SPI.h>
#include <LoRa.h>

// RA-02 / SX1278 Pins (per Phase 4 configuration)
#define ss 16
#define rst 17
#define dio0 26
#define SCK_PIN 18
#define MISO_PIN 19
#define MOSI_PIN 23

// LoRa Frequency
#define FREQUENCY 433E6

// Hardware Identifier
const String HELMET_ID = "HELMET01";
const String NODE_ID = "NODE03"; // This helmet acts as NODE03 conceptually, or connects via NODE03

// Packet Sequence
unsigned long sequence = 0;

// Sensor pins (if physical sensors are added later)
// #define TEMP_PIN 32
// #define MQ2_PIN 33
// #define SOS_BTN 34

void setup() {
  Serial.begin(115200);
  while (!Serial);

  Serial.println("MUKUT HELMET NODE INITIALIZING...");

  // Setup SPI for LoRa
  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, ss);
  LoRa.setPins(ss, rst, dio0);

  if (!LoRa.begin(FREQUENCY)) {
    Serial.println("Starting LoRa failed! Check wiring.");
    while (1);
  }
  
  // Optional: Set Sync Word (must match Gateway)
  LoRa.setSyncWord(0xF3);
  Serial.println("LoRa Initialized Successfully.");
}

void loop() {
  sequence++;
  
  // 1. Read Sensors
  // Since physical sensors are not verified yet, we send dummy values marked conceptually.
  // When real sensors are connected, replace these with analogRead() / library calls.
  float temp = 30.5 + (random(0, 10) / 10.0);
  float humidity = 65.0 + (random(0, 5));
  float methane = 0.20; // Fake / Simulated
  float co = 15.0;      // Fake / Simulated
  float smoke = 50.0;   // Fake / Simulated
  bool sos = false;     // Fake / Simulated

  // 2. Construct JSON Payload (MUKUT v1.0 Contract)
  // We use string building to avoid heavy JSON libraries on basic ESP32 if not needed.
  // Note: we don't send `network` link state from the helmet. Gateway injects RSSI.
  String payload = "{";
  payload += "\"version\":\"1.0\",";
  payload += "\"helmet_id\":\"" + HELMET_ID + "\",";
  payload += "\"sequence\":" + String(sequence) + ",";
  payload += "\"timestamp\":0,"; // Real timestamp set by backend
  
  // Environment
  payload += "\"environment\":{";
  payload += "\"temperature\":" + String(temp, 1) + ",";
  payload += "\"humidity\":" + String(humidity, 1) + ",";
  payload += "\"methane\":" + String(methane, 2) + ",";
  payload += "\"carbon_monoxide\":" + String(co, 1) + ",";
  payload += "\"smoke\":" + String(smoke, 1);
  payload += "},";

  // Safety
  payload += "\"safety\":{";
  payload += "\"sos\":" + String(sos ? "true" : "false");
  payload += "}";

  payload += "}"; // End JSON

  // 3. Transmit Packet
  Serial.print("Transmitting packet ");
  Serial.print(sequence);
  Serial.print(": ");
  Serial.println(payload);

  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();

  // Wait 2 seconds before next transmission
  delay(2000);
}
