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


  // ─── Tunnel Map State ───────────────────────────────────────────
  const tunnelMap = {
    canvas: null,
    ctx: null,
    // Physical position in metres from NODE02 along tunnel axis:
    //   negative = between N1 and N2
    //   0        = at NODE02
    //   positive = between N2 and N3
    //   > fixed  = past NODE03 (deeper)
    physPos:       0,
    targetPhysPos: 0,
    animFrame: null,
    nodeStates: { NODE01: 'ONLINE', NODE02: 'ONLINE', NODE03: 'ONLINE', HELMET01: 'ONLINE' },
    links: {}        // keyed by "A|B" (sorted) → distance in metres
  };

  // DOM Elements Cache
  const elements = {
    // Header & Status
    wsConnectionDisplay: document.getElementById('wsConnectionDisplay'),
    wsStateText: document.getElementById('wsStateText'),
    lastSeenValue: document.getElementById('lastSeenValue'),
    helmetOnlineBadge: document.getElementById('helmetOnlineBadge'),
    helmetIdDisplay: document.getElementById('helmetIdDisplay'),
    helmetStateDisplay: document.getElementById('helmetStateDisplay'),

    tunnelMapStatus: document.getElementById('tunnelMapStatus'),

    distLockBadge: document.getElementById('distLockBadge'),

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
    updateTunnelMap(state);   // ← live tunnel map update

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
        const detour = (route.current_route || []).filter(n => n !== 'HELMET01' && n !== 'NODE01');
        elements.routeImpactReason.textContent = `Primary trunk through ${route.failed_node || 'relay'} offline — Auto-rerouted via ${detour.length > 0 ? detour.join(' + ') : 'direct uplink'}.`;
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
          if (isDisconnected) {
            metricsEl.textContent = 'SEVERED — NO SIGNAL';
          } else if (link.rssi == null && link.distance == null) {
            metricsEl.textContent = 'TRUNK UPLINK — NO METRICS';
          } else {
            metricsEl.textContent = `${link.rssi != null ? `${link.rssi} dBm` : 'N/A'} | ${link.distance != null ? `EST. ${link.distance} m` : '--'}`;
          }
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

          const rssiStr = isDisc ? 'N/A (Offline)' : (l.rssi != null ? `${l.rssi} dBm` : 'TRUNK UPLINK');
          const distStr = (!isDisc && l.distance != null && l.distance > 0) ? `EST. ${l.distance} m` : '--';

          return `
            <tr>
              <td style="font-weight: 700; ${inRoute ? 'color: #0f172a;' : 'color: #64748b;'}">${l.source} ◄──► ${l.destination}</td>
              <td style="font-weight: 800;">${rssiStr}</td>
              <td>${renderMiniSignalBar(l.quality, l.percentage)}</td>
              <td>${distStr}</td>
              <td><span class="status-pill ${qualBadgeClass}">${isDisc ? 'OFFLINE' : (l.hide_metrics ? 'TRUNK' : l.quality)}</span></td>
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

  // ═══════════════════════════════════════════════════════════════
  //  2-D TUNNEL MAP  —  canvas renderer
  // ═══════════════════════════════════════════════════════════════
  function initTunnelMap() {
    tunnelMap.canvas = document.getElementById('tunnelMapCanvas');
    if (!tunnelMap.canvas) return;
    tunnelMap.ctx = tunnelMap.canvas.getContext('2d');
    resizeTunnelCanvas();
    window.addEventListener('resize', resizeTunnelCanvas);
    animateTunnelMap();
  }

  function resizeTunnelCanvas() {
    const c = tunnelMap.canvas;
    if (!c) return;
    c.width  = c.offsetWidth  * window.devicePixelRatio;
    c.height = c.offsetHeight * window.devicePixelRatio;
    tunnelMap.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  // Called every WebSocket state update
  function updateTunnelMap(state) {
    if (!state) return;

    // Node online states
    if (state.network && state.network.nodes) {
      state.network.nodes.forEach(n => {
        tunnelMap.nodeStates[n.id] = n.status;
      });
    }
    tunnelMap.nodeStates['HELMET01'] = state.online ? 'ONLINE' : 'OFFLINE';

    // ── Collect distances into a fresh links map (prunes stale entries) ──
    // Live link distances win; spatial solver values only fill in / override
    // when actually valid (Node1 hardware provides them).
    const fresh = {};
    if (state.network && state.network.links) {
      state.network.links.forEach(l => {
        const key = [l.source, l.destination].sort().join('|');
        if (l.distance != null) fresh[key] = l.distance;
      });
    }
    if (state.spatial_position) {
      const sp = state.spatial_position;
      if (sp.dist_n2 != null && sp.dist_n2 >= 0) fresh['HELMET01|NODE02'] = sp.dist_n2;
      if (sp.dist_n3 != null && sp.dist_n3 >= 0) fresh['HELMET01|NODE03'] = sp.dist_n3;
      if (sp.fixed_dist != null && sp.fixed_dist > 0 && fresh['NODE02|NODE03'] == null) {
        fresh['NODE02|NODE03'] = sp.fixed_dist;
      }
    }
    tunnelMap.links = fresh;

    // ── 1-D trilateration: compute physical position from N2 & N3 ──────────
    //  posFromN2 = (d2² - d3² + fd²) / (2 × fd)
    //  + = toward / past N3 ; − = toward / past N1 (surface)
    const d2 = tunnelMap.links['HELMET01|NODE02'];
    const d3 = tunnelMap.links['HELMET01|NODE03'];
    const fd = tunnelMap.links['NODE02|NODE03'] || 5;
    if (d2 != null && d3 != null) {
      tunnelMap.targetPhysPos = (d2 * d2 - d3 * d3 + fd * fd) / (2 * fd);
    } else if (d3 != null) {
      // Only the N3 distance known: miner stays on the working-face side
      //  d3 ≤ fd → between N2 and N3 ; d3 > fd → deeper than N3
      tunnelMap.targetPhysPos = d3 <= fd ? (fd - d3) : (fd + d3);
    } else if (d2 != null) {
      tunnelMap.targetPhysPos = d2;
    }

    // ── Dynamic map status tag ───────────────────────────────────────────
    if (elements.tunnelMapStatus) {
      elements.tunnelMapStatus.classList.remove('status-normal', 'status-warning', 'status-critical');
      if (tunnelMap.nodeStates['HELMET01'] === 'OFFLINE') {
        elements.tunnelMapStatus.textContent = '[ TRACKING LOST — MINER OFFLINE ]';
        elements.tunnelMapStatus.classList.add('status-critical');
      } else if (['NODE01', 'NODE02', 'NODE03'].some(id => tunnelMap.nodeStates[id] === 'OFFLINE')) {
        elements.tunnelMapStatus.textContent = '[ PARTIAL TRACKING — RELAY OFFLINE ]';
        elements.tunnelMapStatus.classList.add('status-warning');
      } else {
        elements.tunnelMapStatus.textContent = '[ TRACKING ACTIVE ]';
        elements.tunnelMapStatus.classList.add('status-normal');
      }
    }
  }

  // Smooth animation loop — eases physical position in metres
  function animateTunnelMap() {
    const diff = tunnelMap.targetPhysPos - tunnelMap.physPos;
    if (Math.abs(diff) > 0.01) {
      tunnelMap.physPos += diff * 0.08;
    } else {
      tunnelMap.physPos = tunnelMap.targetPhysPos;
    }
    drawTunnelMap();
    tunnelMap.animFrame = requestAnimationFrame(animateTunnelMap);
  }

  function drawTunnelMap() {
    const c = tunnelMap.canvas;
    const ctx = tunnelMap.ctx;
    if (!c || !ctx) return;

    const W = c.offsetWidth;
    const H = c.offsetHeight;
    ctx.clearRect(0, 0, W, H);

    // ── Background gradient ──────────────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, W, 0);
    bg.addColorStop(0,   '#0a1a0e');
    bg.addColorStop(0.5, '#060d14');
    bg.addColorStop(1,   '#0f0a0a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Tunnel walls ────────────────────────────────────────────
    const tunnelY1 = H * 0.28;
    const tunnelY2 = H * 0.72;
    const wallGrad = ctx.createLinearGradient(0, tunnelY1, 0, tunnelY2);
    wallGrad.addColorStop(0,   'rgba(60,120,80,0.18)');
    wallGrad.addColorStop(0.5, 'rgba(20,40,30,0.08)');
    wallGrad.addColorStop(1,   'rgba(60,120,80,0.18)');
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, tunnelY1, W, tunnelY2 - tunnelY1);

    // Top & bottom wall lines
    ctx.strokeStyle = 'rgba(80,160,100,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, tunnelY1); ctx.lineTo(W, tunnelY1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, tunnelY2); ctx.lineTo(W, tunnelY2); ctx.stroke();

    // ── Node layout: NODE01=left … NODE03=right, then helmet ────
    // Fixed screen positions for nodes (as fraction of W)
    const nodeX = {
      NODE01: W * 0.10,
      NODE02: W * 0.38,
      NODE03: W * 0.66,
    };
    const midY = H * 0.5;

    // ══ Helmet position via 1-D trilateration ═════════════════════════════
    //
    //  posFromN2 = (d2² − d3² + fd²) / (2 × fd)   [metres from NODE02]
    //
    //  posFromN2 < 0             → miner is between N1 and N2 (toward surface)
    //  0 ≤ posFromN2 ≤ fixedDist → miner is between N2 and N3
    //  posFromN2 > fixedDist     → miner is deeper than N3
    //
    //  Screen mapping: one metre = (nodeX.NODE03 - nodeX.NODE02) / fixedDist  px
    //  So: helmetX = nodeX.NODE02 + posFromN2 × px_per_m
    //
    const distN2    = tunnelMap.links['HELMET01|NODE02'];
    const distN3    = tunnelMap.links['HELMET01|NODE03'];
    const fixedDist = tunnelMap.links['NODE02|NODE03']   || 5;

    const posFromN2    = tunnelMap.physPos;          // smoothed physical pos (metres)
    const pxPerMetre   = (nodeX.NODE03 - nodeX.NODE02) / fixedDist;

    // Raw pixel position: 0 = NODE02, fixedDist = NODE03, negative = N1-side
    let helmetX = nodeX.NODE02 + posFromN2 * pxPerMetre;

    // Hard clamp: never go past NODE01 left edge or canvas right edge
    helmetX = Math.max(nodeX.NODE01 + 28, Math.min(W - 30, helmetX));

    // Anchor node: whichever fixed node the cable connects to
    // posFromN2 < 0 means miner is on the N1 side of N2 → cable attaches to N2
    // posFromN2 >= 0 means miner is on the N3 side of N2 → cable attaches to N3
    const anchorId = posFromN2 < 0 ? 'NODE02' : 'NODE03';

    // ── Tunnel floor dashes (atmosphere) ────────────────────────
    ctx.setLineDash([6, 14]);
    ctx.strokeStyle = 'rgba(80,200,120,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();
    ctx.setLineDash([]);

    // ── Draw trunk cable between nodes ──────────────────────────
    const pairs = [
      ['NODE01', 'NODE02'],
      ['NODE02', 'NODE03']
    ];

    pairs.forEach(([a, b]) => {
      const x1 = nodeX[a], x2 = nodeX[b];
      const n1online = tunnelMap.nodeStates[a] === 'ONLINE';
      const n2online = tunnelMap.nodeStates[b] === 'ONLINE';
      const active = n1online && n2online;
      const key = [a, b].sort().join('|');
      const dist = tunnelMap.links[key];

      // Cable line
      const cableGrad = ctx.createLinearGradient(x1, 0, x2, 0);
      if (active) {
        cableGrad.addColorStop(0, 'rgba(34,197,94,0.55)');
        cableGrad.addColorStop(1, 'rgba(34,197,94,0.25)');
      } else {
        cableGrad.addColorStop(0, 'rgba(239,68,68,0.4)');
        cableGrad.addColorStop(1, 'rgba(239,68,68,0.2)');
      }
      ctx.setLineDash(active ? [] : [6, 6]);
      ctx.strokeStyle = cableGrad;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x1, midY); ctx.lineTo(x2, midY); ctx.stroke();
      ctx.setLineDash([]);

      // Distance label above cable midpoint
      {
        const mx = (x1 + x2) / 2;
        ctx.font = '500 10px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = active ? 'rgba(134,239,172,0.8)' : 'rgba(252,165,165,0.7)';
        ctx.fillText(dist != null ? `EST. ${Number(dist).toFixed(1)} m` : 'TRUNK LINK', mx, midY - 14);
      }
    });

    // ── Cable from nearest relay node to helmet ──────────────────
    const helmetOnline  = tunnelMap.nodeStates['HELMET01'] === 'ONLINE';
    const anchorOnline  = tunnelMap.nodeStates[anchorId] === 'ONLINE';
    const helmetLinkActive = helmetOnline && anchorOnline;
    const anchorX       = nodeX[anchorId];

    ctx.setLineDash(helmetLinkActive ? [] : [5, 7]);
    ctx.strokeStyle = helmetLinkActive ? 'rgba(56,189,248,0.5)' : 'rgba(239,68,68,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(anchorX, midY); ctx.lineTo(helmetX, midY); ctx.stroke();
    ctx.setLineDash([]);

    // Distance label for helmet ↔ anchor node
    const anchorDistKey = ['HELMET01', anchorId].sort().join('|');
    const anchorDist    = tunnelMap.links[anchorDistKey];
    if (anchorDist != null) {
      const mx = (anchorX + helmetX) / 2;
      ctx.font = '500 10px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = helmetLinkActive ? 'rgba(125,211,252,0.85)' : 'rgba(252,165,165,0.7)';
      ctx.fillText(`EST. ${Number(anchorDist).toFixed(1)} m`, mx, midY - 14);
    }

    // ── Draw fixed nodes ────────────────────────────────────────
    const nodeLabels = { NODE01: 'NODE 01\nSURFACE', NODE02: 'NODE 02\nMID-TUNNEL', NODE03: 'NODE 03\nDEEP RELAY' };
    const nodeColors = {
      ONLINE:  { fill: '#14532d', stroke: '#22c55e', text: '#4ade80' },
      OFFLINE: { fill: '#450a0a', stroke: '#ef4444', text: '#fca5a5' }
    };

    Object.entries(nodeX).forEach(([id, x]) => {
      const st = tunnelMap.nodeStates[id] || 'ONLINE';
      const col = nodeColors[st] || nodeColors.ONLINE;
      const r = 20;

      // Glow
      const glow = ctx.createRadialGradient(x, midY, 0, x, midY, r * 2.5);
      glow.addColorStop(0, st === 'ONLINE' ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, midY, r * 2.5, 0, Math.PI * 2); ctx.fill();

      // Circle
      ctx.beginPath(); ctx.arc(x, midY, r, 0, Math.PI * 2);
      ctx.fillStyle = col.fill;
      ctx.fill();
      ctx.strokeStyle = col.stroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Node ID inside
      ctx.font = 'bold 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = col.text;
      ctx.fillText(id.replace('NODE', 'N'), x, midY + 3);

      // Label below
      const lines = (nodeLabels[id] || id).split('\n');
      ctx.font = '500 9px Inter, sans-serif';
      ctx.fillStyle = 'rgba(200,220,210,0.7)';
      lines.forEach((ln, i) => ctx.fillText(ln, x, midY + r + 14 + i * 12));

      // Status pill above
      ctx.font = '600 8px JetBrains Mono, monospace';
      ctx.fillStyle = st === 'ONLINE' ? 'rgba(74,222,128,0.9)' : 'rgba(248,113,113,0.9)';
      ctx.fillText(st, x, midY - r - 7);
    });

    // ── Draw helmet marker ──────────────────────────────────────
    const hCol = helmetOnline ? { stroke: '#38bdf8', fill: '#0c4a6e', glow: 'rgba(56,189,248,0.25)', text: '#7dd3fc' }
                              : { stroke: '#ef4444', fill: '#450a0a', glow: 'rgba(239,68,68,0.2)',   text: '#fca5a5' };
    const hr = 15;
    const pulse = 1 + 0.06 * Math.sin(Date.now() / 400);  // subtle pulse

    // Glow
    const hGlow = ctx.createRadialGradient(helmetX, midY, 0, helmetX, midY, hr * 3 * pulse);
    hGlow.addColorStop(0, hCol.glow);
    hGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hGlow;
    ctx.beginPath(); ctx.arc(helmetX, midY, hr * 3 * pulse, 0, Math.PI * 2); ctx.fill();

    // Helmet circle (diamond shape for distinction)
    ctx.save();
    ctx.translate(helmetX, midY);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath(); ctx.rect(-hr * 0.8, -hr * 0.8, hr * 1.6, hr * 1.6);
    ctx.fillStyle = hCol.fill; ctx.fill();
    ctx.strokeStyle = hCol.stroke; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();

    // Helmet icon text
    ctx.font = '11px serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = hCol.text;
    ctx.fillText('⛑', helmetX, midY + 4);

    // MINER label above
    ctx.font = 'bold 9px JetBrains Mono, monospace';
    ctx.fillStyle = hCol.text;
    ctx.fillText('MINER 01', helmetX, midY - hr - 8);
    ctx.font = '600 8px JetBrains Mono, monospace';
    ctx.fillStyle = helmetOnline ? 'rgba(56,189,248,0.85)' : 'rgba(248,113,113,0.85)';
    ctx.fillText(helmetOnline ? 'ONLINE' : 'OFFLINE', helmetX, midY - hr - 18);

    // Real distance label below helmet
    ctx.font = '500 9px Inter, sans-serif';
    ctx.fillStyle = 'rgba(148,163,184,0.6)';
    const distParts = [];
    if (distN2 != null) distParts.push(`${distN2.toFixed(1)} m from N2`);
    if (distN3 != null) distParts.push(`${distN3.toFixed(1)} m from N3`);
    let labelDist = distParts.length > 0 ? distParts.join(' · ') : 'DISTANCE UNKNOWN';
    if (posFromN2 < 0) labelDist += ' (surface-side)';
    else if (posFromN2 > fixedDist) labelDist += ' (deeper)';
    ctx.fillText(labelDist, helmetX, midY + hr + 14);

    // ── Metre ruler along the N2–N3 span ───────────────────────
    const rulerY = tunnelY2 + 18;
    const stepOptions = [1, 2, 5, 10, 20, 50];
    const rulerStep = stepOptions.find(s => fixedDist / s <= 7) || 50;
    ctx.strokeStyle = 'rgba(80,160,100,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(nodeX.NODE02, rulerY);
    ctx.lineTo(nodeX.NODE03, rulerY);
    ctx.stroke();
    for (let m = 0; m <= fixedDist; m += rulerStep) {
      const x = nodeX.NODE02 + m * pxPerMetre;
      ctx.beginPath();
      ctx.moveTo(x, rulerY);
      ctx.lineTo(x, rulerY + 5);
      ctx.stroke();
      ctx.font = '500 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(148,163,184,0.55)';
      ctx.fillText(`${m} m`, x, rulerY + 15);
    }

    // ── Zone captions ───────────────────────────────────────────
    ctx.font = '600 9px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(134,239,172,0.55)';
    ctx.fillText('◄ SURFACE SHAFT', 12, 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.fillText('DEEP TUNNEL ►', W - 12, H - 12);

    // ── Legend at top-right ──────────────────────────────────────
    const lx = W - 12, ly = 12;
    ctx.textAlign = 'right';
    ctx.font = '500 9px Inter, sans-serif';
    [
      { col: '#22c55e', label: 'Online / Connected' },
      { col: '#ef4444', label: 'Offline / Disconnected' },
      { col: '#38bdf8', label: 'Miner (Helmet)' }
    ].forEach((item, i) => {
      ctx.fillStyle = item.col;
      ctx.fillRect(lx - 6, ly + i * 14, 6, 6);
      ctx.fillStyle = 'rgba(148,163,184,0.7)';
      ctx.fillText(item.label, lx - 10, ly + i * 14 + 6);
    });
  }

  function init() {
    elements.scenarioButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const scenario = btn.dataset.scenario;
        if (scenario) triggerScenario(scenario);
      });
    });

    relativeTimer = setInterval(updateLastSeenTick, 1000);

    initTunnelMap();   // ← start tunnel map canvas

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
