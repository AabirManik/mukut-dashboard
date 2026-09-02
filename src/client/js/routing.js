/**
 * MUKUT Smart Coal Miner Helmet — Phase 3B Routing & Failover Visualization
 * Consumes Phase 3A routing engine telemetry via WebSocket and dynamically visualizes
 * active paths, node failures, failover rerouting, and path recovery.
 */

(function () {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let currentState = null;
  let previousObservedRouteStr = null;
  let currentScenario = 'NORMAL';
  let lastSeenTimestamp = null;
  let relativeTimer = null;
  let transitionTimer = null;

  // DOM Elements Cache
  const elements = {
    // Header & Status
    wsConnectionDisplay: document.getElementById('wsConnectionDisplay'),
    wsStateText: document.getElementById('wsStateText'),
    lastSeenValue: document.getElementById('lastSeenValue'),
    helmetOnlineBadge: document.getElementById('helmetOnlineBadge'),
    helmetIdDisplay: document.getElementById('helmetIdDisplay'),
    helmetStateDisplay: document.getElementById('helmetStateDisplay'),

    // Transition Alert
    routeTransitionBanner: document.getElementById('routeTransitionBanner'),
    routeTransitionText: document.getElementById('routeTransitionText'),

    // Route Hero Card
    routeHeroCard: document.getElementById('routeHeroCard'),
    routeStatusCodeDisplay: document.getElementById('routeStatusCodeDisplay'),
    routeStatusTitle: document.getElementById('routeStatusTitle'),
    routeStatusTag: document.getElementById('routeStatusTag'),
    currentRouteChain: document.getElementById('currentRouteChain'),
    previousRouteContainer: document.getElementById('previousRouteContainer'),
    previousRouteChain: document.getElementById('previousRouteChain'),
    failedNodeDisplay: document.getElementById('failedNodeDisplay'),
    failoverActiveDisplay: document.getElementById('failoverActiveDisplay'),
    routeImpactReason: document.getElementById('routeImpactReason'),

    // Bottom Table & Events
    activeHopsCountDisplay: document.getElementById('activeHopsCountDisplay'),
    routingTableBody: document.getElementById('routingTableBody'),
    routingEventList: document.getElementById('routingEventList'),
    routeEventStatusTag: document.getElementById('routeEventStatusTag'),

    // Simulator Toolbar
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
    } else if (status === 'WARNING' || status === 'FAILOVER' || status === 'DEGRADED' || status === 'FAIR' || status === 'WEAK') {
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

  // Check if a link connects two adjacent nodes in route
  function isLinkInRoute(link, route) {
    if (!route || !Array.isArray(route) || route.length < 2) return false;
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      if ((link.source === a && link.destination === b) || (link.source === b && link.destination === a)) {
        return true;
      }
    }
    return false;
  }

  // Trigger brief visual transition notification
  function showRouteTransitionAlert(message) {
    if (!elements.routeTransitionBanner) return;
    elements.routeTransitionText.textContent = message;
    elements.routeTransitionBanner.style.display = 'flex';
    elements.routeTransitionBanner.classList.add('flash-anim');

    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => {
      if (elements.routeTransitionBanner) {
        elements.routeTransitionBanner.style.display = 'none';
        elements.routeTransitionBanner.classList.remove('flash-anim');
      }
    }, 3200);
  }

  // Render Route Chain HTML
  function renderRouteNodesChain(routeArray, isPrevious = false) {
    if (!routeArray || routeArray.length === 0) {
      return `<div class="route-node-chip chip-disconnected">NO USABLE PATH</div>`;
    }

    return routeArray.map((nodeId, idx) => {
      let chipClass = 'route-node-chip';
      if (nodeId === 'HELMET01') chipClass += ' chip-helmet';
      else if (nodeId === 'GATEWAY') chipClass += ' chip-gateway';
      else chipClass += ' chip-relay';

      if (isPrevious) chipClass += ' chip-prev';

      const isLast = idx === routeArray.length - 1;
      const arrowHtml = isLast ? '' : `<span class="route-arrow ${isPrevious ? 'prev-arrow' : ''}">──►</span>`;

      return `<div class="${chipClass}">${nodeId}</div>${arrowHtml}`;
    }).join('');
  }

  // Render Full State to UI
  function renderRoutingState(state) {
    if (!state) return;
    currentState = state;
    lastSeenTimestamp = state.last_seen;

    // 1. Helmet Online Status Header
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
    const route = net.route || { current_route: [], previous_route: [], status: 'NORMAL', failover_active: false, failed_node: null };

    // 2. Detect Route Changes for Visual Flash Transition
    const currentRouteStr = (route.current_route || []).join('->');
    if (previousObservedRouteStr !== null && previousObservedRouteStr !== currentRouteStr) {
      if (route.status === 'FAILOVER') {
        showRouteTransitionAlert(`ROUTE RECALCULATING... FAILOVER ACTIVE VIA ALTERNATE LINK`);
      } else if (route.status === 'NORMAL') {
        showRouteTransitionAlert(`PRIMARY ROUTE RESTORED — NOMINAL TOPOLOGY ACTIVE`);
      } else if (route.status === 'NO_ROUTE') {
        showRouteTransitionAlert(`CRITICAL: COMMUNICATION PATH SEVERED — NO ROUTE AVAILABLE`);
      }
    }
    previousObservedRouteStr = currentRouteStr;

    // 3. Dominant Route Hero Card Status
    if (elements.routeHeroCard) {
      elements.routeHeroCard.classList.remove('status-normal', 'status-warning', 'status-critical');
      if (route.status === 'NORMAL') {
        elements.routeHeroCard.classList.add('status-normal');
      } else if (route.status === 'FAILOVER') {
        elements.routeHeroCard.classList.add('status-warning');
      } else {
        elements.routeHeroCard.classList.add('status-critical');
      }
    }

    if (elements.routeStatusCodeDisplay) {
      if (route.status === 'NORMAL') elements.routeStatusCodeDisplay.textContent = '[ STATUS: NORMAL / PRIMARY ROUTE ]';
      else if (route.status === 'FAILOVER') elements.routeStatusCodeDisplay.textContent = `[ STATUS: FAILOVER ACTIVE / ${route.failed_node || 'RELAY'} BYPASSED ]`;
      else elements.routeStatusCodeDisplay.textContent = '[ STATUS: CRITICAL / NO ROUTE ]';
    }

    if (elements.routeStatusTitle) {
      if (route.status === 'NORMAL') elements.routeStatusTitle.textContent = 'NORMAL';
      else if (route.status === 'FAILOVER') elements.routeStatusTitle.textContent = 'FAILOVER ACTIVE';
      else elements.routeStatusTitle.textContent = 'NO ROUTE';
    }

    if (elements.routeStatusTag) {
      if (route.status === 'NORMAL') {
        elements.routeStatusTag.textContent = 'PRIMARY ROUTE ACTIVE';
        setStatusClass(elements.routeStatusTag, 'NORMAL');
      } else if (route.status === 'FAILOVER') {
        elements.routeStatusTag.textContent = 'ALTERNATE BYPASS ENGAGED';
        setStatusClass(elements.routeStatusTag, 'WARNING');
      } else {
        elements.routeStatusTag.textContent = 'COMMUNICATION PATH UNAVAILABLE';
        setStatusClass(elements.routeStatusTag, 'CRITICAL');
      }
    }

    // 4. Current & Previous Route Chains
    if (elements.currentRouteChain) {
      elements.currentRouteChain.innerHTML = renderRouteNodesChain(route.current_route);
    }

    if (elements.previousRouteContainer && elements.previousRouteChain) {
      if (route.status === 'FAILOVER' && route.previous_route && route.previous_route.length > 0) {
        elements.previousRouteContainer.style.display = 'flex';
        elements.previousRouteChain.innerHTML = renderRouteNodesChain(route.previous_route, true);
      } else {
        elements.previousRouteContainer.style.display = 'none';
      }
    }

    // 5. Impact Strip
    if (elements.failedNodeDisplay) {
      if (route.failed_node) {
        elements.failedNodeDisplay.textContent = `${route.failed_node} (OFFLINE)`;
        elements.failedNodeDisplay.style.color = '#dc2626';
      } else {
        elements.failedNodeDisplay.textContent = 'NONE';
        elements.failedNodeDisplay.style.color = 'var(--text-primary)';
      }
    }

    if (elements.failoverActiveDisplay) {
      elements.failoverActiveDisplay.textContent = route.failover_active ? 'ACTIVE (1 BYPASS ACTIVE)' : 'INACTIVE (0 BYPASSES)';
      elements.failoverActiveDisplay.style.color = route.failover_active ? '#b45309' : 'var(--text-primary)';
    }

    if (elements.routeImpactReason) {
      if (route.status === 'NO_ROUTE') {
        elements.routeImpactReason.textContent = 'Critical isolation: No valid physical LoRa link to surface gateway.';
        elements.routeImpactReason.style.color = '#dc2626';
      } else if (route.status === 'FAILOVER') {
        elements.routeImpactReason.textContent = `Primary trunk through ${route.failed_node || 'relay'} offline — Auto-rerouted via Shaft Relay 01.`;
        elements.routeImpactReason.style.color = '#92400e';
      } else {
        elements.routeImpactReason.textContent = 'Optimal multi-hop path nominal across all relay stations.';
        elements.routeImpactReason.style.color = '#166534';
      }
    }

    // 6. Mesh Graph Nodes Rendering
    if (Array.isArray(net.nodes)) {
      net.nodes.forEach(node => {
        const nodeEl = document.getElementById(`graphNode_${node.id}`);
        const statusEl = document.getElementById(`graphStatus_${node.id}`);
        const memberEl = document.getElementById(`member_${node.id}`);

        if (statusEl) {
          statusEl.textContent = node.status;
          setStatusClass(statusEl, node.status);
        }

        const isInCurrentRoute = (route.current_route || []).includes(node.id);

        if (nodeEl) {
          nodeEl.classList.remove('node-offline', 'node-in-route', 'node-bypassed');
          if (node.status === 'OFFLINE') {
            nodeEl.classList.add('node-offline');
          } else if (isInCurrentRoute) {
            nodeEl.classList.add('node-in-route');
          } else {
            nodeEl.classList.add('node-bypassed');
          }
        }

        if (memberEl) {
          memberEl.classList.remove('in-route', 'bypassed', 'offline');
          if (node.status === 'OFFLINE') {
            memberEl.textContent = 'OFFLINE / FAILED';
            memberEl.classList.add('offline');
          } else if (isInCurrentRoute) {
            memberEl.textContent = node.id === 'HELMET01' ? 'SOURCE NODE' : (node.id === 'NODE01' ? 'TARGET ROOT' : 'IN ACTIVE ROUTE');
            memberEl.classList.add('in-route');
          } else {
            memberEl.textContent = 'STANDBY / BYPASSED';
            memberEl.classList.add('bypassed');
          }
        }
      });
    }

    // 7. Mesh Graph Links Rendering
    if (Array.isArray(net.links)) {
      net.links.forEach(link => {
        const linkEl = document.getElementById(`graphLink_${link.id}`);
        const metricsEl = document.getElementById(`metrics_${link.id}`);
        const roleEl = document.getElementById(`role_${link.id}`);

        const inActiveRoute = isLinkInRoute(link, route.current_route);
        const isDisconnected = link.status === 'DISCONNECTED' || link.available === false;

        if (metricsEl) {
          metricsEl.textContent = `${link.rssi} dBm | EST. ${link.distance} m`;
        }

        if (linkEl) {
          linkEl.classList.remove('link-active', 'link-standby', 'link-disconnected', 'link-weak');
          if (isDisconnected) {
            linkEl.classList.add('link-disconnected');
          } else if (inActiveRoute) {
            linkEl.classList.add('link-active');
            if (link.quality === 'WEAK' || link.quality === 'FAIR') {
              linkEl.classList.add('link-weak');
            }
          } else {
            linkEl.classList.add('link-standby');
          }
        }

        if (roleEl) {
          if (isDisconnected) {
            roleEl.textContent = 'SEVERED';
            roleEl.style.color = '#dc2626';
          } else if (inActiveRoute) {
            roleEl.textContent = link.id === 'link_node03_node01' ? 'ACTIVE FAILOVER BYPASS' : 'ACTIVE ROUTE';
            roleEl.style.color = '#0f172a';
          } else {
            roleEl.textContent = link.id === 'link_node03_node01' ? 'STANDBY BYPASS' : 'STANDBY LINK';
            roleEl.style.color = '#64748b';
          }
        }
      });

      // 8. Lower Link Breakdown Table
      if (elements.routingTableBody) {
        const rowsHtml = net.links.map(l => {
          const inRoute = isLinkInRoute(l, route.current_route);
          const isDisc = l.status === 'DISCONNECTED' || l.available === false;

          let roleTagClass = 'status-normal';
          let roleTagText = 'ACTIVE ROUTE';

          if (isDisc) {
            roleTagClass = 'status-critical';
            roleTagText = 'SEVERED';
          } else if (inRoute) {
            roleTagClass = l.id === 'link_node03_node01' ? 'status-warning' : 'status-normal';
            roleTagText = l.id === 'link_node03_node01' ? 'ACTIVE BYPASS' : 'ACTIVE ROUTE';
          } else {
            roleTagClass = 'status-pill';
            roleTagText = 'STANDBY';
          }

          let qualBadgeClass = 'status-normal';
          if (l.quality === 'WEAK' || l.quality === 'FAIR') qualBadgeClass = 'status-warning';
          if (isDisc) qualBadgeClass = 'status-critical';

          return `
            <tr>
              <td style="font-weight: 700; ${inRoute ? 'color: #0f172a;' : 'color: #64748b;'}">${l.source} ◄──► ${l.destination}</td>
              <td style="font-weight: 800;">${l.rssi} dBm</td>
              <td>${renderMiniSignalBar(l.quality, l.percentage)}</td>
              <td>EST. ${l.distance} m</td>
              <td><span class="status-pill ${qualBadgeClass}">${isDisc ? 'OFFLINE' : l.quality}</span></td>
              <td><span class="status-pill ${roleTagClass}">${roleTagText}</span></td>
            </tr>
          `;
        }).join('');

        elements.routingTableBody.innerHTML = rowsHtml;
      }

      if (elements.activeHopsCountDisplay) {
        const hopCount = Math.max(0, (route.current_route || []).length - 1);
        const nodeCount = (route.current_route || []).length;
        if (route.status === 'NO_ROUTE') {
          elements.activeHopsCountDisplay.textContent = '0 HOPS (DISCONNECTED)';
        } else {
          elements.activeHopsCountDisplay.textContent = `${hopCount} HOPS (${nodeCount} NODES)`;
        }
      }
    }

    // 9. Routing Events Timeline Rendering
    if (elements.routingEventList && Array.isArray(state.events)) {
      if (state.events.length === 0) {
        elements.routingEventList.innerHTML = `<div class="empty-state">Awaiting routing telemetry...</div>`;
      } else {
        const eventsHtml = state.events.slice(0, 10).map(evt => {
          let tagClass = 'tag-info';
          if (evt.severity === 'WARNING') tagClass = 'tag-warning';
          if (evt.severity === 'EMERGENCY') tagClass = 'tag-emergency';

          return `
            <div class="routing-event-item">
              <div class="event-meta-line">
                <span class="event-time">${evt.timeStr || ''}</span>
                <span class="event-severity-tag ${tagClass}">${evt.severity}</span>
              </div>
              <div class="event-msg">${evt.message}</div>
            </div>
          `;
        }).join('');

        elements.routingEventList.innerHTML = eventsHtml;
      }
    }
  }

  // Trigger Simulator Scenario via REST API
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

  // WebSocket Connection Management
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async function () {
      console.log('✓ Connected to MUKUT Routing Engine WS');
      if (elements.wsConnectionDisplay && elements.wsStateText) {
        elements.wsConnectionDisplay.classList.remove('status-critical');
        elements.wsConnectionDisplay.classList.add('status-normal');
        elements.wsStateText.textContent = 'LIVE WS: CONNECTED';
      }
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
        if (message.type === 'INIT_STATE' || message.type === 'STATE_UPDATE' || message.type === 'ROUTE_CHANGED') {
          // If message is ROUTE_CHANGED or STATE_UPDATE, payload may be full state or route event
          if (message.type === 'ROUTE_CHANGED') {
            // Re-fetch or sync state
            fetch('/api/state')
              .then(res => res.json())
              .then(data => renderRoutingState(data))
              .catch(err => console.warn('Sync failed:', err));
          } else {
            renderRoutingState(message.payload);
          }

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
      if (elements.wsConnectionDisplay && elements.wsStateText) {
        elements.wsConnectionDisplay.classList.remove('status-normal');
        elements.wsConnectionDisplay.classList.add('status-critical');
        elements.wsStateText.textContent = 'LIVE WS: DISCONNECTED';
      }
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

    // Initial REST Fetch
    fetch('/api/state')
      .then(res => res.json())
      .then(data => renderRoutingState(data))
      .catch(err => console.warn('Initial state fetch failed:', err));

    connectWebSocket();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
