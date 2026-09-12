/*
=========================================================
               NODE 3 - RELAY STATION C
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
// RSSI VARIABLES
// ========================================================

float rssiHelmet = 0;
bool firstHelmet = true;

// 🔴 Node 2 Tracking Variables
float rssiNode2 = 0;
bool firstNode2 = true;

unsigned long lastNode2Time = 0;
unsigned long lastHelmetTime = 0;

const unsigned long OFFLINE_TIMEOUT = 5000;

// ========================================================
// SNR VARIABLES
// ========================================================

float snrHelmet = 0;
float snrNode2 = 0;

bool firstHelmetSNR = true;
bool firstNode2SNR = true;

// ========================================================
// RELAY VARIABLES
// ========================================================

bool pendingRelay = false;
unsigned long relayTime = 0;

String pendingPacket = "";

String dWorker = "MINER 01";
String dStatus = "SAFE";

float dHelmetDist = 0.0;

// ========================================================
// 🔴 BOOT-TIME CALIBRATION VARIABLES
// ========================================================

unsigned long bootTime = 0;
const unsigned long ANCHOR_CAL_SILENCE_MS = 8000;

unsigned long lastCalTx = 0;

// ========================================================
// 🔴 v2 STATION HEARTBEAT
// Keeps Node 3 visible to the gateway even when no helmet
// traffic exists (station powered, helmet absent).
// ========================================================

unsigned long lastStationTx = 0;
const unsigned long STATION_HB_INTERVAL = 3000;
const unsigned long HELMET_QUIET_FOR_HB = 4000;

long calRssiSumNode2 = 0;
int calCountNode2 = 0;

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

    return (current * lockFactor) +
           (target * (1.0 - lockFactor));
}

// ========================================================
// DISTANCE CALCULATION
// ========================================================

float calculateDistance(float rssi, bool isHelmet) {

    if (rssi == 0 || rssi < -120)
        return -1.0;

    float refRSSI =
        isHelmet ? RSSI_1M_HELMET : dynamic_RSSI_STATIC;

    float ple =
        isHelmet ? PLE_HELMET : PLE_STATIC;

    if (rssi > refRSSI) {

        float subMeter =
            1.0 - ((rssi - refRSSI) * 0.05);

        return (subMeter < 0.1)
            ? 0.1
            : subMeter;
    }

    float distance =
        pow(
            10.0,
            (refRSSI - rssi) /
            (10.0 * ple)
        );

    if (distance > 30.0)
        return 30.0;

    return distance;
}

// ========================================================
// RSSI BAR
// ========================================================

String getRSSIBar(float rssi) {

    if (rssi == 0)
        return "[          ] N/A";

    if (rssi >= -50)
        return "[||||||||||] EXCELLENT";

    if (rssi >= -65)
        return "[||||||||  ] GOOD";

    if (rssi >= -80)
        return "[||||||    ] FAIR";

    if (rssi >= -100)
        return "[||||      ] WEAK";

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

int n3HazardLevel = 0;

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

    Serial.println(
        "Calibrating MPU6050 Resting Position (Do not touch)..."
    );

    float sumX = 0;
    float sumY = 0;
    float sumZ = 0;

    for (int i = 0; i < 200; i++) {

        Wire.beginTransmission(MPU_ADDR);
        Wire.write(0x3B);
        Wire.endTransmission(false);

        Wire.requestFrom(MPU_ADDR, 6);

        if (Wire.available() >= 6) {

            int16_t rx =
                (Wire.read() << 8) | Wire.read();

            int16_t ry =
                (Wire.read() << 8) | Wire.read();

            int16_t rz =
                (Wire.read() << 8) | Wire.read();

            sumX += (float)rx / 16384.0;
            sumY += (float)ry / 16384.0;
            sumZ += (float)rz / 16384.0;
        }

        delay(5);
    }

    baseAx = sumX / 200.0;
    baseAy = sumY / 200.0;
    baseAz = sumZ / 200.0;

    baseTilt =
        atan2(
            sqrt(
                baseAx * baseAx +
                baseAy * baseAy
            ),
            fabs(baseAz)
        ) * 180.0 / PI;

    Serial.println(
        "MPU Calibration Complete. Average Baseline Locked."
    );
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

        int16_t rx =
            (Wire.read() << 8) | Wire.read();

        int16_t ry =
            (Wire.read() << 8) | Wire.read();

        int16_t rz =
            (Wire.read() << 8) | Wire.read();

        float ax =
            (float)rx / 16384.0;

        float ay =
            (float)ry / 16384.0;

        float az =
            (float)rz / 16384.0;

        float rawVib =
            sqrt(
                pow(ax - baseAx, 2) +
                pow(ay - baseAy, 2) +
                pow(az - baseAz, 2)
            );

        dynamicVibration =
            (0.85 * dynamicVibration) +
            (0.15 * rawVib);

        float currentTiltRaw =
            atan2(
                sqrt(
                    ax * ax +
                    ay * ay
                ),
                fabs(az)
            ) * 180.0 / PI;

        filteredTilt =
            (0.85 * filteredTilt) +
            (0.15 * fabs(
                currentTiltRaw - baseTilt
            ));

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

        if (targetHazard > n3HazardLevel) {

            hazardDebounceCount++;

            if (hazardDebounceCount >= 3) {

                n3HazardLevel = targetHazard;
                hazardDebounceCount = 0;
            }
        }
        else {

            n3HazardLevel = targetHazard;
            hazardDebounceCount = 0;
        }

        if (n3HazardLevel == 2) {

            digitalWrite(RED_LED, HIGH);
            digitalWrite(YELLOW_LED, LOW);
            digitalWrite(GREEN_LED, LOW);

        }
        else if (n3HazardLevel == 1) {

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

String getValue(
    String data,
    char sep,
    int index
) {

    int found = 0;

    int strIndex[] = {0, -1};

    int maxIndex =
        data.length() - 1;

    for (
        int i = 0;
        i <= maxIndex &&
        found <= index;
        i++
    ) {

        if (
            data.charAt(i) == sep ||
            i == maxIndex
        ) {

            found++;

            strIndex[0] =
                strIndex[1] + 1;

            strIndex[1] =
                (i == maxIndex)
                ? i + 1
                : i;
        }
    }

    return found > index
        ? data.substring(
            strIndex[0],
            strIndex[1]
        )
        : "";
}

// ========================================================
// DASHBOARD
// ========================================================

void printDashboard() {

    bool helmetOnline =
        (millis() - lastHelmetTime) <
        OFFLINE_TIMEOUT;

    bool node2Online =
        (millis() - lastNode2Time) <
        OFFLINE_TIMEOUT;

    Serial.println(
        "\n=================================================="
    );

    Serial.println(
        "               NODE 3 - RELAY STATION             "
    );

    Serial.println(
        "=================================================="
    );

    if (dStatus == "SOS EMERGENCY") {

        Serial.println(
            "🚨 [ MANUAL OVERRIDE ] WORKER TRIGGERED SOS BUTTON!"
        );
    }

    String structStatus =
        n3HazardLevel == 2
        ? "🚨 CRITICAL HAZARD!"
        : (
            n3HazardLevel == 1
            ? "⚠️ WARNING (Minor Shift)"
            : "✅ STABLE"
        );

    Serial.printf(
        "Tunnel Structure : %s (Tilt: %.1f°, Vib: %.2fg)\n",
        structStatus.c_str(),
        filteredTilt,
        dynamicVibration
    );

    Serial.println(
        "--- PEER-TO-PEER DISTANCES & SIGNAL ---"
    );

    // ----------------------------------------------------
    // Helmet
    // ----------------------------------------------------

    Serial.print(
        "Helmet Direct Link   : "
    );

    if (
        helmetOnline ||
        dStatus == "SOS EMERGENCY"
    ) {

        Serial.printf(
            "ONLINE  (%.1f m) | RSSI: %4.0f dBm | SNR: %.2f dB %s\n",
            dHelmetDist,
            rssiHelmet,
            snrHelmet,
            getRSSIBar(rssiHelmet).c_str()
        );

    }
    else {

        Serial.println(
            "OFFLINE (Out of Range)"
        );
    }

    // ----------------------------------------------------
    // Node 2
    // ----------------------------------------------------

    Serial.print(
        "Node 2 Peer Link     : "
    );

    if (node2Online) {

        Serial.printf(
            "ONLINE  (%.1f m) | RSSI: %4.0f dBm | SNR: %.2f dB %s\n",
            calculateDistance(
                rssiNode2,
                false
            ),
            rssiNode2,
            snrNode2,
            getRSSIBar(rssiNode2).c_str()
        );

    }
    else {

        Serial.println(
            "OFFLINE (Node 2 Down)"
        );
    }

    Serial.println(
        "=================================================="
    );
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

    Wire.begin(
        I2C_SDA,
        I2C_SCL
    );

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

        while (true)
            delay(100);
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
        // Broadcast Calibration Ping
        // ------------------------------------------------

        if (
            millis() - lastCalTx >
            1000
        ) {

            lastCalTx = millis();

            LoRa.beginPacket();
            LoRa.print("CAL,N3");
            LoRa.endPacket();

            LoRa.receive();
        }

        // ------------------------------------------------
        // Listen for Node 2 Calibration Pings
        // ------------------------------------------------

        int packetSize =
            LoRa.parsePacket();

        if (packetSize) {

            String incoming = "";

            while (LoRa.available())
                incoming += (char)LoRa.read();

            int rawRssi =
                LoRa.packetRssi();

            if (
                incoming.indexOf("CAL,N2") != -1
            ) {

                calRssiSumNode2 += rawRssi;
                calCountNode2++;
            }
        }

        return;
    }

    // ====================================================
    // FINALIZE CALIBRATION
    // ====================================================

    else if (!calibrationDone) {

        calibrationDone = true;

        if (calCountNode2 > 0) {

            dynamic_RSSI_STATIC =
                (float)calRssiSumNode2 /
                calCountNode2;

            Serial.printf(
                "\n✅ CALIBRATION COMPLETE! Locked Node 2 Baseline RSSI: %.1f dBm\n\n",
                dynamic_RSSI_STATIC
            );

        }
        else {

            Serial.println(
                "\n⚠️ CALIBRATION TIMEOUT: No Node 2 pings heard. Using fallback baseline (-45.0 dBm)\n"
            );
        }
    }

    // ====================================================
    // 🔴 INSTANT TOUCH BUTTON SOS LOGIC
    // ====================================================

    if (digitalRead(TOUCH_PIN) == HIGH) {

        if (
            millis() - lastTouchTime >
            500
        ) {

            lastTouchTime = millis();

            dWorker = "MINER 01";
            dStatus = "SOS EMERGENCY";

            n3HazardLevel = 2;

            Serial.println(
                "\n🚨 [ INSTANT ALERT ] TOUCH SENSOR ACTIVATED! BROADCASTING MANUAL SOS..."
            );

            digitalWrite(RED_LED, HIGH);
            digitalWrite(YELLOW_LED, LOW);
            digitalWrite(GREEN_LED, LOW);

            // ------------------------------------------------
            // Existing N3 SOS packet fields
            // ------------------------------------------------

            String sosPacket =
                "N3," +
                dWorker + "," +
                dStatus +
                ",0,0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,";

            sosPacket +=
                String(
                    dHelmetDist,
                    1
                ) + ",";

            sosPacket +=
                String(
                    n3HazardLevel
                );

            // ------------------------------------------------
            // v2: append true helmet-link + peer measurements
            // (15 = helmet SNR, 16 = node2 SNR,
            //  17 = helmet RSSI, 18 = node2 RSSI)
            // ------------------------------------------------

            sosPacket += ",";
            sosPacket += String(
                snrHelmet,
                2
            );

            sosPacket += ",";
            sosPacket += String(
                snrNode2,
                2
            );

            sosPacket += ",";
            sosPacket += String(
                rssiHelmet,
                1
            );

            sosPacket += ",";
            sosPacket += String(
                rssiNode2,
                1
            );

            Serial.println(
                "📡 SOS Relay Packet:"
            );

            Serial.println(
                sosPacket
            );

            LoRa.beginPacket();
            LoRa.print(sosPacket);
            LoRa.endPacket();

            LoRa.receive();

            printDashboard();
        }
    }

    // ====================================================
    // MPU HAZARD UPDATE
    // ====================================================

    if (
        millis() - lastMPURead >=
        100
    ) {

        lastMPURead = millis();

        readMPU6050Hazard();
    }

    // ====================================================
    // RECEIVE LoRa PACKET
    // ====================================================

    int packetSize =
        LoRa.parsePacket();

    if (packetSize) {

        String incomingData = "";

        while (LoRa.available())
            incomingData += (char)LoRa.read();

        // ------------------------------------------------
        // IMPORTANT:
        // Capture RSSI + SNR immediately after reception.
        // ------------------------------------------------

        int rawRSSI =
            LoRa.packetRssi();

        float rawSNR =
            LoRa.packetSnr();

        // Return to receive mode
        LoRa.receive();

        // ------------------------------------------------
        // Ignore stray calibration packets.
        // v2: STATION heartbeats from Node 2 ARE accepted so
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
                    // the helmet moved AWAY from Node 3. Match the gateway's
                    // smoothRSSI recede weight (0.30) for responsiveness.
                    rssiHelmet =
                        (0.30 * rawRSSI) +
                        (0.70 * rssiHelmet);
                }
            }

            // ------------------------------------------------
            // SNR smoothing
            // ------------------------------------------------

            if (firstHelmetSNR) {

                snrHelmet = rawSNR;
                firstHelmetSNR = false;
            }
            else {

                snrHelmet =
                    (0.20 * rawSNR) +
                    (0.80 * snrHelmet);
            }

            // ------------------------------------------------
            // Existing distance calculation
            // ------------------------------------------------

            float newDist =
                calculateDistance(
                    rssiHelmet,
                    true
                );

            dHelmetDist =
                smoothValue(
                    dHelmetDist,
                    newDist,
                    0.75
                );

            // ------------------------------------------------
            // Schedule relay
            // ------------------------------------------------

            pendingRelay = true;

            relayTime =
                millis() + 450;

            // ------------------------------------------------
            // Existing N3 packet structure preserved.
            // SNR appended only at the end.
            // ------------------------------------------------

            pendingPacket =
                "N3," +
                incomingData.substring(2) +
                "," +
                String(
                    dHelmetDist,
                    1
                ) +
                "," +
                String(
                    n3HazardLevel
                );

            // ------------------------------------------------
            // v2: append true helmet-link + peer measurements
            // (15 = helmet SNR, 16 = node2 SNR,
            //  17 = helmet RSSI, 18 = node2 RSSI)
            // ------------------------------------------------

            pendingPacket += ",";
            pendingPacket += String(
                snrHelmet,
                2
            );

            pendingPacket += ",";
            pendingPacket += String(
                snrNode2,
                2
            );

            pendingPacket += ",";
            pendingPacket += String(
                rssiHelmet,
                1
            );

            pendingPacket += ",";
            pendingPacket += String(
                rssiNode2,
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
            // Debug
            // ------------------------------------------------

            Serial.println(
                "\n📡 HELMET PACKET RECEIVED"
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
                rssiHelmet
            );

            Serial.printf(
                "Filtered SNR  : %.2f dB\n",
                snrHelmet
            );
        }

        // ==================================================
        // NODE 2 PACKET
        // ==================================================

        else if (senderID == "N2") {

            lastNode2Time = millis();

            // ------------------------------------------------
            // RSSI smoothing
            // v2: 0.85 lock (was 0.99) — the near-total lock froze
            // the N2<->N3 distance at its first value, which looked
            // like a hardcoded distance on the dashboard.
            // Relay packets and STATION heartbeats both refresh
            // this peer measurement.
            // ------------------------------------------------

            if (firstNode2) {

                rssiNode2 = rawRSSI;
                firstNode2 = false;
            }
            else {

                rssiNode2 =
                    smoothValue(
                        rssiNode2,
                        rawRSSI,
                        0.85
                    );
            }

            // ------------------------------------------------
            // SNR smoothing
            // ------------------------------------------------

            if (firstNode2SNR) {

                snrNode2 = rawSNR;
                firstNode2SNR = false;
            }
            else {

                snrNode2 =
                    (0.20 * rawSNR) +
                    (0.80 * snrNode2);
            }

            // ------------------------------------------------
            // Debug
            // ------------------------------------------------

            Serial.println(
                getValue(incomingData, ',', 1) == "STATION"
                ? "\n📡 NODE 2 STATION HEARTBEAT RECEIVED"
                : "\n📡 NODE 2 PACKET RECEIVED"
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
                rssiNode2
            );

            Serial.printf(
                "Filtered SNR  : %.2f dB\n",
                snrNode2
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

        Serial.println(
            "\n📡 RELAYING N3 PACKET:"
        );

        Serial.println(
            pendingPacket
        );

        LoRa.beginPacket();

        LoRa.print(
            pendingPacket
        );

        LoRa.endPacket();

        LoRa.receive();

        printDashboard();
    }

    // ====================================================
    // 🔴 v2 STATION HEARTBEAT (no helmet traffic)
    // Keeps Node 3 visible to the gateway while the helmet
    // is absent, and carries the true helmet-link + peer
    // measurements so the dashboard shows real state.
    // Format:
    // N3,STATION,<helmetAlive>,<hazard>,<rssiHelmet>,<snrHelmet>,<rssiNode2>,<snrNode2>
    // ====================================================

    if (
        millis() - lastHelmetTime > HELMET_QUIET_FOR_HB &&
        millis() - lastStationTx >= STATION_HB_INTERVAL
    ) {

        lastStationTx = millis();

        bool helmetAlive =
            (millis() - lastHelmetTime) < OFFLINE_TIMEOUT;

        String hb =
            "N3,STATION," +
            String(helmetAlive ? 1 : 0) + "," +
            String(n3HazardLevel) + "," +
            String(rssiHelmet, 1) + "," +
            String(snrHelmet, 2) + "," +
            String(rssiNode2, 1) + "," +
            String(snrNode2, 2);

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