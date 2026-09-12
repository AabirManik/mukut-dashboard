/*
=========================================================
               NODE 2 - RELAY STATION B
 (AUTO-CALIBRATION, AVERAGE MPU & INSTANT TOUCH SOS)
                 + REAL LoRa SNR CAPTURE
=========================================================
*/

#include <Wire.h>
#include <SPI.h>
#include <LoRa.h>
#include <math.h>

#define LORA_SCK   18
#define LORA_MISO  19
#define LORA_MOSI  23
#define LORA_NSS   16
#define LORA_RESET 17
#define LORA_DIO0  26

#define I2C_SDA 21
#define I2C_SCL 22
#define MPU_ADDR 0x68

#define RED_LED    25
#define YELLOW_LED 32 
#define GREEN_LED  27

// 🔴 Touch Sensor Pin
#define TOUCH_PIN  13
unsigned long lastTouchTime = 0;

// ========================================================
// RSSI + SNR VARIABLES
// ========================================================

float rssiHelmet = 0;
float rssiNode3 = 0;

float snrHelmet = 0;
float snrNode3 = 0;

bool firstHelmet = true;
bool firstNode3 = true;

bool firstHelmetSNR = true;
bool firstNode3SNR = true;

unsigned long lastHelmetTime = 0;
unsigned long lastNode3Time = 0;

const unsigned long OFFLINE_TIMEOUT = 5000; 

bool pendingRelay = false;
unsigned long relayTime = 0;
String pendingPacket = "";

String dWorker = "MINER 01";
String dStatus = "SAFE";

float dHelmetDist = 0.0;
float lastDist_H_N3 = -1.0; 
int lastN3Hazard = 0;

// ========================================================
// 🔴 BOOT-TIME CALIBRATION VARIABLES
// ========================================================

unsigned long bootTime = 0;
const unsigned long ANCHOR_CAL_SILENCE_MS = 8000;

unsigned long lastCalTx = 0;

// ========================================================
// 🔴 v2 STATION HEARTBEAT
// Keeps Node 2 visible to the gateway even when no helmet
// traffic exists (station powered, helmet absent).
// ========================================================

unsigned long lastStationTx = 0;
const unsigned long STATION_HB_INTERVAL = 3000;
const unsigned long HELMET_QUIET_FOR_HB = 4000;

long calRssiSumNode3 = 0;
int calCountNode3 = 0;

bool calibrationDone = false;

// ========================================================
// DYNAMIC RF DISTANCE PROFILES
// ========================================================

const float RSSI_1M_HELMET = -42.0;  
const float PLE_HELMET = 2.8;        

float dynamic_RSSI_STATIC = -45.0;
const float PLE_STATIC = 2.2;

// ========================================================
// SMOOTH VALUE
// ========================================================

float smoothValue(float current, float target, float lockFactor) {
    if (current <= 0.0) return target; 
    return (current * lockFactor) + (target * (1.0 - lockFactor));
}

// ========================================================
// DISTANCE CALCULATION
// ========================================================

float calculateDistance(float rssi, bool isHelmet) {
    if (rssi == 0 || rssi < -120) return -1.0; 
    
    float refRSSI = isHelmet ? RSSI_1M_HELMET : dynamic_RSSI_STATIC;
    float ple = isHelmet ? PLE_HELMET : PLE_STATIC;

    if (rssi > refRSSI) {
        float subMeter = 1.0 - ((rssi - refRSSI) * 0.05);
        return (subMeter < 0.1) ? 0.1 : subMeter; 
    }
    
    float distance = pow(10.0, (refRSSI - rssi) / (10.0 * ple));
    
    if (distance > 30.0) return 30.0; 
    
    return distance;
}

// ========================================================
// RSSI BAR
// ========================================================

