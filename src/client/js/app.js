/**
 * MUKUT Smart Coal Miner Helmet — Phase 1 Client Application
 * Handles WebSocket communication, DOM rendering, relative timers, and simulator controls.
 */

(function () {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let currentState = null;
  let currentScenario = 'NORMAL';
  let lastSeenTimestamp = null;
  let relativeTimer = null;

  // DOM Elements Cache
  const elements = {
    lastSeenValue: document.getElementById('lastSeenValue'),
    helmetOnlineBadge: document.getElementById('helmetOnlineBadge'),
    helmetIdDisplay: document.getElementById('helmetIdDisplay'),
    helmetStateDisplay: document.getElementById('helmetStateDisplay'),

    distLockBadge: document.getElementById('distLockBadge'),

    workerSafetyCard: document.getElementById('workerSafetyCard'),
    statusCodeDisplay: document.getElementById('statusCodeDisplay'),
    safetyStateDisplay: document.getElementById('safetyStateDisplay'),
    safetyReasonDisplay: document.getElementById('safetyReasonDisplay'),

    tempCard: document.getElementById('tempCard'),
    tempValue: document.getElementById('tempValue'),
    tempBadge: document.getElementById('tempBadge'),

    humidityCard: document.getElementById('humidityCard'),
    humidityValue: document.getElementById('humidityValue'),
    humidityBadge: document.getElementById('humidityBadge'),

    sosCard: document.getElementById('sosCard'),
    sosValue: document.getElementById('sosValue'),
    sosBadge: document.getElementById('sosBadge'),

    gasOverallBadge: document.getElementById('gasOverallBadge'),
    methaneValue: document.getElementById('methaneValue'),
    methaneFill: document.getElementById('methaneFill'),
    methaneStatus: document.getElementById('methaneStatus'),

    coValue: document.getElementById('coValue'),
    coFill: document.getElementById('coFill'),
    coStatus: document.getElementById('coStatus'),

    smokeValue: document.getElementById('smokeValue'),
    smokeFill: document.getElementById('smokeFill'),
    smokeStatus: document.getElementById('smokeStatus'),

    eventsCount: document.getElementById('eventsCount'),
    eventsTableBody: document.getElementById('eventsTableBody'),

    alertsContainer: document.getElementById('alertsContainer'),
    helmetSliderMarker: document.getElementById('helmetSliderMarker'),
    distNode2: document.getElementById('distNode2'),
    distNode3: document.getElementById('distNode3'),
    fixedDistance: document.getElementById('fixedDistance'),
    lastKnownLocation: document.getElementById('lastKnownLocation'),
    hazardNode2: document.getElementById('hazardNode2'),
    hazardNode3: document.getElementById('hazardNode3'),
    structuralOverallBadge: document.getElementById('structuralOverallBadge'),

    casualtyCard: document.getElementById('casualtyCard'),
    casualtyStatusBadge: document.getElementById('casualtyStatusBadge'),
    rescueClosestNodeId: document.getElementById('rescueClosestNodeId'),
    rescueClosestNodeStatus: document.getElementById('rescueClosestNodeStatus'),
    rescueClosestDist: document.getElementById('rescueClosestDist'),
    rescueClosestRssi: document.getElementById('rescueClosestRssi'),
    rescueSecondaryNodeId: document.getElementById('rescueSecondaryNodeId'),
    rescueSecondaryNodeStatus: document.getElementById('rescueSecondaryNodeStatus'),
    rescueSecondaryDist: document.getElementById('rescueSecondaryDist'),
    rescueSecondaryRssi: document.getElementById('rescueSecondaryRssi'),
    casualtyIncidentSummary: document.getElementById('casualtyIncidentSummary'),

    activeModeDisplay: document.getElementById('activeModeDisplay'),
    scenarioButtons: document.querySelectorAll('.btn-scenario')
  };

  // Helper: Format Relative Time
  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'No data';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 2) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    return `${mins}m ${seconds % 60}s ago`;
  }

  // Update Relative Time Tick
  function updateLastSeenTick() {
    if (lastSeenTimestamp && elements.lastSeenValue) {
      elements.lastSeenValue.textContent = formatRelativeTime(lastSeenTimestamp);
    }
  }

  // Helper: Update Badge Status Class
  function setStatusClass(element, status) {
    if (!element) return;
    element.classList.remove('status-normal', 'status-warning', 'status-critical');
    if (status === 'NORMAL' || status === 'SAFE' || status === 'INACTIVE') {
      element.classList.add('status-normal');
    } else if (status === 'WARNING') {
      element.classList.add('status-warning');
    } else if (status === 'CRITICAL' || status === 'EMERGENCY' || status === 'ACTIVE') {
      element.classList.add('status-critical');
    }
  }

  // Render Full State to UI
  function renderState(state) {
    if (!state) return;
    currentState = state;
    lastSeenTimestamp = state.last_seen;

    // 1. Header Helmet Online/Offline State
    if (elements.helmetIdDisplay) elements.helmetIdDisplay.textContent = state.helmet_id || 'HELMET01';
    if (elements.helmetStateDisplay) elements.helmetStateDisplay.textContent = state.online ? 'ONLINE' : 'OFFLINE';
    if (elements.helmetOnlineBadge) {
      if (state.online) {
        elements.helmetOnlineBadge.classList.remove('is-offline');
        elements.helmetOnlineBadge.classList.add('is-online');
      } else {
        elements.helmetOnlineBadge.classList.remove('is-online');
        elements.helmetOnlineBadge.classList.add('is-offline');
      }
    }
    updateLastSeenTick();

    if (state.calibration && elements.distLockBadge) {
      if (state.calibration.status === 'RUNNING') {
        elements.distLockBadge.textContent = 'CALIBRATING…';
        setStatusClass(elements.distLockBadge, 'WARNING');
      } else if (state.calibration.status === 'LOCKED') {
        elements.distLockBadge.textContent = 'DIST: LOCKED';
        setStatusClass(elements.distLockBadge, 'NORMAL');
      } else {
        elements.distLockBadge.textContent = 'DIST: LIVE';
        setStatusClass(elements.distLockBadge, 'WARNING');
      }
    }

    // 2. Dominant Worker Safety Card
    if (elements.workerSafetyCard) {
      elements.workerSafetyCard.classList.remove('status-safe', 'status-warning', 'status-emergency');
      if (state.status === 'SAFE') {
        elements.workerSafetyCard.classList.add('status-safe');
        if (elements.statusCodeDisplay) elements.statusCodeDisplay.textContent = '[ CODE 00: NOMINAL ]';
      } else if (state.status === 'WARNING') {
        elements.workerSafetyCard.classList.add('status-warning');
        if (elements.statusCodeDisplay) elements.statusCodeDisplay.textContent = '[ CODE 02: WARNING ]';
      } else {
        elements.workerSafetyCard.classList.add('status-emergency');
        if (elements.statusCodeDisplay) elements.statusCodeDisplay.textContent = '[ CODE 99: EMERGENCY ]';
      }
    }
    if (elements.safetyStateDisplay) elements.safetyStateDisplay.textContent = state.status;
    if (elements.safetyReasonDisplay) elements.safetyReasonDisplay.textContent = state.status_reason || 'Status updated';

    // 3. Temperature & Humidity
    if (state.environment) {
      if (elements.tempValue) elements.tempValue.textContent = state.environment.temperature.toFixed(1);
      if (elements.tempBadge) {
        elements.tempBadge.textContent = state.temp_status;
        setStatusClass(elements.tempBadge, state.temp_status);
      }

      if (elements.humidityValue) elements.humidityValue.textContent = typeof state.environment.humidity === 'number' ? state.environment.humidity.toFixed(1) : state.environment.humidity;
      if (elements.humidityBadge) {
        elements.humidityBadge.textContent = state.humidity_status;
        setStatusClass(elements.humidityBadge, state.humidity_status);
      }
    }

    // 4. SOS State
    const isSosActive = Boolean(state.sos);
    if (elements.sosValue) elements.sosValue.textContent = isSosActive ? 'ACTIVE' : 'INACTIVE';
    if (elements.sosBadge) {
      elements.sosBadge.textContent = isSosActive ? 'ACTIVE' : 'INACTIVE';
      setStatusClass(elements.sosBadge, isSosActive ? 'ACTIVE' : 'INACTIVE');
    }
    if (elements.sosCard) {
      if (isSosActive) {
        elements.sosCard.classList.add('sos-active');
      } else {
        elements.sosCard.classList.remove('sos-active');
      }
    }

    // 5. Gas Monitoring
    if (state.gas_status) {
      // Overall Badge
      if (elements.gasOverallBadge) {
        elements.gasOverallBadge.textContent = `ATMOSPHERE: ${state.gas_status.overall}`;
        setStatusClass(elements.gasOverallBadge, state.gas_status.overall);
      }

      // Methane (CH4)
      const ch4 = state.gas_status.methane;
      if (ch4) {
        if (elements.methaneValue) elements.methaneValue.textContent = ch4.value;
        if (elements.methaneFill) {
          elements.methaneFill.style.width = `${ch4.percentage}%`;
          elements.methaneFill.style.backgroundColor = ch4.status === 'CRITICAL' ? '#b91c1c' : ch4.status === 'WARNING' ? '#b45309' : '#0f172a';
        }
        if (elements.methaneStatus) {
          elements.methaneStatus.textContent = ch4.status;
          setStatusClass(elements.methaneStatus, ch4.status);
        }
      }

      // Carbon Monoxide / LPG (CO)
      const co = state.gas_status.carbon_monoxide;
      if (co) {
        if (elements.coValue) elements.coValue.textContent = co.value;
        if (elements.coFill) {
          elements.coFill.style.width = `${co.percentage}%`;
          elements.coFill.style.backgroundColor = co.status === 'CRITICAL' ? '#b91c1c' : co.status === 'WARNING' ? '#b45309' : '#0f172a';
        }
        if (elements.coStatus) {
          elements.coStatus.textContent = co.status;
          setStatusClass(elements.coStatus, co.status);
        }
      }

      // Smoke / H2 (PM)
      const smoke = state.gas_status.smoke;
      if (smoke) {
        if (elements.smokeValue) elements.smokeValue.textContent = smoke.value;
        if (elements.smokeFill) {
          elements.smokeFill.style.width = `${smoke.percentage}%`;
          elements.smokeFill.style.backgroundColor = smoke.status === 'CRITICAL' ? '#b91c1c' : smoke.status === 'WARNING' ? '#b45309' : '#0f172a';
        }
        if (elements.smokeStatus) {
          elements.smokeStatus.textContent = smoke.status;
          setStatusClass(elements.smokeStatus, smoke.status);
        }
      }
    }

    // 6. Alert Banners Container (Structural & Safety Alerts)
    if (elements.alertsContainer) {
      let alertsHtml = '';
      if (Array.isArray(state.active_emergencies) && state.active_emergencies.length > 0) {
        state.active_emergencies.forEach(em => {
          alertsHtml += `<div class="alert-banner">🚨 <b>${em.source || 'CRITICAL'}:</b> ${em.message}</div>`;
        });
      }
      if (Array.isArray(state.active_alerts) && state.active_alerts.length > 0) {
        state.active_alerts.forEach(al => {
          alertsHtml += `<div class="alert-banner warning">⚠️ <b>${al.source || 'WARNING'}:</b> ${al.message}</div>`;
        });
      }
      elements.alertsContainer.innerHTML = alertsHtml;
    }

    // 7. Spatial Proximity Solver
    if (state.spatial_position) {
      const sp = state.spatial_position;
      if (elements.helmetSliderMarker) elements.helmetSliderMarker.style.left = `${sp.relative_slider_pct != null ? sp.relative_slider_pct : 50}%`;
      if (elements.distNode2) elements.distNode2.textContent = sp.dist_n2 != null && sp.dist_n2 >= 0 ? `${sp.dist_n2.toFixed(1)} m` : '-- m';
      if (elements.distNode3) elements.distNode3.textContent = sp.dist_n3 != null && sp.dist_n3 >= 0 ? `${sp.dist_n3.toFixed(1)} m` : '-- m';
      if (elements.fixedDistance) elements.fixedDistance.textContent = sp.fixed_dist != null && sp.fixed_dist >= 0 ? `${sp.fixed_dist.toFixed(1)} m` : '-- m';
      if (elements.lastKnownLocation) elements.lastKnownLocation.textContent = sp.nearest_node || 'NODE03';
    }

    // 8. Structural Health & Tunnel Shake Monitoring
    if (state.structural_health) {
      const sh = state.structural_health;
      if (elements.hazardNode2 && sh.node2) {
        elements.hazardNode2.textContent = sh.node2.status || 'STABLE';
        elements.hazardNode2.className = `hazard-pill ${sh.node2.status === 'CRITICAL_HAZARD' ? 'critical' : (sh.node2.status === 'WARNING_SHIFT' ? 'warning' : 'stable')}`;
      }
      if (elements.hazardNode3 && sh.node3) {
        elements.hazardNode3.textContent = sh.node3.status || 'STABLE';
        elements.hazardNode3.className = `hazard-pill ${sh.node3.status === 'CRITICAL_HAZARD' ? 'critical' : (sh.node3.status === 'WARNING_SHIFT' ? 'warning' : 'stable')}`;
      }
      if (elements.structuralOverallBadge) {
        const hasCrit = sh.node2?.status === 'CRITICAL_HAZARD' || sh.node3?.status === 'CRITICAL_HAZARD';
        const hasWarn = sh.node2?.status === 'WARNING_SHIFT' || sh.node3?.status === 'WARNING_SHIFT';
        elements.structuralOverallBadge.textContent = hasCrit ? 'HAZARD: CRITICAL COLLAPSE/VIBRATION' : (hasWarn ? 'HAZARD: WARNING SHIFT' : 'SYSTEM STABLE');
        setStatusClass(elements.structuralOverallBadge, hasCrit ? 'CRITICAL' : (hasWarn ? 'WARNING' : 'NORMAL'));
      }
    }

    // 9. Casualty Assessment & Incident Rescue Dispatch Panel
    if (state.casualty_assessment) {
      const ca = state.casualty_assessment;
      const isIncident = ca.has_incident;

      if (elements.casualtyCard) {
        if (isIncident) {
          elements.casualtyCard.classList.add('incident-active');
        } else {
          elements.casualtyCard.classList.remove('incident-active');
        }
      }

      if (elements.casualtyStatusBadge) {
        if (ca.is_sos) {
          elements.casualtyStatusBadge.textContent = '🚨 SOS CASUALTY ALARM ACTIVE';
          elements.casualtyStatusBadge.className = 'status-pill status-emergency';
        } else if (ca.hazards && ca.hazards.length > 0) {
          elements.casualtyStatusBadge.textContent = `⚠️ STRUCTURAL HAZARD (${ca.hazards.map(h => `${h.node_id}: ${h.status}`).join(', ')})`;
          elements.casualtyStatusBadge.className = 'status-pill status-critical';
        } else {
          elements.casualtyStatusBadge.textContent = 'ALL STATIONS SECURE';
          elements.casualtyStatusBadge.className = 'status-pill status-normal';
        }
      }

      // Closest Rescue Node
      if (ca.closest_node) {
        if (elements.rescueClosestNodeId) elements.rescueClosestNodeId.textContent = `${ca.closest_node.id} (${ca.closest_node.name || 'Station'})`;
        if (elements.rescueClosestNodeStatus) {
          elements.rescueClosestNodeStatus.textContent = ca.closest_node.hazard || 'ONLINE';
          elements.rescueClosestNodeStatus.className = `hazard-pill ${ca.closest_node.hazard === 'CRITICAL_HAZARD' ? 'critical' : (ca.closest_node.hazard === 'WARNING_SHIFT' ? 'warning' : 'stable')}`;
        }
        if (elements.rescueClosestDist) elements.rescueClosestDist.textContent = `DISTANCE: ${ca.closest_node.distance_m != null ? `${ca.closest_node.distance_m} m` : '-- m'}`;
        if (elements.rescueClosestRssi) elements.rescueClosestRssi.textContent = `SIGNAL: ${ca.closest_node.rssi_dbm} dBm`;
      }

      // Secondary Active Node / Shaking Node
      const secondaryNode = (ca.active_nodes || []).find(n => !ca.closest_node || n.id !== ca.closest_node.id);
      if (secondaryNode) {
        if (elements.rescueSecondaryNodeId) elements.rescueSecondaryNodeId.textContent = `${secondaryNode.id} (${secondaryNode.name || 'Station'})`;
        if (elements.rescueSecondaryNodeStatus) {
          elements.rescueSecondaryNodeStatus.textContent = secondaryNode.hazard || 'ONLINE';
          elements.rescueSecondaryNodeStatus.className = `hazard-pill ${secondaryNode.hazard === 'CRITICAL_HAZARD' ? 'critical' : (secondaryNode.hazard === 'WARNING_SHIFT' ? 'warning' : 'stable')}`;
        }
        if (elements.rescueSecondaryDist) elements.rescueSecondaryDist.textContent = `DISTANCE: ${secondaryNode.distance_m != null ? `${secondaryNode.distance_m} m` : '-- m'}`;
        if (elements.rescueSecondaryRssi) elements.rescueSecondaryRssi.textContent = `SIGNAL: ${secondaryNode.rssi_dbm} dBm`;
      }

      // Incident Summary Banner
      if (elements.casualtyIncidentSummary) {
        if (ca.is_sos) {
          elements.casualtyIncidentSummary.className = 'incident-summary-banner danger';
          elements.casualtyIncidentSummary.innerHTML = `🚨 <b>CRITICAL DISPATCH:</b> Miner 01 triggered SOS panic switch! Recommend immediate extraction via <b>${ca.closest_node ? ca.closest_node.id : 'NODE03'}</b> (Distance: ${ca.closest_node?.distance_m}m, RSSI: ${ca.closest_node?.rssi_dbm} dBm).`;
        } else if (ca.hazards && ca.hazards.length > 0) {
          const h = ca.hazards[0];
          elements.casualtyIncidentSummary.className = 'incident-summary-banner danger';
          elements.casualtyIncidentSummary.innerHTML = `⚠️ <b>STRUCTURAL HAZARD DISPATCH:</b> ${h.name} detected ${h.status}! Miner location: ${h.miner_distance_m != null ? `${h.miner_distance_m}m` : '--'} from vibrating station (RSSI: ${h.rssi_dbm} dBm). Nearest safe extraction gateway: <b>${ca.closest_node ? ca.closest_node.id : 'NODE03'}</b> (${ca.closest_node?.distance_m != null ? `${ca.closest_node.distance_m}m` : '--'}, ${ca.closest_node?.rssi_dbm} dBm).`;
        } else {
          elements.casualtyIncidentSummary.className = 'incident-summary-banner';
          elements.casualtyIncidentSummary.innerHTML = `ℹ️ <b>STANDBY MONITORING:</b> All stations structurally stable. Continuous spatial proximity tracking active (${ca.nearest_location_summary}).`;
        }
      }
    }

    // 10. Events List
    if (state.events && Array.isArray(state.events)) {
      renderEvents(state.events);
    }
  }

  // Render Event Table
  function renderEvents(events) {
    if (!elements.eventsTableBody) return;
    if (elements.eventsCount) elements.eventsCount.textContent = `LOGGED: ${events.length}`;

    if (events.length === 0) {
      elements.eventsTableBody.innerHTML = '<tr><td colspan="3" class="empty-state">No events recorded</td></tr>';
      return;
    }

    const rowsHtml = events.map(evt => {
      let tagClass = 'tag-info';
      let tagLabel = 'INFO';
      if (evt.severity === 'WARNING') {
        tagClass = 'tag-warning';
        tagLabel = 'WARN';
      } else if (evt.severity === 'EMERGENCY') {
        tagClass = 'tag-emergency';
        tagLabel = 'EMRG';
      }

      return `
        <tr>
          <td style="color: var(--text-secondary);">${evt.timeStr || '--:--:--'}</td>
          <td><span class="event-severity-tag ${tagClass}">${tagLabel}</span></td>
          <td style="font-weight: 500;">${evt.message}</td>
        </tr>
      `;
    }).join('');

    elements.eventsTableBody.innerHTML = rowsHtml;
  }

  // Simulator Scenario Trigger
  async function triggerScenario(scenario) {
    try {
      currentScenario = scenario === 'RESET' ? 'NORMAL' : scenario;
      updateScenarioButtonState(currentScenario);

      const response = await fetch('/api/simulator/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario })
      });

      if (!response.ok) {
        console.error('Failed to set scenario:', await response.text());
      }
    } catch (err) {
      console.error('Error triggering scenario:', err);
    }
  }

  function updateScenarioButtonState(scenario) {
    if (elements.activeModeDisplay) {
      elements.activeModeDisplay.textContent = `MODE: ${scenario}`;
    }
    elements.scenarioButtons.forEach(btn => {
      if (btn.dataset.scenario === scenario) {
        btn.classList.add('active');
      } else if (btn.dataset.scenario !== 'RESET') {
        btn.classList.remove('active');
      }
    });
  }

  // WebSocket Connection Management
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async function () {
      console.log('✓ Connected to MUKUT Real-Time Telemetry Server');
      if (elements.lastSeenValue) elements.lastSeenValue.textContent = 'Active stream';
      
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const cfg = await res.json();
          const dsValue = document.getElementById('dataSourceValue');
          if (dsValue && cfg.hardware) {
            const ds = cfg.hardware.data_source;
            if (ds === 'hardware' || ds === 'serial') {
              dsValue.textContent = 'LIVE HARDWARE (Serial)';
              dsValue.style.color = '#10b981';
            } else if (ds === 'node1' || ds === 'node1_wifi') {
              dsValue.textContent = `LIVE NODE1 WiFi (${cfg.hardware.node1_ip})`;
              dsValue.style.color = '#10b981';
            } else {
              dsValue.textContent = 'SIMULATOR';
              dsValue.style.color = '#f59e0b';
            }
          }
        }
      } catch (e) {
        console.error('Failed to fetch config', e);
      }
    };

    ws.onmessage = function (event) {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'INIT_STATE' || message.type === 'STATE_UPDATE') {
          renderState(message.payload);
          if (message.simulator && message.simulator.scenario) {
            updateScenarioButtonState(message.simulator.scenario);
          }
        } else if (message.type === 'EVENT') {
          // Prepend event to local events list and re-render
          if (currentState && currentState.events) {
            currentState.events.unshift(message.payload);
            if (currentState.events.length > 50) currentState.events.pop();
            renderEvents(currentState.events);
          }
        }
      } catch (err) {
        console.error('Failed to parse incoming WebSocket message:', err);
      }
    };

    ws.onclose = function () {
      console.warn('WebSocket disconnected. Reconnecting in 2 seconds...');
      if (elements.lastSeenValue) elements.lastSeenValue.textContent = 'Disconnected';
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = function (err) {
      console.error('WebSocket error:', err);
      ws.close();
    };
  }

  // Initial Setup
  function init() {
    // Setup button listeners
    elements.scenarioButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const scenario = btn.dataset.scenario;
        if (scenario) triggerScenario(scenario);
      });
    });

    // Start relative timer ticker
    relativeTimer = setInterval(updateLastSeenTick, 1000);

    // Initial fetch of state via REST in case WS takes a moment
    fetch('/api/state')
      .then(res => res.json())
      .then(data => renderState(data))
      .catch(err => console.warn('REST initial state fetch failed:', err));

    // Connect WebSocket for live streaming
    connectWebSocket();
  }

  // Launch when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
