# MUKUT Smart Coal Miner Helmet — `context.md`

## 1. Project Identity

**Project Name:** MUKUT Smart Coal Miner Helmet

MUKUT is an IoT-based smart safety helmet designed for underground coal-mining environments where GPS, conventional Wi-Fi, cellular networks, and continuous internet connectivity may be unreliable or unavailable.

The helmet collects safety and environmental information and communicates through a LoRa-based underground node network.

This project is currently being developed as a **hackathon prototype**.

The immediate priority is to build a **live, visually impressive software dashboard** that can demonstrate the MUKUT concept to judges.

The software should be designed so that the simulated/demo data used during development can later be replaced with real telemetry from the existing MUKUT helmet and LoRa hardware with minimal changes.

---

# 2. Current Main Direction

## Core Direction

The current priority is:

> **Build the entire software system first, using a realistic telemetry simulator, and then integrate the existing MUKUT helmet/LoRa hardware through a clearly defined data contract.**

We are working under a strict time constraint.

Therefore:

* Do NOT over-engineer the system.
* Do NOT build unnecessary enterprise infrastructure.
* Do NOT spend excessive time on authentication, complex cloud infrastructure, advanced analytics, ML, or unnecessary features.
* Do NOT tightly couple the dashboard to ESP32 hardware.
* Do NOT build the UI around fake/random values that cannot later be replaced by real telemetry.
* Keep the architecture modular and integration-friendly.
* Prioritize features that create a strong **live visual representation for judges**.

The final system should make the following flow visually understandable:

```text
MUKUT HELMET
     ↓
LoRa Communication
     ↓
Underground Nodes
     ↓
Gateway
     ↓
Backend
     ↓
Real-Time Dashboard
```

During software development:

```text
MUKUT TELEMETRY SIMULATOR
     ↓
Backend
     ↓
Real-Time Dashboard
```

During final hardware integration:

```text
ESP32 + Sensors
     ↓
RA-02 LoRa
     ↓
NODE03 / NODE02 / NODE01
     ↓
Gateway
     ↓
Backend
     ↓
Real-Time Dashboard
```

The simulator and real hardware must use the same telemetry structure.

---

# 3. Product Vision

MUKUT should be presented as more than a helmet with sensors.

The software should visually communicate:

> **MUKUT is a connected underground miner-safety and communication system.**

The dashboard should allow a judge to immediately understand:

1. Is the miner safe?
2. Is the helmet online?
3. Are dangerous gases detected?
4. What are the temperature and humidity?
5. Is SOS active?
6. Which underground node is currently connected?
7. How strong are the LoRa links?
8. What are the estimated distances between nodes and helmet?
9. What happens when an underground node becomes unavailable?
10. Does the communication network automatically reroute?
11. What is the current communication route?

The dashboard should therefore focus heavily on **visual storytelling**.

---

# 4. Primary Software Architecture

The software should use a layered architecture.

```text
┌─────────────────────────────────────────────┐
│              MUKUT DASHBOARD                │
│                                             │
│ Safety │ Environment │ Network │ Events     │
└──────────────────────┬──────────────────────┘
                       │
                 WebSocket / API
                       │
┌──────────────────────▼──────────────────────┐
│                  BACKEND                    │
│                                             │
│ Telemetry Processing                        │
│ Device State                                │
│ Alert Engine                                │
│ Network State                               │
│ Route / Failover Engine                     │
│ Real-Time Event Broadcasting                │
└──────────────────────┬──────────────────────┘
                       │
              Telemetry Interface
                       │
          ┌────────────┴─────────────┐
          │                          │
          ▼                          ▼
┌──────────────────┐      ┌──────────────────┐
│    SIMULATOR     │      │  REAL GATEWAY    │
│                  │      │                  │
│ Demo telemetry   │      │ LoRa telemetry   │
│ during software  │      │ from hardware    │
│ development      │      │ integration      │
└──────────────────┘      └────────┬─────────┘
                                   │
                                   ▼
                         ESP32 + RA-02 Network
```

---

# 5. Hardware Integration Architecture

The existing MUKUT hardware consists primarily of:

## Helmet

* ESP32
* RA-02 LoRa module
* Gas sensors
* Temperature sensor
* Humidity sensor
* SOS input
* MPU6500
* QMC5883L
* OLED
* LEDs / buzzer

The helmet acts as an intelligent wearable safety node.