String getRSSIBar(float rssi) {
    if (rssi == 0) return "[          ] N/A";
    if (rssi >= -50) return "[||||||||||] EXCELLENT";
    if (rssi >= -65) return "[||||||||  ] GOOD";
    if (rssi >= -80) return "[||||||    ] FAIR";
    if (rssi >= -100) return "[||||      ] WEAK";
    return "[||        ] POOR";
}

// ========================================================
// AVERAGE/MEDIUM 3-TIER MPU6050 HAZARD DETECTION
// ========================================================

float baseAx = 0;
float baseAy = 0;
float baseAz = 0;
float baseTilt = 0; 

float filteredTilt = 0.0;
float dynamicVibration = 0.0;

int n2HazardLevel = 0; 

unsigned long lastMPURead = 0;
int hazardDebounceCount = 0;

const float TILT_WARNING = 8.0;      
const float VIB_WARNING  = 0.25;     
const float TILT_HAZARD  = 20.0;     
const float VIB_HAZARD   = 0.55;     

// ========================================================
// MPU INITIALIZATION
// ========================================================

void initMPU6050() { 
    Wire.beginTransmission(MPU_ADDR); 
    Wire.write(0x6B); 
    Wire.write(0x00); 
    Wire.endTransmission(); 
    
    delay(50); 
}

// ========================================================
// MPU CALIBRATION
// ========================================================

void calibrateMPU6050() {
    Serial.println("Calibrating MPU6050 Resting Position (Do not touch)...");

    float sumX = 0;
    float sumY = 0;
    float sumZ = 0;

    for (int i = 0; i < 200; i++) {

        Wire.beginTransmission(MPU_ADDR); 
        Wire.write(0x3B); 
        Wire.endTransmission(false); 

        Wire.requestFrom(MPU_ADDR, 6);

        if (Wire.available() >= 6) {

            int16_t rx = (Wire.read() << 8) | Wire.read();
            int16_t ry = (Wire.read() << 8) | Wire.read();
            int16_t rz = (Wire.read() << 8) | Wire.read();

            sumX += (float)rx / 16384.0;
            sumY += (float)ry / 16384.0;
            sumZ += (float)rz / 16384.0;
        }

        delay(5);
    }

    baseAx = sumX / 200.0;
    baseAy = sumY / 200.0;
    baseAz = sumZ / 200.0;

    baseTilt = atan2(
        sqrt(baseAx * baseAx + baseAy * baseAy),
        fabs(baseAz)
    ) * 180.0 / PI;

    Serial.println("MPU Calibration Complete. Average Baseline Locked.");
}

// ========================================================
// MPU HAZARD READING
// ========================================================

void readMPU6050Hazard() {

    Wire.beginTransmission(MPU_ADDR); 
    Wire.write(0x3B); 
    Wire.endTransmission(false); 

    Wire.requestFrom(MPU_ADDR, 6);

    if (Wire.available() >= 6) {

        int16_t rx = (Wire.read() << 8) | Wire.read();
        int16_t ry = (Wire.read() << 8) | Wire.read();
        int16_t rz = (Wire.read() << 8) | Wire.read();
        
        float ax = (float)rx / 16384.0;
        float ay = (float)ry / 16384.0;
        float az = (float)rz / 16384.0;
        
        float rawVib = sqrt(
            pow(ax - baseAx, 2) +
            pow(ay - baseAy, 2) +
            pow(az - baseAz, 2)
        );
        
        dynamicVibration =
            (0.85 * dynamicVibration) +
            (0.15 * rawVib); 

        float currentTiltRaw =
            atan2(
                sqrt(ax * ax + ay * ay),
                fabs(az)
            ) * 180.0 / PI;

        filteredTilt =
            (0.85 * filteredTilt) +
            (0.15 * fabs(currentTiltRaw - baseTilt)); 

        int targetHazard = 0;

        if (
            filteredTilt > TILT_HAZARD ||
            dynamicVibration > VIB_HAZARD
        ) {
            targetHazard = 2;
        }
        else if (
            filteredTilt > TILT_WARNING ||
            dynamicVibration > VIB_WARNING
        ) {
            targetHazard = 1;
        }
        else {
            targetHazard = 0;
        }

        if (targetHazard > n2HazardLevel) {

            hazardDebounceCount++;

            if (hazardDebounceCount >= 3) { 
                n2HazardLevel = targetHazard;
                hazardDebounceCount = 0;
            }
        }
        else {

            n2HazardLevel = targetHazard;
            hazardDebounceCount = 0;
        }

        if (n2HazardLevel == 2) {

            digitalWrite(RED_LED, HIGH); 
            digitalWrite(YELLOW_LED, LOW); 
            digitalWrite(GREEN_LED, LOW);

        }
        else if (n2HazardLevel == 1) {

            digitalWrite(RED_LED, LOW); 
            digitalWrite(YELLOW_LED, HIGH); 
            digitalWrite(GREEN_LED, LOW);

        }
        else {

            digitalWrite(RED_LED, LOW); 
            digitalWrite(YELLOW_LED, LOW); 
            digitalWrite(GREEN_LED, HIGH);
        }
    }
}

