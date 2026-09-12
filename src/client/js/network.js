/**
 * MUKUT Smart Coal Miner Helmet — Phase 2 Underground Network Monitor
 * Manages WebSocket state streaming, visual topology rendering, RSSI interpretations, and network controls.
 */

(function () {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let currentState = null;
  let currentScenario = 'NETWORK_NORMAL';
  let lastSeenTimestamp = null;
  let relativeTimer = null;

  // DOM Elements Cache
  const elements = {
    lastSeenValue: document.getElementById('lastSeenValue'),
    helmetOnlineBadge: document.getElementById('helmetOnlineBadge'),
    helmetIdDisplay: document.getElementById('helmetIdDisplay'),
    helmetStateDisplay: document.getElementById('helmetStateDisplay'),

    networkHealthDisplay: document.getElementById('networkHealthDisplay'),
    activeRouteDisplay: document.getElementById('activeRouteDisplay'),
    connectedTargetDisplay: document.getElementById('connectedTargetDisplay'),

    linkDetailsTableBody: document.getElementById('linkDetailsTableBody'),
    linkCountDisplay: document.getElementById('linkCountDisplay'),

    diagNodesOnline: document.getElementById('diagNodesOnline'),
    diagHelmetStatus: document.getElementById('diagHelmetStatus'),
    diagPropHealth: document.getElementById('diagPropHealth'),
    diagPacketLoss: document.getElementById('diagPacketLoss'),
    diagStatusTag: document.getElementById('diagStatusTag'),

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
    scenarioButtons: document.querySelectorAll('.btn-scenario'),

    distLockBadge: document.getElementById('distLockBadge'),
    btnCalibrate: document.getElementById('btnCalibrate'),
    calibStatusChip: document.getElementById('calibStatusChip')
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

  function updateLastSeenTick() {
    if (lastSeenTimestamp && elements.lastSeenValue) {
      elements.lastSeenValue.textContent = formatRelativeTime(lastSeenTimestamp);
    }
  }

  function setStatusClass(element, status) {
    if (!element) return;
    element.classList.remove('status-normal', 'status-warning', 'status-critical', 'status-offline');
    if (status === 'NORMAL' || status === 'GOOD' || status === 'ONLINE' || status === 'CONNECTED' || status === 'EXCELLENT') {
      element.classList.add('status-normal');
    } else if (status === 'WARNING' || status === 'DEGRADED' || status === 'FAIR' || status === 'WEAK') {
      element.classList.add('status-warning');
    } else {
      element.classList.add('status-critical');
    }
  }

  // Generate discrete 4-bar mini signal graphic
  function renderMiniSignalBar(quality, percentage) {
    let activeBars = 1;
    if (quality === 'EXCELLENT') activeBars = 4;
    else if (quality === 'GOOD') activeBars = 3;
    else if (quality === 'FAIR') activeBars = 2;
    else activeBars = 1;

    const isWeak = quality === 'WEAK' || quality === 'FAIR';
    const barsHtml = [1, 2, 3, 4].map(idx => {
      const heightPx = 3 + idx * 3;
      const onClass = idx <= activeBars ? 'on' : '';
      return `<span class="bar-seg ${onClass}" style="height: ${heightPx}px;"></span>`;
    }).join('');

    return `<div class="mini-signal-bar ${isWeak ? 'weak' : ''}">${barsHtml}</div>`;
  }

  // Render Full Network State
  function renderNetworkState(state) {
    if (!state) return;
    currentState = state;
    lastSeenTimestamp = state.last_seen;

    // 1. Header Helmet Online Status
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

    const net = state.network;
    if (!net) return;

    // 2. Network Summary Banner
    if (elements.networkHealthDisplay) {
      elements.networkHealthDisplay.textContent = `HEALTH: ${net.health}`;
      setStatusClass(elements.networkHealthDisplay, net.health);
    }
    if (elements.connectedTargetDisplay) {
      elements.connectedTargetDisplay.textContent = net.connected_node || 'NODE03';
    }
    if (elements.activeRouteDisplay && net.route && Array.isArray(net.route.current_route)) {
      elements.activeRouteDisplay.textContent = net.route.current_route.length > 0 ? net.route.current_route.join(' ──► ') : 'NO ROUTE';
    }

    // 3. Update Topology Nodes
    if (Array.isArray(net.nodes)) {
      net.nodes.forEach(node => {
        const nodeBox = document.getElementById(`node_${node.id}`);
        const statusPill = document.getElementById(`status_${node.id}`);

        if (statusPill) {
          statusPill.textContent = node.status;
          setStatusClass(statusPill, node.status);
        }

        if (nodeBox) {
          if (node.status === 'OFFLINE') {
            nodeBox.classList.add('node-offline');
          } else {
            nodeBox.classList.remove('node-offline');
          }
        }
      });
    }

    // 4. Update Topology Links
    // 4. Update Topology Links
    if (Array.isArray(net.links)) {
      net.links.forEach(link => {
        const linkEl = document.getElementById(link.id);
        const rssiEl = document.getElementById(`rssi_${link.id}`);
        const distEl = document.getElementById(`dist_${link.id}`);
        const qualEl = document.getElementById(`qual_${link.id}`);

        if (link.hide_metrics || link.id === 'link_node02_node01') {
          if (qualEl) {
            qualEl.textContent = link.status === 'DISCONNECTED' ? 'UPLINK OFFLINE' : 'UPLINK CONNECTED';
            setStatusClass(qualEl, link.status === 'DISCONNECTED' ? 'CRITICAL' : 'NORMAL');
          }
        } else {
          if (rssiEl) rssiEl.textContent = link.status === 'DISCONNECTED' ? 'OFFLINE' : (link.rssi != null ? `${link.rssi} dBm` : 'N/A');
          if (distEl) distEl.textContent = (link.status === 'DISCONNECTED' || link.distance == null || link.distance <= 0) ? '--' : `EST. ${link.distance} m`;
          if (qualEl) {
            qualEl.textContent = link.status === 'DISCONNECTED' ? 'DISCONNECTED' : link.quality;
            setStatusClass(qualEl, link.status === 'DISCONNECTED' ? 'CRITICAL' : link.quality);
          }
        }

        if (linkEl) {
          linkEl.classList.remove('link-weak', 'link-disconnected');
          if (link.status === 'DISCONNECTED') {
            linkEl.classList.add('link-disconnected');
          } else if (link.quality === 'WEAK' || link.quality === 'FAIR') {
            linkEl.classList.add('link-weak');
          }
        }
      });

      const knownLinkIds = new Set(net.links.map(l => l.id));
      document.querySelectorAll('.topology-link-connector').forEach(el => {
        if (el.id) el.style.display = knownLinkIds.has(el.id) ? '' : 'none';
      });

      // 5. Update Link Details Table
      if (elements.linkDetailsTableBody) {
        const rowsHtml = net.links.map(l => {
          const isDisc = l.status === 'DISCONNECTED' || l.available === false;
          let qualBadgeClass = 'status-normal';
          if (l.quality === 'WEAK' || l.quality === 'FAIR') qualBadgeClass = 'status-warning';
          if (isDisc) qualBadgeClass = 'status-critical';

          let statusBadgeClass = !isDisc ? 'status-normal' : 'status-critical';
          
          let distStr = '--';
          let rssiStr = 'TRUNK UPLINK';
          let sigBar = '<span style="color:var(--accent-primary); font-size:11px; font-weight:700;">DIRECT UPLINK</span>';

          if (!l.hide_metrics && l.id !== 'link_node02_node01') {
            distStr = (!isDisc && l.distance != null && l.distance > 0) ? `EST. ${l.distance} m` : '--';
            rssiStr = !isDisc ? (l.rssi != null ? `${l.rssi} dBm` : 'N/A') : 'N/A (Offline)';
            sigBar = !isDisc ? renderMiniSignalBar(l.quality, l.percentage) : '<span style="color:var(--text-muted); font-size:11px;">NO SIGNAL</span>';
          }

          return `
            <tr>
              <td style="font-weight: 700;">${l.source} ◄──► ${l.destination}</td>
              <td style="font-weight: 800;">${rssiStr}</td>
              <td>${sigBar}</td>
              <td>${distStr}</td>
              <td><span class="status-pill ${qualBadgeClass}">${isDisc ? 'OFFLINE' : (l.hide_metrics ? 'TRUNK' : l.quality)}</span></td>
              <td><span class="status-pill ${statusBadgeClass}">${isDisc ? 'DISCONNECTED' : 'CONNECTED'}</span></td>
            </tr>
          `;
        }).join('');

        elements.linkDetailsTableBody.innerHTML = rowsHtml;
      }

      if (elements.linkCountDisplay) {
        const activeCount = net.links.filter(l => l.status === 'CONNECTED').length;
        elements.linkCountDisplay.textContent = `${activeCount} / ${net.links.length} ACTIVE LINKS`;
      }
    }

    // 6. System Diagnostics Panel
    if (net.summary) {
      if (elements.diagNodesOnline) {
        elements.diagNodesOnline.textContent = `${net.summary.online_nodes_count} / ${net.summary.total_nodes_count} ONLINE`;
      }
      if (elements.diagHelmetStatus) {
        elements.diagHelmetStatus.textContent = net.summary.helmet_connected ? `CONNECTED VIA ${net.connected_node || 'NODE02'}` : 'DISCONNECTED';
      }
      if (elements.diagPropHealth) {
        elements.diagPropHealth.textContent = net.health === 'GOOD' ? 'OPTIMAL' : 'ATTENUATED / DEGRADED';
        setStatusClass(elements.diagPropHealth, net.health);
      }
      if (elements.diagPacketLoss) {
        elements.diagPacketLoss.textContent = net.health === 'GOOD' ? '0.0 % (NOMINAL)' : '4.2 % (ELEVATED)';
      }
      if (elements.diagStatusTag) {
        elements.diagStatusTag.textContent = net.health === 'GOOD' ? 'ALL SYSTEMS NOMINAL' : 'NETWORK DEGRADATION DETECTED';
        setStatusClass(elements.diagStatusTag, net.health);
      }
    }

    // 7. Alert Banners Container (Structural & Safety Alerts)
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

    // 8. Spatial Proximity Solver
    if (state.spatial_position) {
      const sp = state.spatial_position;
      if (elements.helmetSliderMarker) elements.helmetSliderMarker.style.left = `${sp.relative_slider_pct != null ? sp.relative_slider_pct : 50}%`;
      if (elements.distNode2) elements.distNode2.textContent = sp.dist_n2 != null && sp.dist_n2 >= 0 ? `${sp.dist_n2.toFixed(1)} m` : '-- m';
      if (elements.distNode3) elements.distNode3.textContent = sp.dist_n3 != null && sp.dist_n3 >= 0 ? `${sp.dist_n3.toFixed(1)} m` : '-- m';
      if (elements.fixedDistance) elements.fixedDistance.textContent = sp.fixed_dist != null && sp.fixed_dist >= 0 ? `${sp.fixed_dist.toFixed(1)} m` : '-- m';
      if (elements.lastKnownLocation) elements.lastKnownLocation.textContent = sp.nearest_node || 'NODE03';
    }

    // 9. Structural Health & Tunnel Shake Monitoring
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

    // 10. Casualty Assessment & Incident Rescue Dispatch Panel
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

    // 11. Distance Calibration Status (Phase 6)
    if (state.calibration) {
      const cal = state.calibration;

      if (elements.distLockBadge) {
        if (cal.status === 'RUNNING') {
          elements.distLockBadge.textContent = 'CALIBRATING…';
          setStatusClass(elements.distLockBadge, 'WARNING');
        } else if (cal.status === 'LOCKED') {
          elements.distLockBadge.textContent = 'DIST: LOCKED';
          setStatusClass(elements.distLockBadge, 'NORMAL');
        } else {
          elements.distLockBadge.textContent = 'DIST: LIVE';
          setStatusClass(elements.distLockBadge, 'WARNING');
        }
      }

      if (elements.calibStatusChip) {
        if (cal.status === 'RUNNING' && cal.progress) {
          elements.calibStatusChip.textContent = `CALIBRATING ${cal.progress.link} · ${cal.progress.remaining_s}s LEFT (${cal.progress.phase}/${cal.progress.total_phases})`;
          setStatusClass(elements.calibStatusChip, 'WARNING');
        } else if (cal.status === 'LOCKED') {
          const t = cal.locked_at ? new Date(cal.locked_at).toTimeString().split(' ')[0] : '--:--:--';
          const n = Object.keys(cal.locked || {}).length;
          elements.calibStatusChip.textContent = `DISTANCES LOCKED @ ${t} (${n} LINKS)`;
          setStatusClass(elements.calibStatusChip, 'NORMAL');
        } else {
          elements.calibStatusChip.textContent = 'UNCALIBRATED — LIVE RSSI ESTIMATES';
          setStatusClass(elements.calibStatusChip, 'WARNING');
        }
      }
    }
  }

  // Trigger Simulator Scenario
  async function triggerScenario(scenario) {
    try {
      currentScenario = scenario;
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
      } else if (btn.dataset.scenario !== 'RESET_NETWORK' && btn.dataset.scenario !== 'RESET') {
        btn.classList.remove('active');
      }
    });
  }

  // WebSocket Connection
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async function () {
      console.log('✓ Connected to MUKUT Network Telemetry Stream');
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
          renderNetworkState(message.payload);
          if (message.simulator && message.simulator.scenario) {
            updateScenarioButtonState(message.simulator.scenario);
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

  function init() {
    elements.scenarioButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const scenario = btn.dataset.scenario;
        if (scenario) triggerScenario(scenario);
      });
    });

    if (elements.btnCalibrate) {
      elements.btnCalibrate.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' })
          });
          if (!res.ok) {
            console.error('Calibration failed:', await res.text());
          }
        } catch (err) {
          console.error('Error starting calibration:', err);
        }
      });
    }

    relativeTimer = setInterval(updateLastSeenTick, 1000);

    fetch('/api/state')
      .then(res => res.json())
      .then(data => renderNetworkState(data))
      .catch(err => console.warn('Initial state fetch failed:', err));

    connectWebSocket();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