The current LoRa target node is:

```text
NODE03
```

The broader underground communication concept contains:

```text
NODE01
NODE02
NODE03
HELMET
```

The exact physical topology may evolve.

The software must therefore avoid hardcoding the network topology into the dashboard.

---

# 6. Hardware → Software Integration Principle

The dashboard must NOT directly communicate with ESP32 sensors.

Avoid:

```text
Dashboard ←→ ESP32
```

Instead use:

```text
Helmet
  ↓
LoRa Network
  ↓
Gateway
  ↓
Backend
  ↓
Dashboard
```

The backend becomes the abstraction layer.

This means the dashboard does not need to know whether the telemetry originated from:

* the simulator,
* USB/serial,
* Wi-Fi,
* LoRa gateway,
* or another future communication method.

As long as the incoming telemetry follows the MUKUT data contract, the backend should process it.

---

# 7. Telemetry Contract

A central telemetry schema must be created.

The schema should be versioned so that hardware integration can happen later without redesigning the dashboard.

Example:

```json
{
  "version": "1.0",
  "helmet_id": "HELMET01",
  "timestamp": 1725230000,

  "environment": {
    "temperature": 32.4,
    "humidity": 71.2,
    "methane": 0.21,
    "carbon_monoxide": 18,
    "smoke": 120
  },

  "safety": {
    "sos": false,
    "gas_status": "NORMAL"
  },

  "motion": {
    "moving": true
  },

  "orientation": {
    "heading": 132
  },

  "position": {
    "x": 14.2,
    "y": 8.7
  },

  "network": {
    "connected_node": "NODE03"
  }
}
```

This is an example structure, not a final locked schema.

The implementation team should finalize the schema before extensive backend/dashboard development.

---

# 8. Network Telemetry

The backend should also support network/link information.

Example:

```json
{
  "source": "NODE03",
  "destination": "NODE02",
  "rssi": -72,
  "distance": 38,
  "status": "CONNECTED"
}
```

The system should support:

* Node-to-node RSSI
* Helmet-to-node RSSI
* Estimated distance
* Connection status
* Current route
* Previous route
* Route changes
* Node availability
* Failover events

---

# 9. Main Dashboard Goals

The dashboard is primarily a **visual demonstration system**.

The initial dashboard should contain the following major sections.

## A. Overall Safety Status

Large, immediately visible status.

Example:

```text
WORKER STATUS

✓ SAFE
```

Possible states:

```text
SAFE
WARNING
EMERGENCY
```

---

## B. Helmet Status

Show:

```text
HELMET01
● ONLINE
```

or:

```text
HELMET01
● OFFLINE
```

Maintain a `last_seen` timestamp in the backend.

Example logic:

```text
current_time - last_seen
```

If telemetry has not been received within the configured timeout:

```text
OFFLINE
```

The timeout should be configurable.

---

# 10. Environmental Monitoring

Display at minimum:

### Temperature

```text
32.4 °C
```

### Humidity

```text
71 %
```

### Gas monitoring

The dashboard should show both value and safety state.

Example:

```text
METHANE
████████░░
NORMAL

CO
██████░░░░
NORMAL

SMOKE
█████████░
WARNING
```

Possible overall gas states:

```text
NORMAL
WARNING
CRITICAL
```

Thresholds must be configurable in the backend.

The UI should not hardcode safety logic.

---

# 11. Emergency SOS

SOS must be visually prominent.

Normal:

```text
WORKER STATUS

✓ SAFE

No emergency detected
```

Emergency:

```text
EMERGENCY

SOS ACTIVE

HELMET01
NODE03
```

When SOS activates:

* create an event
* update worker status
* broadcast real-time update
* make the dashboard visually obvious
* preserve the event in the event timeline

---

# 12. Network Visualization

One of the most important visual sections is the underground communication network.

Example:

```text
                 NODE 1
                   │
                   │
                 NODE 2
                   │
                   │
                 NODE 3
                   │
                   │
                HELMET
```

The actual topology should be generated from backend state rather than hardcoded UI elements.

Each link should support:

* RSSI
* estimated distance
* status
* connection quality

---

# 13. RSSI Visualization

Show RSSI using increasing/decreasing bars.

Example:

```text
NODE03 → NODE02

RSSI
██████████████░░░░
-72 dBm
```

And:

```text
NODE03 → HELMET01

RSSI
██████████████████
-61 dBm
```