// ========================================================
// CSV VALUE EXTRACTION
// ========================================================

String getValue(String data, char sep, int index) {

    int found = 0; 
    int strIndex[] = {0, -1}; 
    int maxIndex = data.length() - 1;

    for (
        int i = 0;
        i <= maxIndex && found <= index;
        i++
    ) {

        if (
            data.charAt(i) == sep ||
            i == maxIndex
        ) {

            found++;

            strIndex[0] = strIndex[1] + 1;

            strIndex[1] =
                (i == maxIndex) ? i + 1 : i;
        }
    }

    return found > index
        ? data.substring(strIndex[0], strIndex[1])
        : "";
}

// ========================================================
// DASHBOARD
// ========================================================

void printDashboard(
    String worker,
    String status,
    float helmetDist
) {

    bool helmetOnline =
        (millis() - lastHelmetTime) < OFFLINE_TIMEOUT;

    bool node3Online =
        (millis() - lastNode3Time) < OFFLINE_TIMEOUT;

    String nearestNode = "UNKNOWN";

    if (
        node3Online &&
        lastDist_H_N3 >= 0 &&
        helmetDist >= 0
    ) {

        nearestNode =
            (helmetDist <= lastDist_H_N3)
            ? "NODE 2"
            : "NODE 3";
    }
    else if (helmetDist >= 0) {

        nearestNode = "NODE 2";
    }

    Serial.println("\n==================================================");
    Serial.println("               NODE 2 - RELAY STATION             ");
    Serial.println("==================================================");

    if (
        !helmetOnline &&
        worker != "" &&
        worker != "WAITING..."
    ) {

        Serial.println("🚨 CASUALTY ALERT: Miner Connection Lost!");
        Serial.printf(
            "📍 Last Known Location: Near %s\n\n",
            nearestNode.c_str()
        );
    }
    else if (helmetOnline) {

        Serial.printf(
            "📍 Current Proximity  : Near %s\n\n",
            nearestNode.c_str()
        );
    }
    
    if (status == "SOS EMERGENCY") {

        Serial.println(
            "🚨 [ MANUAL OVERRIDE ] WORKER TRIGGERED SOS BUTTON!"
        );
    }

    String structStatus =
        n2HazardLevel == 2
        ? "🚨 CRITICAL HAZARD!"
        : (
            n2HazardLevel == 1
            ? "⚠️ WARNING (Minor Shift)"
            : "✅ STABLE"
        );

    Serial.printf(
        "Tunnel Structure : %s (Tilt: %.1f°, Vib: %.2fg)\n",
        structStatus.c_str(),
        filteredTilt,
        dynamicVibration
    );

    Serial.println("--- PEER-TO-PEER DISTANCES & SIGNAL ---");

    Serial.print("Helmet Direct Link   : ");

    if (
        helmetOnline ||
        status == "SOS EMERGENCY"
    ) {

        Serial.printf(
            "ONLINE  (%.1f m) | RSSI: %4.0f dBm | SNR: %.2f dB %s\n",
            helmetDist,
            rssiHelmet,
            snrHelmet,
            getRSSIBar(rssiHelmet).c_str()
        );

    }
    else {

        Serial.println("OFFLINE (Out of Range)");
    }

    Serial.print("Node 3 Peer Link     : ");

    if (node3Online) {

        Serial.printf(
            "ONLINE  (%.1f m) | RSSI: %4.0f dBm | SNR: %.2f dB %s\n",
            calculateDistance(rssiNode3, false),
            rssiNode3,
            snrNode3,
            getRSSIBar(rssiNode3).c_str()
        );

    }
    else {

        Serial.println("OFFLINE (Node 3 Down)");
    }

    Serial.println("==================================================");
}

