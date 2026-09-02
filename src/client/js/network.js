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
    if (Array.isArray(net.links)) {
      net.links.forEach(link => {
        const linkEl = document.getElementById(link.id);
        const rssiEl = document.getElementById(`rssi_${link.id}`);
        const distEl = document.getElementById(`dist_${link.id}`);
        const qualEl = document.getElementById(`qual_${link.id}`);

        if (rssiEl) rssiEl.textContent = `${link.rssi} dBm`;
        if (distEl) distEl.textContent = `EST. ${link.distance} m`;
        if (qualEl) {
          qualEl.textContent = link.status === 'DISCONNECTED' ? 'DISCONNECTED' : link.quality;
          setStatusClass(qualEl, link.status === 'DISCONNECTED' ? 'CRITICAL' : link.quality);
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

      // 5. Update Link Details Table
      if (elements.linkDetailsTableBody) {
        const rowsHtml = net.links.map(l => {
          let qualBadgeClass = 'status-normal';
          if (l.quality === 'WEAK' || l.quality === 'FAIR') qualBadgeClass = 'status-warning';
          if (l.status === 'DISCONNECTED') qualBadgeClass = 'status-critical';

          let statusBadgeClass = l.status === 'CONNECTED' ? 'status-normal' : 'status-critical';

          return `
            <tr>
              <td style="font-weight: 700;">${l.source} ◄──► ${l.destination}</td>
              <td style="font-weight: 800;">${l.rssi} dBm</td>
              <td>${renderMiniSignalBar(l.quality, l.percentage)}</td>
              <td>EST. ${l.distance} m</td>
              <td><span class="status-pill ${qualBadgeClass}">${l.status === 'DISCONNECTED' ? 'OFFLINE' : l.quality}</span></td>
              <td><span class="status-pill ${statusBadgeClass}">${l.status}</span></td>
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
            dsValue.textContent = cfg.hardware.data_source === 'hardware' ? 'LIVE HARDWARE' : 'SIMULATOR';
            dsValue.style.color = cfg.hardware.data_source === 'hardware' ? '#10b981' : '#f59e0b';
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
