/**
 * MUKUT Smart Coal Miner Helmet — Phase 5 Route Mapping Client
 * Calm light-themed, interactive 2D trajectory map:
 * stable fit-to-tunnel viewport (no refit jitter), drag-pan, wheel-zoom,
 * FIT VIEW / FOLLOW MINER controls, breadcrumb path + relay beacons.
 */

(function () {
  'use strict';

  let ws = null;
  let reconnectTimer = null;
  let currentState = null;
  let lastSeenTimestamp = null;
  let relativeTimer = null;

  const canvasState = {
    canvas: null,
    ctx: null,
    animFrame: null,
    ro: null
  };

  // Map viewport (metres + px-per-metre). Default = fit the tunnel extent once;
  // the corridor clamp guarantees the trajectory stays within it, so there is
  // no per-waypoint refit (that was the source of the jittery view).
  const view = {
    cx: 52,
    cy: 26,
    scale: 1,
    fitScale: 1,
    fitted: false,
    userMoved: false,
    follow: false
  };

  const ANCHOR_ROLES = {
    NODE01: 'SURFACE GATEWAY',
    NODE02: 'MID-TUNNEL RELAY',
    NODE03: 'WORKING FACE RELAY'
  };

  // DOM Elements Cache
  const elements = {
    wsConnectionDisplay: document.getElementById('wsConnectionDisplay'),
    wsStateText: document.getElementById('wsStateText'),
    lastSeenValue: document.getElementById('lastSeenValue'),
    helmetOnlineBadge: document.getElementById('helmetOnlineBadge'),
    helmetIdDisplay: document.getElementById('helmetIdDisplay'),
    helmetStateDisplay: document.getElementById('helmetStateDisplay'),

    distLockBadge: document.getElementById('distLockBadge'),

    journeyStatusCode: document.getElementById('journeyStatusCode'),
    journeyStateTitle: document.getElementById('journeyStateTitle'),
    journeyStateTag: document.getElementById('journeyStateTag'),
    routeMapHeroCard: document.getElementById('routeMapHeroCard'),

    distSurfaceVal: document.getElementById('distSurfaceVal'),
    distWalkedVal: document.getElementById('distWalkedVal'),
    speedVal: document.getElementById('speedVal'),
    movingVal: document.getElementById('movingVal'),

    routeMapCanvasStatus: document.getElementById('routeMapCanvasStatus'),
    waypointCountDisplay: document.getElementById('waypointCountDisplay'),
    anchorTableBody: document.getElementById('anchorTableBody'),
    routeMapEventList: document.getElementById('routeMapEventList'),

    btnFitView: document.getElementById('btnFitView'),
    btnFollowMiner: document.getElementById('btnFollowMiner'),
    btnToggleTracking: document.getElementById('btnToggleTracking'),
    btnSetHeading: document.getElementById('btnSetHeading'),
    btnRangeCal1: document.getElementById('btnRangeCal1'),
    btnRangeCal3: document.getElementById('btnRangeCal3'),
    btnCalibrateMap: document.getElementById('btnCalibrateMap'),
    btnClearMapCal: document.getElementById('btnClearMapCal'),
    zoomTag: document.getElementById('zoomTag'),

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

  // Simulator Scenario Trigger
  async function triggerScenario(scenario) {
    try {
      updateScenarioButtonState(scenario);

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

  // Render Full State to UI
  function renderState(state) {
    if (!state) return;
    currentState = state;
    lastSeenTimestamp = state.last_seen;

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

    const rm = state.route_map;
    if (!rm) return;

    // v6: tracking session — button + hero reflect the START/STOP TRACKING
    // state (default active for backward compatibility).
    const sessionActive = !rm.session || rm.session.active;
    if (elements.btnToggleTracking) {
      elements.btnToggleTracking.textContent = sessionActive ? 'STOP TRACKING' : 'START TRACKING';
      elements.btnToggleTracking.classList.toggle('active', sessionActive);
    }

    // 1. Journey Readouts
    if (elements.distSurfaceVal) {
      elements.distSurfaceVal.textContent = rm.distance_from_surface_m != null ? `${rm.distance_from_surface_m.toFixed(1)} m` : '-- m';
    }
    if (elements.distWalkedVal) {
      elements.distWalkedVal.textContent = rm.distance_walked_m != null ? `${rm.distance_walked_m.toFixed(1)} m` : '-- m';
    }
    if (elements.speedVal) {
      elements.speedVal.textContent = rm.speed_mps != null ? `${rm.speed_mps.toFixed(2)} m/s` : '-- m/s';
    }
    if (elements.movingVal) {
      elements.movingVal.textContent = rm.moving ? 'MOVING — TRAJECTORY GROWING' : 'STATIONARY';
      elements.movingVal.style.color = rm.moving ? '#b45309' : 'var(--text-primary)';
    }

    // 2. Hero Card
    const atSurface = rm.distance_from_surface_m != null && rm.distance_from_surface_m < 10;
    if (elements.journeyStateTitle) {
      elements.journeyStateTitle.textContent = !sessionActive
        ? 'TRACKING PAUSED'
        : (!rm.tracking ? 'AWAITING FIRST FIX' : (atSurface ? 'AT SURFACE' : 'UNDERGROUND'));
    }
    if (elements.journeyStateTag) {
      elements.journeyStateTag.textContent = !sessionActive
        ? 'TRACKING PAUSED — PRESS START TRACKING'
        : (rm.moving ? 'ROUTE TRACKING — MINER MOVING' : 'ROUTE TRACKING ACTIVE');
      setStatusClass(elements.journeyStateTag, sessionActive ? 'NORMAL' : 'WARNING');
    }
    if (elements.journeyStatusCode) {
      elements.journeyStatusCode.textContent = !sessionActive
        ? '[ STATUS: TRACKING PAUSED ]'
        : (rm.tracking
          ? (rm.moving ? '[ STATUS: TRACKING — MINER MOVING ]' : '[ STATUS: TRACKING — MINER STATIONARY ]')
          : '[ STATUS: AWAITING FIRST FIX ]');
    }
    if (elements.routeMapHeroCard) {
      elements.routeMapHeroCard.classList.remove('status-normal', 'status-warning', 'status-critical');
      elements.routeMapHeroCard.classList.add(rm.tracking && sessionActive ? 'status-normal' : 'status-warning');
    }
    if (elements.routeMapCanvasStatus) {
      // v4/v5/v6: reflect the dynamic map geometry, range-curve and tracking
      // session state (proximity lock flashes when the map snaps to a beacon)
      const geo = rm.geometry;
      const rc = state.range_cal;
      if (!sessionActive) {
        elements.routeMapCanvasStatus.textContent = '[ TRACKING PAUSED — PRESS START TRACKING ]';
      } else if (rc && rc.capture) {
        elements.routeMapCanvasStatus.textContent = `[ RANGE CAL — HOLD HELMET ${rc.capture.distance_m}m FROM NODE 2 · ${rc.capture.samples} SAMPLES ]`;
      } else if (rm.proximity) {
        elements.routeMapCanvasStatus.textContent = `[ PROXIMITY LOCK — ${rm.proximity.id} · SIGNAL ${rm.proximity.distance_m} m — MAP SNAPPED TO BEACON ]`;
      } else if (geo && geo.calibrating) {
        elements.routeMapCanvasStatus.textContent = '[ MAP CALIBRATING — KEEP NODES STATIONARY ]';
      } else if (rc && rc.calibrated) {
        elements.routeMapCanvasStatus.textContent = `[ RANGE CURVE LOCKED — A ${rc.A} dBm · n ${rc.n} ]`;
      } else if (geo && geo.source === 'calibrated' && geo.distances) {
        elements.routeMapCanvasStatus.textContent = `[ MAP LOCKED — N1↔N2 ${geo.distances.n1_n2_m}m · N2↔N3 ${geo.distances.n2_n3_m}m · N1↔N3 ${geo.distances.n1_n3_m}m ]`;
      } else {
        elements.routeMapCanvasStatus.textContent = rm.moving ? '[ PLOTTING — TRAJECTORY GROWING ]' : '[ MAP READY — RUN RANGE CAL FOR ACCURATE DISTANCES ]';
      }
    }
    if (elements.waypointCountDisplay) {
      elements.waypointCountDisplay.textContent = `${rm.waypoint_count} WAYPOINTS PLOTTED`;
    }

    // 3. Anchor Beacon Table
    if (elements.anchorTableBody && Array.isArray(rm.anchors)) {
      if (rm.anchors.length === 0) {
        elements.anchorTableBody.innerHTML = '<tr><td colspan="4" class="empty-state">Awaiting beacon ranges...</td></tr>';
      } else {
        elements.anchorTableBody.innerHTML = rm.anchors.map(a => `
          <tr>
            <td style="font-weight: 700;">${a.id}</td>
            <td>${a.x.toFixed(1)} , ${a.y.toFixed(1)}</td>
            <td style="font-weight: 800;">${a.distance.toFixed(1)} m</td>
            <td><span class="status-pill status-normal">${ANCHOR_ROLES[a.id] || 'RELAY BEACON'}</span></td>
          </tr>
        `).join('');
      }
    }

    // 4. Route Mapping Events
    if (elements.routeMapEventList && Array.isArray(state.events)) {
      if (state.events.length === 0) {
        elements.routeMapEventList.innerHTML = '<div class="empty-state">Awaiting route telemetry...</div>';
      } else {
        elements.routeMapEventList.innerHTML = state.events.slice(0, 10).map(evt => {
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
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  2-D ROUTE MAP — interactive canvas (pan / zoom / follow)
  // ═══════════════════════════════════════════════════════════════
  function initRouteCanvas() {
    const c = document.getElementById('routeMapCanvas');
    if (!c) return;
    canvasState.canvas = c;
    canvasState.ctx = c.getContext('2d');

    resizeRouteCanvas();
    window.addEventListener('resize', resizeRouteCanvas);
    if (typeof ResizeObserver === 'function') {
      canvasState.ro = new ResizeObserver(() => resizeRouteCanvas());
      canvasState.ro.observe(c);
    }

    // Drag-to-pan (mouse + touch via pointer events)
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (view.scale <= 0) return;
      view.cx -= dx / view.scale;
      view.cy += dy / view.scale;
      view.userMoved = true;
      if (view.follow) {
        view.follow = false;
        setFollowButton();
      }
    });
    const endDrag = () => {
      drag = null;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('pointerleave', endDrag);

    // Wheel-zoom toward cursor
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const W = c.offsetWidth;
      const H = c.offsetHeight;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.max(view.fitScale * 0.25, Math.min(view.fitScale * 10, view.scale * factor));
      if (newScale === view.scale) return;
      const wx = view.cx + (mx - W / 2) / view.scale;
      const wy = view.cy - (my - H / 2) / view.scale;
      view.scale = newScale;
      view.cx = wx - (mx - W / 2) / newScale;
      view.cy = wy + (my - H / 2) / newScale;
      view.userMoved = true;
      if (view.follow) {
        view.follow = false;
        setFollowButton();
      }
    }, { passive: false });

    animateRouteCanvas();
  }

  function resizeRouteCanvas() {
    const c = canvasState.canvas;
    const ctx = canvasState.ctx;
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.offsetWidth * dpr));
    const h = Math.max(1, Math.round(c.offsetHeight * dpr));
    if (c.width === w && c.height === h) return;
    c.width = w;
    c.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    if (!view.userMoved) view.fitted = false;
  }

  function setFollowButton() {
    if (elements.btnFollowMiner) {
      elements.btnFollowMiner.classList.toggle('active', view.follow);
    }
  }

  function fitView(W, H, rm) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x, y) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    if (Array.isArray(rm.tunnel)) rm.tunnel.forEach(p => consider(p.x, p.y));
    if (Array.isArray(rm.anchors)) rm.anchors.forEach(a => { consider(a.x, a.y); });
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 70; }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const padPx = 36;
    const scale = Math.min((W - padPx * 2) / spanX, (H - padPx * 2) / spanY);
    view.fitScale = scale > 0 ? scale : 1;
    view.scale = view.fitScale;
    view.cx = (minX + maxX) / 2;
    view.cy = (minY + maxY) / 2;
    view.fitted = true;
  }

  function animateRouteCanvas() {
    drawRouteMap();
    canvasState.animFrame = requestAnimationFrame(animateRouteCanvas);
  }

  let lastZoomPct = -1;
  function updateZoomTag() {
    if (!elements.zoomTag || view.fitScale <= 0) return;
    const pct = Math.round((view.scale / view.fitScale) * 100);
    if (pct !== lastZoomPct) {
      elements.zoomTag.textContent = `${pct}%`;
      lastZoomPct = pct;
    }
  }

  function drawRouteMap() {
    const c = canvasState.canvas;
    const ctx = canvasState.ctx;
    if (!c || !ctx || !currentState || !currentState.route_map) return;
    const rm = currentState.route_map;

    const W = c.offsetWidth;
    const H = c.offsetHeight;
    if (W < 10 || H < 10) return;

    if (!view.fitted) fitView(W, H, rm);

    if (view.follow && rm.position) {
      view.cx += (rm.position.x - view.cx) * 0.12;
      view.cy += (rm.position.y - view.cy) * 0.12;
    }

    const toX = (x) => W / 2 + (x - view.cx) * view.scale;
    const toY = (y) => H / 2 - (y - view.cy) * view.scale;

    // ── Background (calm paper tone) ────────────────────────────
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#f9fbf9');
    bg.addColorStop(1, '#f1f6f2');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // ── Metre grid ──────────────────────────────────────────────
    const viewSpanX = W / view.scale;
    const gridStep = viewSpanX > 400 ? 100 : viewSpanX > 160 ? 50 : viewSpanX > 60 ? 20 : 10;
    const left = view.cx - viewSpanX / 2;
    const right = view.cx + viewSpanX / 2;
    const bottom = view.cy - (H / view.scale) / 2;
    const top = view.cy + (H / view.scale) / 2;

    ctx.lineWidth = 1;
    ctx.font = '500 8px JetBrains Mono, monospace';
    for (let gx = Math.ceil(left / gridStep) * gridStep; gx <= right; gx += gridStep) {
      ctx.strokeStyle = 'rgba(21, 128, 61, 0.10)';
      ctx.beginPath();
      ctx.moveTo(toX(gx), 0);
      ctx.lineTo(toX(gx), H);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.fillText(`${gx}m`, toX(gx) + 3, H - 8);
    }
    for (let gy = Math.ceil(bottom / gridStep) * gridStep; gy <= top; gy += gridStep) {
      ctx.strokeStyle = 'rgba(21, 128, 61, 0.10)';
      ctx.beginPath();
      ctx.moveTo(0, toY(gy));
      ctx.lineTo(W, toY(gy));
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.fillText(`${gy}m`, 4, toY(gy) - 4);
    }

    // ── Tunnel polyline + working face ──────────────────────────
    if (Array.isArray(rm.tunnel) && rm.tunnel.length >= 2) {
      ctx.strokeStyle = 'rgba(22, 163, 74, 0.75)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(toX(rm.tunnel[0].x), toY(rm.tunnel[0].y));
      for (let i = 1; i < rm.tunnel.length; i++) {
        ctx.lineTo(toX(rm.tunnel[i].x), toY(rm.tunnel[i].y));
      }
      ctx.stroke();

      const face = rm.tunnel[rm.tunnel.length - 1];
      ctx.fillStyle = '#15803d';
      ctx.fillRect(toX(face.x) - 3, toY(face.y) - 3, 6, 6);
      ctx.font = '600 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#166534';
      ctx.fillText('WORKING FACE', toX(face.x), toY(face.y) + 16);
    }

    // ── Anchor beacon nodes ─────────────────────────────────────
    // v4: node markers come from the active geometry (preset or calibrated
    // layout) — always present; beacon-range anchors may lag behind.
    const nodeMarkers = (rm.geometry && Array.isArray(rm.geometry.nodes) && rm.geometry.nodes.length > 0)
      ? rm.geometry.nodes
      : (Array.isArray(rm.anchors) ? rm.anchors : []);
    nodeMarkers.forEach(a => {
        const x = toX(a.x);
        const y = toY(a.y);

        const glow = ctx.createRadialGradient(x, y, 0, x, y, 42);
        glow.addColorStop(0, 'rgba(34, 197, 94, 0.14)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, 42, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fillStyle = '#dcfce7';
        ctx.fill();
        ctx.strokeStyle = '#16a34a';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.font = 'bold 8px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#166534';
        ctx.fillText(a.id.replace('NODE', 'N'), x, y + 3);

        ctx.font = '500 8px JetBrains Mono, monospace';
        ctx.fillStyle = '#475569';
        if (typeof a.distance === 'number') {
          ctx.fillText(`${a.distance.toFixed(1)} m`, x, y + 26);
        }

        // v6: proximity lock — pulsing ring around the beacon the helmet is
        // being snapped toward (strong signal, map disagreement resolved).
        if (rm.proximity && rm.proximity.id === a.id) {
          const pulse = 20 + 6 * Math.sin(Date.now() / 280);
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = 'rgba(2, 132, 199, 0.85)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, pulse, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = 'bold 8px JetBrains Mono, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#0369a1';
          ctx.fillText('PROXIMITY LOCK', x, y - 26);
        }
      });

    // ── Breadcrumb trajectory ───────────────────────────────────
    if (Array.isArray(rm.path) && rm.path.length >= 2) {
      ctx.strokeStyle = 'rgba(217, 119, 6, 0.9)';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(toX(rm.path[0].x), toY(rm.path[0].y));
      for (let i = 1; i < rm.path.length; i++) {
        ctx.lineTo(toX(rm.path[i].x), toY(rm.path[i].y));
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(217, 119, 6, 0.55)';
      for (let i = 0; i < rm.path.length; i += 10) {
        ctx.beginPath();
        ctx.arc(toX(rm.path[i].x), toY(rm.path[i].y), 2, 0, Math.PI * 2);
        ctx.fill();
      }

      const st = rm.path[0];
      ctx.strokeStyle = 'rgba(180, 83, 9, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(toX(st.x), toY(st.y), 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '600 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#b45309';
      ctx.fillText('START', toX(st.x), toY(st.y) - 10);
    }

    // ── Live helmet marker ──────────────────────────────────────
    if (rm.position) {
      const x = toX(rm.position.x);
      const y = toY(rm.position.y);
      const helmetOnline = currentState.online;
      const hr = 13;
      const pulse = 1 + 0.07 * Math.sin(Date.now() / 380);

      const hGlow = ctx.createRadialGradient(x, y, 0, x, y, hr * 3 * pulse);
      hGlow.addColorStop(0, helmetOnline ? 'rgba(2, 132, 199, 0.18)' : 'rgba(220, 38, 38, 0.16)');
      hGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = hGlow;
      ctx.beginPath();
      ctx.arc(x, y, hr * 3 * pulse, 0, Math.PI * 2);
      ctx.fill();

      if (rm.position.heading != null) {
        const rad = rm.position.heading * Math.PI / 180;
        const hx = Math.cos(rad);
        const hy = -Math.sin(rad);
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + hx * 26, y + hy * 26);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + hx * 26, y + hy * 26);
        ctx.lineTo(x + hx * 18 + hy * 5, y + hy * 18 - hx * 5);
        ctx.lineTo(x + hx * 18 - hy * 5, y + hy * 18 + hx * 5);
        ctx.closePath();
        ctx.fillStyle = '#0284c7';
        ctx.fill();
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-hr * 0.8, -hr * 0.8, hr * 1.6, hr * 1.6);
      ctx.fillStyle = helmetOnline ? '#e0f2fe' : '#fef2f2';
      ctx.fill();
      ctx.strokeStyle = helmetOnline ? '#0284c7' : '#dc2626';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      ctx.font = '11px serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = helmetOnline ? '#0369a1' : '#b91c1c';
      ctx.fillText('⛑', x, y + 4);

      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.fillText('MINER 01', x, y - hr - 8);
    }

    // ── Legend + caption ────────────────────────────────────────
    ctx.font = '500 9px Inter, sans-serif';
    ctx.textAlign = 'left';
    [
      { col: 'rgba(217, 119, 6, 0.9)', label: 'Estimated Route' },
      { col: '#16a34a', label: 'Relay Beacon' },
      { col: '#0284c7', label: 'Miner (Live)' }
    ].forEach((item, i) => {
      ctx.fillStyle = item.col;
      ctx.fillRect(10, 12 + i * 14, 6, 6);
      ctx.fillStyle = '#475569';
      ctx.fillText(item.label, 20, 18 + i * 14);
    });

    ctx.textAlign = 'right';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 9px JetBrains Mono, monospace';
    ctx.fillText('ESTIMATED TRAJECTORY — DR + BEACON FUSION', W - 12, H - 10);

    updateZoomTag();
  }

  // WebSocket Connection Management
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async function () {
      console.log('✓ Connected to MUKUT Route Mapping WS');
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
          if (message.type === 'ROUTE_CHANGED') {
            fetch('/api/state')
              .then(res => res.json())
              .then(data => renderState(data))
              .catch(err => console.warn('Sync failed:', err));
          } else {
            renderState(message.payload);
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

  // Initial Setup
  function init() {
    elements.scenarioButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const scenario = btn.dataset.scenario;
        if (scenario) triggerScenario(scenario);
      });
    });

    if (elements.btnFitView) {
      elements.btnFitView.addEventListener('click', () => {
        view.follow = false;
        view.userMoved = false;
        view.fitted = false;
        setFollowButton();
      });
    }
    if (elements.btnFollowMiner) {
      elements.btnFollowMiner.addEventListener('click', () => {
        view.follow = !view.follow;
        setFollowButton();
      });
    }

    // v6: START/STOP TRACKING — session control. START opens a fresh session
    // (breadcrumb cleared, position re-fixed from relay beacons; the route
    // then draws itself as the miner moves, beacon proximity included). STOP
    // freezes the trajectory.
    if (elements.btnToggleTracking) {
      elements.btnToggleTracking.addEventListener('click', async () => {
        const active = !(currentState && currentState.route_map && currentState.route_map.session &&
          currentState.route_map.session.active === false);
        try {
          const response = await fetch('/api/tracking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: active ? 'stop' : 'start' })
          });
          const result = await response.json();
          if (!response.ok || !result.success) {
            if (elements.routeMapCanvasStatus) {
              elements.routeMapCanvasStatus.textContent = `[ TRACKING CONTROL FAILED — ${result.error || 'unreachable'} ]`;
            }
          } else if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = active
              ? '[ TRACKING PAUSED — TRAJECTORY FROZEN ]'
              : '[ TRACKING STARTED — POSITION RE-FIXING FROM RELAY BEACONS ]';
          }
        } catch (err) {
          console.error('Tracking toggle failed:', err);
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = '[ TRACKING CONTROL FAILED — SERVER UNREACHABLE ]';
          }
        }
      });
    }

    // v3: SET HEADING — miner faces into the tunnel, press, the current
    // helmet magnetometer heading becomes the new 0° (tunnel-forward).
    if (elements.btnSetHeading) {
      elements.btnSetHeading.addEventListener('click', async () => {
        try {
          const response = await fetch('/api/trajectory/heading-zero', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const result = await response.json();
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = (response.ok && result.success)
              ? `[ HEADING ZERO SET — MAG ${result.raw_heading_deg}° → 0° (OFFSET ${result.heading_offset_deg}°) ]`
              : `[ HEADING CAL FAILED — ${result.error || 'unreachable'} ]`;
          }
        } catch (err) {
          console.error('Heading zero calibration failed:', err);
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = '[ HEADING CAL FAILED — SERVER UNREACHABLE ]';
          }
        }
      });
    }

    // v4: CALIBRATE MAP — 8 s ceremony measuring inter-node distances; the
    // averaged result rebuilds the map geometry from the real node placement
    // and locks it (persisted across restarts). CLEAR MAP returns to preset.
    if (elements.btnCalibrateMap) {
      elements.btnCalibrateMap.addEventListener('click', async () => {
        try {
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = '[ MAP CALIBRATING — KEEP NODES STATIONARY ]';
          }
          const response = await fetch('/api/trajectory/calibrate-map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' })
          });
          const result = await response.json();
          if (!response.ok || !result.success) {
            if (elements.routeMapCanvasStatus) {
              elements.routeMapCanvasStatus.textContent = `[ MAP CAL FAILED — ${result.error || 'unreachable'} ]`;
            }
          }
        } catch (err) {
          console.error('Map calibration failed:', err);
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = '[ MAP CAL FAILED — SERVER UNREACHABLE ]';
          }
        }
      });
    }
    // v5: RANGE CAL — two-point fit on the real hardware. Hold the helmet at
    // the stated distance from NODE 2, keep still, press. After both points
    // every live distance uses the measured curve.
    const rangeCalCapture = async (point, distanceM) => {
      try {
        if (elements.routeMapCanvasStatus) {
          elements.routeMapCanvasStatus.textContent = `[ RANGE CAL — HOLD HELMET ${distanceM}m FROM NODE 2 · KEEP STILL ]`;
        }
        const response = await fetch('/api/range-cal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'capture', point, distance_m: distanceM })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = `[ RANGE CAL FAILED — ${result.error || 'unreachable'} ]`;
          }
        } else if (result.calibrated) {
          if (elements.routeMapCanvasStatus) {
            elements.routeMapCanvasStatus.textContent = `[ RANGE CURVE LOCKED — A ${result.A} dBm · n ${result.n} ]`;
          }
        }
      } catch (err) {
        console.error('Range calibration failed:', err);
        if (elements.routeMapCanvasStatus) {
          elements.routeMapCanvasStatus.textContent = '[ RANGE CAL FAILED — SERVER UNREACHABLE ]';
        }
      }
    };
    if (elements.btnRangeCal1) {
      elements.btnRangeCal1.addEventListener('click', () => rangeCalCapture(1, 1));
    }
    if (elements.btnRangeCal3) {
      elements.btnRangeCal3.addEventListener('click', () => rangeCalCapture(2, 3));
    }
    if (elements.btnClearMapCal) {
      elements.btnClearMapCal.addEventListener('click', async () => {
        try {
          await fetch('/api/trajectory/calibrate-map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear' })
          });
          await fetch('/api/range-cal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear' })
          });
        } catch (err) {
          console.error('Calibration clear failed:', err);
        }
      });
    }
    setFollowButton();

    relativeTimer = setInterval(updateLastSeenTick, 1000);

    initRouteCanvas();

    fetch('/api/state')
      .then(res => res.json())
      .then(data => renderState(data))
      .catch(err => console.warn('Initial state fetch failed:', err));

    connectWebSocket();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