// ========================================================
// SETUP
// ========================================================

void setup() {

    Serial.begin(115200); 

    while (!Serial);

    pinMode(RED_LED, OUTPUT); 
    pinMode(YELLOW_LED, OUTPUT); 
    pinMode(GREEN_LED, OUTPUT);

    digitalWrite(GREEN_LED, HIGH); 
    digitalWrite(YELLOW_LED, LOW); 
    digitalWrite(RED_LED, LOW);

    pinMode(TOUCH_PIN, INPUT);

    // ----------------------------------------------------
    // MPU
    // ----------------------------------------------------

    Wire.begin(I2C_SDA, I2C_SCL);

    initMPU6050();
    calibrateMPU6050();

    // ----------------------------------------------------
    // LoRa
    // ----------------------------------------------------

    SPI.begin(
        LORA_SCK,
        LORA_MISO,
        LORA_MOSI,
        LORA_NSS
    ); 

    LoRa.setPins(
        LORA_NSS,
        LORA_RESET,
        LORA_DIO0
    );

    if (!LoRa.begin(433E6)) {

        Serial.println("LORA FAILED");

        while (true) {
            delay(100);
        }
    }

    LoRa.setTxPower(12);
    
    LoRa.receive();

    bootTime = millis();

    Serial.println(
        "\n[MESH INITIALIZING] Entering 8-Second Anchor Auto-Calibration..."
    );
}

// ========================================================
// MAIN LOOP
// ========================================================