The bar should dynamically change as RSSI changes.

RSSI values should be interpreted correctly:

* values closer to 0 dBm are generally stronger
* more negative values are generally weaker

The UI must not simply treat a larger negative number as a stronger signal.

---

# 14. Distance Visualization

Show estimated distance separately from RSSI.

Example:

```text
NODE03 → NODE02

DISTANCE
██████████░░░░░░░░
38 m
```

And:

```text
NODE03 → HELMET01

DISTANCE
█████░░░░░░░░░░░░░
17 m
```

Distance is an estimate.

The dashboard should visually communicate it as an estimated value rather than claiming laboratory-grade positioning accuracy.

---

# 15. Network Failover Visualization

This is a key MUKUT feature.

Normal route:

```text
HELMET
   ↓
NODE03
   ↓
NODE02
   ↓
NODE01
   ↓
BACKEND
```

If NODE02 becomes unavailable:

```text
NODE02
   X

HELMET
   ↓
NODE03 ─────────→ NODE01
                    ↓
                  BACKEND
```

The backend should detect route changes and create an event.

Example dashboard event:

```text
NETWORK ROUTE CHANGED

NODE02 UNAVAILABLE

Previous:
HELMET → NODE03 → NODE02 → NODE01

Current:
HELMET → NODE03 → NODE01

FAILOVER ACTIVE
```

This feature is extremely important for the hackathon demonstration because it visually proves that the system is designed for unreliable underground communication.

---

# 16. Event Timeline

The dashboard should include a live event feed.

Example:

```text
RECENT EVENTS

12:41:03   ⚠ High temperature detected
12:40:51   ✓ Helmet telemetry received
12:40:32   ⚠ NODE02 connection weakened
12:40:30   ✓ Route changed NODE03 → NODE01
12:39:58   ✓ Worker status SAFE
```

Events should be generated by the backend.

The simulator should be able to trigger events so that the entire dashboard can be demonstrated live.

---

# 17. Live Simulator

A simulator is mandatory for rapid software development.

It should simulate:

### Normal operation

```text
Temperature → gradual variation
Humidity → gradual variation
Gas → safe values
SOS → false
Helmet → online
RSSI → normal fluctuation
Distance → normal fluctuation
Nodes → available
```

### Warning scenario

```text
Gas increases
Temperature increases
RSSI weakens
```

### Emergency scenario

```text
SOS = true
Worker = EMERGENCY
Alert generated
```

### Node failure scenario

```text
NODE02 = OFFLINE
```

### Failover scenario

```text
NODE03 → NODE02 → NODE01

becomes:

NODE03 → NODE01
```

The simulator should be controllable.

Possible controls:

```text
NORMAL
GAS WARNING
GAS CRITICAL
SOS
NODE02 FAILURE
RESTORE NODE02
WEAK RSSI
HELMET OFFLINE
```

This allows judges to see the dashboard react in real time.

---

# 18. Real-Time Communication

The dashboard should update without manual page refresh.

Preferred architecture:

```text
Backend
   ↓
WebSocket
   ↓
Dashboard
```

REST APIs can be used for:

* initial state
* historical data
* configuration
* health checks

WebSockets should be used for:

* sensor updates
* alerts
* SOS
* node state changes
* route changes
* network events

If WebSockets create unnecessary implementation complexity, use a simpler real-time mechanism first, but maintain a clean abstraction so WebSockets can be added without redesigning the application.

---

# 19. Main Goals That MUST Be Completed

The following are the primary goals.

## GOAL 1 — Functional Backend

The backend must:

* receive telemetry
* validate telemetry
* maintain latest helmet state
* maintain node state
* calculate online/offline status
* process alerts
* maintain network state
* process route changes
* broadcast live updates

---

## GOAL 2 — Realistic Telemetry Simulator

The simulator must produce realistic changing data.

It must support:

* normal state
* gas warning
* gas critical
* SOS
* helmet offline
* node failure
* RSSI changes
* route changes
* recovery

---

## GOAL 3 — Live Dashboard

The dashboard must visibly show:

* Worker safety status
* Helmet online/offline
* Temperature
* Humidity
* Gas status
* SOS
* Node status
* RSSI
* Estimated distance
* Network topology
* Current route
* Failover
* Event timeline

---

## GOAL 4 — Strong Visual Representation

The dashboard should be optimized for a hackathon judge watching a live demonstration.