void loop() {

    // ====================================================
    // BOOT-TIME ANCHOR CALIBRATION PHASE
    // ====================================================

    if (
        millis() - bootTime <
        ANCHOR_CAL_SILENCE_MS
    ) {

        // ------------------------------------------------
        // Broadcast Calibration Ping every 1000ms
        // ------------------------------------------------

        if (millis() - lastCalTx > 1000) {

            lastCalTx = millis();

            LoRa.beginPacket();
            LoRa.print("CAL,N2");
            LoRa.endPacket();

            LoRa.receive();
        }

        // ------------------------------------------------
        // Listen for Node 3 Calibration Pings
        // ------------------------------------------------

        int packetSize = LoRa.parsePacket();

        if (packetSize) {

            String incoming = "";

            while (LoRa.available()) {
                incoming += (char)LoRa.read();
            }

            int rawRssi = LoRa.packetRssi();

            if (incoming.indexOf("CAL,N3") != -1) {

                calRssiSumNode3 += rawRssi;
                calCountNode3++;
            }
        }

        return;
    }

    // ====================================================
    // FINALIZE CALIBRATION
    // ====================================================

    else if (!calibrationDone) {

        calibrationDone = true;

        if (calCountNode3 > 0) {

            dynamic_RSSI_STATIC =
                (float)calRssiSumNode3 /
                calCountNode3;

            Serial.printf(
                "\n✅ CALIBRATION COMPLETE! Locked Node 3 Baseline RSSI: %.1f dBm\n\n",
                dynamic_RSSI_STATIC
            );

        }
        else {

            Serial.println(
                "\n⚠️ CALIBRATION TIMEOUT: No Node 3 pings heard. Using fallback baseline (-45.0 dBm)\n"
            );
        }
    }

    // ====================================================
    // 🔴 INSTANT TOUCH BUTTON SOS LOGIC
    // ====================================================

    if (digitalRead(TOUCH_PIN) == HIGH) {

        if (millis() - lastTouchTime > 500) {

            lastTouchTime = millis();

            dWorker = "MINER 01";
            dStatus = "SOS EMERGENCY";
            n2HazardLevel = 2;
            
            Serial.println(
                "\n🚨 [ INSTANT ALERT ] TOUCH SENSOR ACTIVATED! BROADCASTING MANUAL SOS..."
            );
            
            digitalWrite(RED_LED, HIGH); 
            digitalWrite(YELLOW_LED, LOW); 
            digitalWrite(GREEN_LED, LOW);

            // ------------------------------------------------
            // Existing N2 SOS packet
            // ------------------------------------------------

            String sosPacket =
                "N2," +
                dWorker + "," +
                dStatus +
                ",0,0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,";

            sosPacket += String(dHelmetDist, 1) + ",";
            sosPacket += String(
                calculateDistance(rssiNode3, false),
                1
            ) + ",";
            sosPacket += String(
                lastDist_H_N3,
                1
            ) + ",";
            sosPacket += String(
                n2HazardLevel
            ) + ",";
            sosPacket += String(
                lastN3Hazard
            );

            // ------------------------------------------------
            // v2: append Node 2's true helmet-link measurements
            // (field 18 = helmet SNR, field 19 = helmet RSSI —
            // the true Helmet->N2 radio values for the gateway)
            // ------------------------------------------------

            sosPacket += ",";
            sosPacket += String(snrHelmet, 2);

            sosPacket += ",";
            sosPacket += String(rssiHelmet, 1);

            Serial.println("📡 SOS Relay Packet:");
            Serial.println(sosPacket);

            LoRa.beginPacket();
            LoRa.print(sosPacket);
            LoRa.endPacket();

            LoRa.receive();

            printDashboard(
                dWorker,
                dStatus,
                dHelmetDist
            );
        }
    }

    // ====================================================
    // MPU HAZARD UPDATE
    // ====================================================

    if (millis() - lastMPURead >= 100) {

        lastMPURead = millis();

        readMPU6050Hazard();
    }

    // ====================================================
    // RECEIVE LoRa PACKET
    // ====================================================

    int packetSize = LoRa.parsePacket();

    if (packetSize) {

        String incomingData = "";

        while (LoRa.available()) {
            incomingData += (char)LoRa.read();
        }

        // ------------------------------------------------
        // IMPORTANT:
        // Capture RSSI + SNR BEFORE returning to RX mode.
        // ------------------------------------------------

        int rawRSSI = LoRa.packetRssi();
        float rawSNR = LoRa.packetSnr();

        // Return immediately to receive mode after
        // capturing the radio measurements.
        LoRa.receive();

        // ------------------------------------------------
        // Ignore stray calibration packets after boot.
        // v2: STATION heartbeats from Node 3 ARE accepted so
        // the N2<->N3 peer link stays fresh without helmet traffic.
        // ------------------------------------------------

        if (
            incomingData.indexOf("MINER") == -1 &&
            incomingData.indexOf("STATION") == -1
        ) {
            return;
        }

        String senderID =
            getValue(
                incomingData,
                ',',
                0
            );

        // ==================================================
        // HELMET PACKET
        // ==================================================

        if (senderID == "H") {

            lastHelmetTime = millis();

            // ------------------------------------------------
            // RSSI smoothing
            // ------------------------------------------------

            if (firstHelmet) {

                rssiHelmet = rawRSSI;
                firstHelmet = false;
            }
            else {

                if (rawRSSI > rssiHelmet) {

                    rssiHelmet =
                        (0.50 * rawRSSI) +
                        (0.50 * rssiHelmet);
                }
                else {

                    // 0.10 recede weight made the distance appear static while
                    // the helmet moved AWAY from Node 2. Match the gateway's
                    // smoothRSSI recede weight (0.30) for responsiveness.
                    rssiHelmet =
                        (0.30 * rawRSSI) +
                        (0.70 * rssiHelmet);
                }
            }

            // ------------------------------------------------
            // NEW: SNR smoothing
            // ------------------------------------------------

            if (firstHelmetSNR) {

                snrHelmet = rawSNR;
                firstHelmetSNR = false;
            }
            else {

                // Moderate smoothing.
                // SNR can fluctuate significantly underground.
                snrHelmet =
                    (0.20 * rawSNR) +
                    (0.80 * snrHelmet);
            }

            // ------------------------------------------------
            // Reset stale Node 3 data
            // ------------------------------------------------

            if (
                millis() - lastNode3Time >
                OFFLINE_TIMEOUT
            ) {

                rssiNode3 = 0;
                snrNode3 = 0;

                lastDist_H_N3 = -1.0;
                lastN3Hazard = 0;

                firstNode3 = true;
                firstNode3SNR = true;
            }

            // ------------------------------------------------
            // Existing distance calculation
            // ------------------------------------------------

            float estDist =
                calculateDistance(
                    rssiHelmet,
                    true
                ); 

            dHelmetDist =
                smoothValue(
                    dHelmetDist,
                    estDist,
                    0.75
                );

            // ------------------------------------------------
            // Schedule relay
            // ------------------------------------------------

            pendingRelay = true;

            relayTime = millis() + 150; 

            // ------------------------------------------------
            // IMPORTANT:
            // Existing N2 packet fields remain unchanged.
            // SNR values are appended at the END.
            // ------------------------------------------------

            pendingPacket =
                "N2," +
                incomingData.substring(2) +
                "," +
                String(dHelmetDist, 1) +
                "," +
                String(
                    calculateDistance(
                        rssiNode3,
                        false
                    ),
                    1
                ) +
                "," +
                String(
                    lastDist_H_N3,
                    1
                ) +
                "," +
                String(n2HazardLevel) +
                "," +
                String(lastN3Hazard);

            // ------------------------------------------------
            // v2: append Node 2's true helmet-link measurements
            // (field 18 = helmet SNR, field 19 = helmet RSSI —
            // the true Helmet->N2 radio values for the gateway)
            // ------------------------------------------------

            pendingPacket += ",";
            pendingPacket += String(
                snrHelmet,
                2
            );

            pendingPacket += ",";
            pendingPacket += String(
                rssiHelmet,
                1
            );

            dWorker =
                getValue(
                    incomingData,
                    ',',
                    1
                );

            dStatus =
                getValue(
                    incomingData,
                    ',',
                    2
                );

            // ------------------------------------------------
            // Debug output
            // ------------------------------------------------

            Serial.println("\n📡 HELMET PACKET RECEIVED");
            Serial.printf(
                "RSSI : %d dBm\n",
                rawRSSI
            );
            Serial.printf(
                "SNR  : %.2f dB\n",
                rawSNR
            );

            Serial.printf(
                "Filtered RSSI : %.1f dBm\n",
                rssiHelmet
            );

            Serial.printf(
                "Filtered SNR  : %.2f dB\n",
                snrHelmet
            );
        }

        // ==================================================
        // NODE 3 PACKET
        // ==================================================

        else if (senderID == "N3") {

            lastNode3Time = millis();

            // ------------------------------------------------
            // RSSI smoothing
            // v2: 0.85 lock (was 0.99) — the near-total lock froze
            // the N2<->N3 distance at its first value, which looked
            // like a hardcoded distance on the dashboard.
            // ------------------------------------------------

            if (firstNode3) {

                rssiNode3 = rawRSSI;
                firstNode3 = false;
            }
            else {

                rssiNode3 =
                    smoothValue(
                        rssiNode3,
                        rawRSSI,
                        0.85
                    ); 
            }

            // ------------------------------------------------
            // NEW: SNR smoothing
            // ------------------------------------------------

            if (firstNode3SNR) {

                snrNode3 = rawSNR;
                firstNode3SNR = false;
            }
            else {

                snrNode3 =
                    (0.20 * rawSNR) +
                    (0.80 * snrNode3);
            }

            // ------------------------------------------------
            // v2: STATION heartbeats carry no relay payload —
            // only the peer-link radio measurements are used.
            // ------------------------------------------------

            bool isN3Heartbeat =
                getValue(incomingData, ',', 1) == "STATION";

            if (!isN3Heartbeat) {

                lastDist_H_N3 =
                    getValue(
                        incomingData,
                        ',',
                        13
                    ).toFloat();

                lastN3Hazard =
                    getValue(
                        incomingData,
                        ',',
                        14
                    ).toInt();
            }

            // ------------------------------------------------
            // Debug output
            // ------------------------------------------------

            Serial.println(
                isN3Heartbeat
                ? "\n📡 NODE 3 STATION HEARTBEAT RECEIVED"
                : "\n📡 NODE 3 PACKET RECEIVED"
            );

            Serial.printf(
                "RSSI : %d dBm\n",
                rawRSSI
            );

            Serial.printf(
                "SNR  : %.2f dB\n",
                rawSNR
            );

            Serial.printf(
                "Filtered RSSI : %.1f dBm\n",
                rssiNode3
            );

            Serial.printf(
                "Filtered SNR  : %.2f dB\n",
                snrNode3
            );
        }
    }

    // ====================================================
    // RELAY PENDING PACKET
    // ====================================================

    if (
        pendingRelay &&
        millis() >= relayTime
    ) {

        pendingRelay = false;

        Serial.println("\n📡 RELAYING N2 PACKET:");
        Serial.println(pendingPacket);

        LoRa.beginPacket();

        LoRa.print(pendingPacket);

        LoRa.endPacket();

        LoRa.receive();

        printDashboard(
            dWorker,
            dStatus,
            dHelmetDist
        );
    }

    // ====================================================
    // 🔴 v2 STATION HEARTBEAT (no helmet traffic)
    // Keeps Node 2 visible to the gateway while the helmet
    // is absent, and carries the true helmet-link + peer
    // measurements so the dashboard shows real state.
    // Format:
    // N2,STATION,<helmetAlive>,<hazard>,<rssiHelmet>,<snrHelmet>,<distN2N3>,<snrN3>,<rssiN3>
    // ====================================================

    if (
        millis() - lastHelmetTime > HELMET_QUIET_FOR_HB &&
        millis() - lastStationTx >= STATION_HB_INTERVAL
    ) {

        lastStationTx = millis();

        bool helmetAlive =
            (millis() - lastHelmetTime) < OFFLINE_TIMEOUT;

        String hb =
            "N2,STATION," +
            String(helmetAlive ? 1 : 0) + "," +
            String(n2HazardLevel) + "," +
            String(rssiHelmet, 1) + "," +
            String(snrHelmet, 2) + "," +
            String(
                calculateDistance(
                    rssiNode3,
                    false
                ),
                1
            ) + "," +
            String(snrNode3, 2) + "," +
            String(rssiNode3, 1);

        Serial.println(
            "\n📡 STATION HEARTBEAT (no helmet traffic):"
        );

        Serial.println(hb);

        LoRa.beginPacket();

        LoRa.print(hb);

        LoRa.endPacket();

        LoRa.receive();
    }
}