Prioritize:

* clear hierarchy
* large safety indicators
* real-time animations where useful
* network visualization
* dynamic bars
* obvious alerts
* visible route changes
* minimal clutter
* professional visual design

Avoid turning the dashboard into a dense engineering control panel.

The judge should understand the system within seconds.

---

## GOAL 5 — Hardware Integration Contract

The software must expose a clean interface through which real MUKUT telemetry can later be injected.

The integration should eventually become:

```text
ESP32
 ↓
RA-02
 ↓
LoRa Nodes
 ↓
Gateway
 ↓
Telemetry Adapter
 ↓
MUKUT Backend
```

The dashboard should require no major rewrite.

---

# 20. Integration Parameters

The final hardware integration should primarily require configuration of parameters such as:

```text
HELMET_ID
NODE_ID
GATEWAY_ID

LORA_FREQUENCY
LORA_NETWORK_CONFIGURATION

BACKEND_HOST
BACKEND_PORT

TELEMETRY_ENDPOINT
REALTIME_ENDPOINT

HEARTBEAT_INTERVAL
OFFLINE_TIMEOUT

GAS_THRESHOLDS
TEMPERATURE_THRESHOLDS

NODE_TO_NODE_LINK_CONFIGURATION
```

Do not hardcode these values throughout the application.

Keep them centralized in configuration.

---

# 21. Development Priorities

Because the project has a strict deadline, development priority is:

### Priority 1

```text
Backend
+
Telemetry Contract
+
Simulator
```

### Priority 2

```text
Dashboard
+
Real-Time Updates
```

### Priority 3

```text
Network Visualization
+
RSSI
+
Distance
+
Failover
```

### Priority 4

```text
Real Hardware Integration
```

### Priority 5

Optional enhancements only if time remains.

---

# 22. Explicit Scope Control

Do NOT prioritize the following right now:

* complex authentication
* multi-tenant architecture
* enterprise cloud infrastructure
* advanced machine learning
* complex predictive analytics
* unnecessary microservices
* excessive database architecture
* elaborate user management
* complicated deployment pipelines
* features unrelated to the core MUKUT demonstration

The goal is a **working, visually convincing, technically credible hackathon prototype**.

---

# 23. Definition of Success

The software is considered successful when the following live demonstration works:

```text
1. Dashboard opens.

2. Helmet01 appears ONLINE.

3. Temperature and humidity update live.

4. Gas status is NORMAL.

5. Worker status is SAFE.

6. Network topology shows:
   
   HELMET → NODE03 → NODE02 → NODE01

7. RSSI and estimated distance change dynamically.

8. Trigger GAS WARNING.

   Dashboard immediately shows warning.

9. Trigger SOS.

   Dashboard immediately shows EMERGENCY.

10. Trigger NODE02 FAILURE.

    Dashboard shows NODE02 unavailable.

11. Route automatically changes:

    HELMET → NODE03 → NODE01

12. Dashboard displays:
    
    FAILOVER ACTIVE

13. Restore NODE02.

14. Network returns to normal route.

15. Later, replace simulator input with real MUKUT telemetry
    without changing the core dashboard.
```

---

# 24. Final Architectural Principle

The most important principle for the entire project is:

> **Build the software around telemetry, not around the current hardware implementation.**

The software should behave as if a real underground MUKUT network already exists.

The simulator represents the hardware during development.

The real LoRa gateway will replace the simulator during integration.

Therefore:

```text
             SAME TELEMETRY CONTRACT

       ┌────────────────────────────┐
       │                            │
       ▼                            ▼
MUKUT SIMULATOR              REAL MUKUT NETWORK
       │                            │
       └──────────────┬─────────────┘
                      ▼
                  BACKEND
                      │
                      ▼
                 DASHBOARD
```

This architecture allows the team to build the entire software experience immediately while keeping the door open for real ESP32 + RA-02 integration.

---

# 25. Current Mission

The immediate mission is NOT to build every possible feature.

The immediate mission is:

> **Create a polished, live, interactive MUKUT dashboard that convincingly demonstrates miner safety monitoring, underground LoRa network visibility, and automatic communication failover.**

Everything else is secondary.

Build the foundation cleanly, keep the telemetry contract stable, make the simulator realistic, and make the dashboard visually strong.

Once the software demonstration is stable, connect the real MUKUT helmet and LoRa network through the telemetry integration layer.
