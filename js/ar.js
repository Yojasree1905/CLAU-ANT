/**
 * ar.js
 * -----------------------------------------------------------------------
 * Three things drawn on the AR canvas over the live camera feed:
 *
 * 1. ROUTE PROJECTION — the primary new feature.
 *    Each point of the real GPS route polyline (from route-provider.js)
 *    is projected to its correct position in the camera frame using the
 *    phone's compass heading and GPS position. This gives a transparent
 *    arrow corridor that literally follows the road as it curves in front
 *    of you, not just a synthetic shape based only on the next bearing.
 *    Maths: bearing + haversine distance → relative screen angle →
 *    perspective-corrected (x, y) on canvas.
 *
 * 2. OUTLINING AR — live bounding boxes around detected hazards from
 *    hazards.js (person, vehicle, obstacle), colour-coded by urgency.
 *
 * 3. LANDMARK BUBBLE — "You might be near X" pill from localization.js.
 *
 * Platform notes:
 *   - Canvas 2D only — no WebGL, no WebXR.
 *   - WebXR / plane-tracked AR only works on ARCore Android + Chrome,
 *     not iPhones — this approach works everywhere.
 *   - iOS needs an explicit user gesture before DeviceOrientationEvent
 *     fires; call ArOverlay.requestPermission() from a tap handler.
 *   - If the compass never delivers a reading (concrete buildings can
 *     scramble magnetometers), the overlay draws the path straight ahead
 *     with a visible notice rather than showing nothing.
 * -----------------------------------------------------------------------
 */

// Default camera FOV — most phone rear cameras are 55–65° horizontal.
// Configurable via Settings so users can tune for their device.
const DEFAULT_FOV_H = 60; // degrees, horizontal
const DEFAULT_FOV_V = 45; // degrees, vertical

// How far ahead to project route points (metres). Beyond this they're
// near the horizon and not useful to draw individually.
const MAX_PROJ_DIST = 120;

// Minimum separation between drawn distance markers (screen pixels)
const MIN_MARKER_GAP_PX = 60;

class ArOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Compass / orientation
    this.heading = null;
    this.hasLiveHeading = false;

    // Route data (set by app.js on each GPS update)
    this._routePolyline = null;   // [[lat,lon], ...]
    this._currentLat = null;
    this._currentLon = null;
    this._destLabel = '';
    this._distanceRemaining = null;

    // Hazard outlines
    this.detectedObjects = [];
    this.detectedVideoSize = { w: 1, h: 1 };

    // Ambient landmark bubble
    this.bubbleText = null;

    // Debug overlay
    this.debugInfo = null;

    // Animation
    this.dpr = window.devicePixelRatio || 1;
    this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this._flowPhase = 0;

    // Camera FOV (configurable)
    this.fovH = DEFAULT_FOV_H;
    this.fovV = DEFAULT_FOV_V;

    this._onOrientation = this._onOrientation.bind(this);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  setDpr(dpr) { this.dpr = dpr; }
  setFov(h, v) { this.fovH = h || DEFAULT_FOV_H; this.fovV = v || DEFAULT_FOV_V; }

  static async requestPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        return (await DeviceOrientationEvent.requestPermission()) === 'granted';
      } catch (_) { return false; }
    }
    return true;
  }

  start() {
    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this._raf();
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  /**
   * Set the full route polyline + current GPS position.
   * Called by app.js on every GPS update while navigating.
   *
   * @param {Array} polyline  [[lat,lon], ...] — the full route from routing engine
   * @param {number} lat      current GPS latitude
   * @param {number} lon      current GPS longitude
   * @param {string} destLabel  destination name for the label
   * @param {number} distanceRemaining  metres remaining to destination
   */
  setRoute(polyline, lat, lon, destLabel, distanceRemaining) {
    this._routePolyline = polyline && polyline.length > 1 ? polyline : null;
    this._currentLat = lat;
    this._currentLon = lon;
    this._destLabel = destLabel || '';
    this._distanceRemaining = distanceRemaining;
  }

  clearRoute() {
    this._routePolyline = null;
    this._currentLat = null;
    this._currentLon = null;
    this._destLabel = '';
    this._distanceRemaining = null;
  }

  // Legacy API — kept so existing code that calls setTarget()/setPath()
  // keeps working while we transition.
  setTarget(bearingDeg, distanceMeters, label) {
    this._legacyBearing = bearingDeg;
    this._legacyDist = distanceMeters;
    this._legacyLabel = label;
    // If no real route polyline is loaded, fall back to the old synthetic path
    if (!this._routePolyline) {
      this._legacyMode = true;
    }
  }

  setPath(points, totalDist, label) {
    this._legacyPoints = points;
    this._legacyDist = totalDist;
    this._legacyLabel = label;
    if (!this._routePolyline) this._legacyMode = true;
  }

  clearTarget() {
    this._routePolyline = null;
    this._legacyMode = false;
    this._legacyBearing = null;
    this._legacyPoints = null;
  }

  showBubble(text)   { this.bubbleText = text; }
  clearBubble()      { this.bubbleText = null; }
  setDebugInfo(text) { this.debugInfo = text; }

  setDetectedObjects(boxes, videoWidth, videoHeight) {
    this.detectedObjects = boxes || [];
    this.detectedVideoSize = { w: videoWidth, h: videoHeight };
  }

  // ------------------------------------------------------------------
  // Orientation
  // ------------------------------------------------------------------

  _onOrientation(e) {
    if (typeof e.webkitCompassHeading === 'number') {
      this.heading = e.webkitCompassHeading;
      this.hasLiveHeading = true;
    } else if (e.alpha !== null) {
      this.heading = (360 - e.alpha) % 360;
      this.hasLiveHeading = true;
    }
  }

  _effectiveHeading() {
    if (this.hasLiveHeading) return this.heading;
    // No compass — synthesise "you're facing the destination" so the
    // overlay still shows something useful rather than nothing.
    if (this._routePolyline && this._currentLat !== null) {
      // Use bearing to the nearest upcoming route point as the heading
      const nearest = this._nearestRoutePoint();
      if (nearest) {
        return _initialBearing(
          this._currentLat, this._currentLon,
          nearest[0], nearest[1]
        );
      }
    }
    return this._legacyBearing ?? null;
  }

  // ------------------------------------------------------------------
  // Animation loop
  // ------------------------------------------------------------------

  _raf() {
    this._draw();
    if (!this._reducedMotion) this._flowPhase = (this._flowPhase + 0.015) % 1;
    this._rafId = requestAnimationFrame(() => this._raf());
  }

  // ------------------------------------------------------------------
  // Main draw
  // ------------------------------------------------------------------

  _draw() {
    const { ctx, canvas } = this;
    const dpr = this.dpr || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const topOffset  = (document.getElementById('top-bar')?.offsetHeight  || 64) + 10;
    const botOffset  = (document.getElementById('voice-hub')?.offsetHeight || 130) + 10;

    let contentTop = topOffset;

    // 1. Ambient landmark bubble
    if (this.bubbleText) {
      this._drawBubble(w, contentTop);
      contentTop += 48;
    }

    // 2. Hazard bounding boxes
    if (this.detectedObjects?.length) {
      this._drawDetectionOutlines(w, h);
    }

    // 3. Debug info
    if (this.debugInfo) {
      this._drawDebugInfo(w, h);
    }

    const heading = this._effectiveHeading();

    // 4. Route projection (new GPS-based system)
    const hasRoute = this._routePolyline && this._currentLat !== null;
    if (hasRoute) {
      const compassFallback = !this.hasLiveHeading;
      if (compassFallback) this._drawCompassFallbackNotice(w, contentTop);
      this._drawRouteProjection(heading, w, h, contentTop, botOffset);
      this._drawNavLabel(w, contentTop + (compassFallback ? 22 : 0), botOffset);
      ctx.restore();
      return;
    }

    // 5. Legacy mode — old bearing-only synthetic path (fallback while
    //    there's no route polyline loaded)
    const lPoints = this._legacyPoints;
    const lBearing = this._legacyBearing;
    if (!lPoints && lBearing === null) { ctx.restore(); return; }
    if (heading === null)               { ctx.restore(); return; }

    const firstBearing = lPoints ? lPoints[0].bearing : lBearing;
    let rel = firstBearing - heading;
    rel = ((rel + 540) % 360) - 180;

    const labelTop = contentTop;
    let pathTop = labelTop + 52 + 16;
    if (!this.hasLiveHeading) {
      this._drawCompassFallbackNotice(w, pathTop);
      pathTop += 26;
    }
    if (Math.abs(rel) > 70) {
      this._drawTurnAround(rel, w, h, pathTop, botOffset);
      this._drawLabel(w, labelTop, this._legacyLabel, this._legacyDist);
    } else {
      this._drawCurvingPath(heading, w, h, pathTop, botOffset, lPoints || [{ bearing: lBearing, distance: lBearing ?? 10 }]);
      this._drawLabel(w, labelTop, this._legacyLabel, this._legacyDist);
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // GPS → Screen projection  (the core new rendering)
  // ------------------------------------------------------------------

  /**
   * Projects each upcoming point of the GPS route polyline onto the
   * camera canvas using compass heading + haversine geometry.
   *
   * Coordinate system:
   *   - relativeBearing (−180..+180): negative = left of camera centre,
   *     positive = right
   *   - Distance drives vertical position: close = bottom, far = horizon
   */
  _drawRouteProjection(heading, w, h, topOffset, botOffset) {
    const { ctx } = this;
    if (!this._routePolyline || this._currentLat === null) return;

    const nearestIdx = this._nearestRouteIndex();
    const usableHeading = heading ?? _initialBearing(
      this._currentLat, this._currentLon,
      this._routePolyline[nearestIdx]?.[0] ?? this._currentLat,
      this._routePolyline[nearestIdx]?.[1] ?? this._currentLon
    );

    // Collect upcoming route points (from nearest forward)
    const MAX_POINTS = 20;
    const projected = [];
    let totalDist = 0;

    for (let i = nearestIdx; i < this._routePolyline.length && projected.length < MAX_POINTS; i++) {
      const [pLat, pLon] = this._routePolyline[i];
      const dist = _haversine(this._currentLat, this._currentLon, pLat, pLon);
      if (dist > MAX_PROJ_DIST) break;

      let rel = _initialBearing(this._currentLat, this._currentLon, pLat, pLon) - usableHeading;
      rel = ((rel + 540) % 360) - 180; // −180..+180

      const screen = this._gpsToScreen(rel, dist, w, h, topOffset, botOffset);
      if (!screen) continue;

      projected.push({ ...screen, dist, idx: i });
      totalDist = dist;
    }

    if (projected.length < 1) return;

    // Add "your feet" as anchor at bottom-centre
    const footY = h - botOffset - 10;
    const anchor = { x: w / 2, y: footY, halfW: w * 0.22 };

    // ---- Draw corridor fill ----
    this._drawCorridorFill(ctx, anchor, projected, w, footY);

    // ---- Draw animated chevrons along corridor centreline ----
    const centreLine = [{ x: anchor.x, y: anchor.y }, ...projected.map((p) => ({ x: p.x, y: p.y }))];
    this._drawFlowingChevrons(ctx, centreLine, projected, anchor);

    // ---- Draw turn indicators at sharp bends ----
    this._drawTurnIndicators(ctx, projected);

    // ---- Draw distance markers ----
    this._drawDistanceMarkers(ctx, projected);

    // ---- Destination pin at far end ----
    if (this._destLabel && projected.length) {
      const tip = projected[projected.length - 1];
      this._drawDestinationPin(ctx, tip.x, tip.y, this._destLabel);
    }
  }

  /**
   * Projects a point (relativeBearing degrees, distance metres) to
   * canvas (x, y) coordinates using a perspective ground-plane model.
   * Returns null if the point is outside the camera's horizontal FOV.
   */
  _gpsToScreen(relBearingDeg, distMeters, w, h, topOffset, botOffset) {
    const halfFovH = this.fovH / 2;

    // Clip to camera FOV — points more than halfFovH left or right
    // are literally off-screen
    if (Math.abs(relBearingDeg) > halfFovH * 1.1) return null;

    // Horizontal: linear mapping of relative bearing to screen x
    const x = w / 2 + (relBearingDeg / halfFovH) * (w / 2);

    // Vertical: perspective ground-plane projection.
    // Close objects appear at the bottom; far objects approach the horizon.
    // Horizon line ≈ middle of the usable vertical space.
    const usableH = h - topOffset - botOffset;
    const horizonY = topOffset + usableH * 0.42;  // horizon at ~42% from top
    const footY    = h - botOffset - 10;           // "your feet" at bottom

    // Perspective factor: as distance → ∞, t → 1 (at horizon).
    // sqrt gives nicer compression for medium distances.
    const t = Math.min(1, Math.sqrt(distMeters / MAX_PROJ_DIST));
    const y = footY - t * (footY - horizonY);

    // Corridor half-width: wide at bottom, narrow at horizon (perspective)
    const halfW = (w * 0.22) * (1 - t * 0.88) + (w * 0.02) * t;

    return { x, y, halfW };
  }

  _drawCorridorFill(ctx, anchor, projected, w, footY) {
    if (!projected.length) return;

    // Build left + right edges of the corridor
    const leftPts  = [{ x: anchor.x - anchor.halfW, y: anchor.y }];
    const rightPts = [{ x: anchor.x + anchor.halfW, y: anchor.y }];

    for (const p of projected) {
      leftPts.push({ x: p.x - p.halfW, y: p.y });
      rightPts.push({ x: p.x + p.halfW, y: p.y });
    }

    ctx.save();
    ctx.beginPath();
    _traceSmooth(ctx, leftPts, false);
    _traceSmooth(ctx, [...rightPts].reverse(), true);
    ctx.closePath();

    // Colour gradient: teal at bottom → transparent at top
    const grad = ctx.createLinearGradient(0, anchor.y, 0, projected[projected.length - 1].y);
    grad.addColorStop(0, 'rgba(0, 200, 180, 0.70)');
    grad.addColorStop(0.5, 'rgba(0, 160, 220, 0.45)');
    grad.addColorStop(1, 'rgba(0, 120, 255, 0.10)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Edge outline
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.stroke();

    ctx.restore();
  }

  _drawFlowingChevrons(ctx, centreLine, projected, anchor) {
    const CHEVRON_COUNT = 5;
    for (let i = 0; i < CHEVRON_COUNT; i++) {
      const p = (i / CHEVRON_COUNT + this._flowPhase) % 1;
      const pt = _pointOnPolyline(centreLine, p);
      // Width scales with position along path (wide at bottom, narrow at top)
      const w = anchor.halfW * (1 - p * 0.8) + (projected[projected.length - 1]?.halfW || 8) * p;
      _drawChevron(ctx, pt.x, pt.y, pt.angle, w * 1.4, 'rgba(255,255,255,0.85)');
    }
  }

  _drawTurnIndicators(ctx, projected) {
    for (let i = 1; i < projected.length - 1; i++) {
      const prev = projected[i - 1];
      const curr = projected[i];
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = (projected[i + 1]?.x ?? curr.x) - curr.x;
      const dy2 = (projected[i + 1]?.y ?? curr.y) - curr.y;

      // Cross product to detect bend direction
      const cross = dx1 * dy2 - dy1 * dx2;
      const len1 = Math.sqrt(dx1 ** 2 + dy1 ** 2);
      const len2 = Math.sqrt(dx2 ** 2 + dy2 ** 2);
      if (len1 < 5 || len2 < 5) continue;

      // Dot product → angle between segments
      const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
      const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;

      if (angleDeg > 25) { // meaningful turn
        const side = cross > 0 ? 'right' : 'left';
        this._drawTurnArrow(ctx, curr.x, curr.y, side, angleDeg);
      }
    }
  }

  _drawTurnArrow(ctx, x, y, side, angleDeg) {
    const label = angleDeg > 80
      ? (side === 'right' ? '↱' : '↰')
      : (side === 'right' ? '→' : '←');
    ctx.save();
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Pill background
    const tw = ctx.measureText(label).width + 16;
    const th = 26;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    _roundRect(ctx, x - tw / 2, y - th / 2, tw, th, 6);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 220, 0, 0.95)';
    ctx.fillText(label, x, y + 1);
    ctx.restore();
  }

  _drawDistanceMarkers(ctx, projected) {
    const intervals = [10, 20, 50, 100]; // metres
    let lastMarkerY = Infinity;

    for (const p of projected) {
      // Find the best interval for this distance
      const interval = intervals.find((iv) => Math.abs(p.dist % iv) < iv * 0.25);
      if (!interval) continue;
      if (Math.abs(lastMarkerY - p.y) < MIN_MARKER_GAP_PX) continue;

      const label = p.dist < 100
        ? `${Math.round(p.dist)} m`
        : `${(p.dist / 1000).toFixed(1)} km`;

      ctx.save();
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      _roundRect(ctx, p.x - tw / 2, p.y - 10, tw, 20, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(label, p.x, p.y);
      ctx.restore();

      lastMarkerY = p.y;
    }
  }

  _drawDestinationPin(ctx, x, y, label) {
    ctx.save();
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 16;
    const th = 26;

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 6;

    ctx.fillStyle = 'rgba(220, 60, 30, 0.92)';
    _roundRect(ctx, x - tw / 2, y - th - 8, tw, th, 6);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x, y - th / 2 - 8 + 1);
    ctx.restore();
  }

  _drawNavLabel(w, topY, botOffset) {
    if (!this._distanceRemaining && !this._destLabel) return;
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, topY, w, 50);
    ctx.fillStyle = '#fff';
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const distText = this._distanceRemaining != null
      ? `  ${this._distanceRemaining.toFixed(0)} m`
      : '';
    ctx.fillText(`${this._destLabel}${distText}`, w / 2, topY + 32);
  }

  // ------------------------------------------------------------------
  // Nearest route point helpers
  // ------------------------------------------------------------------

  _nearestRouteIndex() {
    if (!this._routePolyline || this._currentLat === null) return 0;
    let minDist = Infinity, minIdx = 0;
    for (let i = 0; i < this._routePolyline.length; i++) {
      const d = _haversine(this._currentLat, this._currentLon, ...this._routePolyline[i]);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    // Advance past the very nearest point so the corridor starts *ahead*
    return Math.min(minIdx + 1, this._routePolyline.length - 1);
  }

  _nearestRoutePoint() {
    const idx = this._nearestRouteIndex();
    return this._routePolyline?.[idx] ?? null;
  }

  // ------------------------------------------------------------------
  // Hazard bounding boxes (unchanged from original)
  // ------------------------------------------------------------------

  _videoToCanvas(x, y, canvasW, canvasH) {
    const { w: vw, h: vh } = this.detectedVideoSize;
    const scale = Math.max(canvasW / vw, canvasH / vh);
    const displayedW = vw * scale;
    const displayedH = vh * scale;
    const offsetX = (canvasW - displayedW) / 2;
    const offsetY = (canvasH - displayedH) / 2;
    return { x: x * scale + offsetX, y: y * scale + offsetY, scale };
  }

  _drawDetectionOutlines(w, h) {
    const { ctx } = this;
    const ZONE_STYLE = {
      critical: { color: 'rgba(220, 60, 60, 0.95)', lineWidth: 3 },
      near:     { color: 'rgba(230, 170, 40, 0.90)', lineWidth: 2.5 },
      mid:      { color: 'rgba(110, 200, 140, 0.75)', lineWidth: 2 },
      far:      { color: 'rgba(180, 180, 180, 0.50)', lineWidth: 1.5 },
    };

    for (const obj of this.detectedObjects) {
      const [bx, by, bw, bh] = obj.bbox;
      const tl = this._videoToCanvas(bx, by, w, h);
      const br = this._videoToCanvas(bx + bw, by + bh, w, h);
      const boxW = br.x - tl.x;
      const boxH = br.y - tl.y;
      const style = ZONE_STYLE[obj.zone] || ZONE_STYLE.far;

      ctx.save();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.lineWidth;
      ctx.strokeRect(tl.x, tl.y, boxW, boxH);

      ctx.font = '600 13px system-ui, sans-serif';
      const tw = ctx.measureText(obj.label).width;
      const chipW = tw + 12;
      const chipH = 20;
      const chipY = Math.max(tl.y - chipH, 0);
      ctx.fillStyle = style.color;
      ctx.fillRect(tl.x, chipY, chipW, chipH);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.label, tl.x + 6, chipY + chipH / 2 + 1);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------
  // Shared / utility draw helpers
  // ------------------------------------------------------------------

  _drawBubble(w, topOffset) {
    const { ctx } = this;
    ctx.font = '600 15px system-ui, sans-serif';
    const paddingX = 16;
    const textWidth = ctx.measureText(this.bubbleText).width;
    const bubbleW = Math.min(textWidth + paddingX * 2, w - 32);
    const bubbleH = 34;
    const bx = (w - bubbleW) / 2;
    const by = topOffset;

    ctx.save();
    ctx.beginPath();
    const r = bubbleH / 2;
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + bubbleW, by, bx + bubbleW, by + bubbleH, r);
    ctx.arcTo(bx + bubbleW, by + bubbleH, bx, by + bubbleH, r);
    ctx.arcTo(bx, by + bubbleH, bx, by, r);
    ctx.arcTo(bx, by, bx + bubbleW, by, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(59, 130, 246, 0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.bubbleText, w / 2, by + bubbleH / 2 + 1, bubbleW - paddingX);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  _drawCompassFallbackNotice(w, y) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(217,154,43,0.9)';
    ctx.fillText('No compass — showing straight-ahead path', w / 2, y);
    ctx.restore();
  }

  _drawDebugInfo(w, h) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 11px monospace';
    const text = this.debugInfo;
    const tw = ctx.measureText(text).width;
    const boxH = 18;
    const y = h - boxH - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(6, y, tw + 12, boxH);
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, y + boxH / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Legacy synthetic path (bearing-only, used if no GPS route loaded)
  // ------------------------------------------------------------------

  _drawCurvingPath(heading, w, h, pathTop, bottomOffset, points) {
    const { ctx } = this;
    const bottomY = h - bottomOffset - 20;
    const topY    = pathTop + (bottomY - pathTop) * 0.15;
    const bottomHalfW = w * 0.24;
    const topHalfW    = w * 0.05;
    const maxDist = Math.max(...points.map((p) => p.distance || p.dist || 10), 1);

    const projected = points.map((p) => {
      let rel = (p.bearing - heading);
      rel = ((rel + 540) % 360) - 180;
      const t = Math.min(1, Math.sqrt((p.distance || p.dist || 10) / maxDist));
      return { rel: Math.max(-85, Math.min(85, rel)), t };
    });

    const screenPoint = ({ rel, t }) => ({
      x: w / 2 + (rel / 85) * w * 0.3 * (1 - t * 0.25),
      y: bottomY - t * (bottomY - topY),
      halfWidth: bottomHalfW * (1 - t) + topHalfW * t,
    });

    const screenPts = [{ x: w / 2, y: bottomY, halfWidth: bottomHalfW }, ...projected.map(screenPoint)];
    const urgency = Math.min(Math.abs(projected[0]?.rel || 0) / 70, 1);
    const pathColor = `rgb(${Math.round(60 + urgency * 190)}, ${Math.round(200 - urgency * 60)}, 90)`;

    ctx.save();
    ctx.beginPath();
    _traceSmooth(ctx, screenPts.map((p) => ({ x: p.x - p.halfWidth, y: p.y })), false);
    _traceSmooth(ctx, [...screenPts.map((p) => ({ x: p.x + p.halfWidth, y: p.y }))].reverse(), true);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, bottomY, 0, topY);
    grad.addColorStop(0, pathColor);
    grad.addColorStop(1, 'rgba(255,255,255,0.15)');
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();
    ctx.restore();

    const cPts = screenPts.map((p) => ({ x: p.x, y: p.y }));
    for (let i = 0; i < 4; i++) {
      const p = (i / 4 + this._flowPhase) % 1;
      const pt = _pointOnPolyline(cPts, p);
      const lw = bottomHalfW * (1 - p) + topHalfW * p;
      _drawChevron(ctx, pt.x, pt.y, pt.angle, lw * 0.9, pathColor);
    }
  }

  _drawLabel(w, labelTop, label, dist) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, labelTop, w, 52);
    ctx.fillStyle = '#fff';
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const distText = dist != null ? `  ${dist.toFixed(1)} m` : '';
    ctx.fillText(`${label || ''}${distText}`, w / 2, labelTop + 33);
  }

  _drawTurnAround(rel, w, h, pathTop, bottomOffset) {
    const { ctx } = this;
    const availH = Math.max(h - pathTop - bottomOffset, 160);
    const cx = w / 2;
    const cy = pathTop + availH * 0.35;
    const size = Math.min(w, availH) * 0.16;
    const side = rel > 0 ? 1 : -1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(217,154,43,0.95)';
    ctx.lineWidth = size * 0.28;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, size, Math.PI * 0.15 * side, Math.PI * 1.6 * side, side < 0);
    ctx.stroke();

    ctx.beginPath();
    const endAngle = Math.PI * 1.6 * side;
    const ex = Math.cos(endAngle) * size;
    const ey = Math.sin(endAngle) * size;
    ctx.translate(ex, ey);
    ctx.rotate(endAngle + (Math.PI / 2) * side);
    ctx.moveTo(0, -size * 0.35);
    ctx.lineTo(size * 0.3, size * 0.2);
    ctx.lineTo(-size * 0.3, size * 0.2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(217,154,43,0.95)';
    ctx.fill();
    ctx.restore();
  }
}

// ------------------------------------------------------------------
// Standalone geometry helpers (module-level, no class needed)
// ------------------------------------------------------------------

function _haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _initialBearing(lat1, lon1, lat2, lon2) {
  const toR = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toR(lon2 - lon1)) * Math.cos(toR(lat2));
  const x = Math.cos(toR(lat1)) * Math.sin(toR(lat2))
    - Math.sin(toR(lat1)) * Math.cos(toR(lat2)) * Math.cos(toR(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function _traceSmooth(ctx, points, continuePath) {
  if (!points.length) return;
  if (continuePath) ctx.lineTo(points[0].x, points[0].y);
  else ctx.moveTo(points[0].x, points[0].y);
  if (points.length < 2) return;
  if (points.length === 2) { ctx.lineTo(points[1].x, points[1].y); return; }
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

function _pointOnPolyline(points, p) {
  const n = points.length;
  if (n === 1) return { x: points[0].x, y: points[0].y, angle: 0 };
  const s = Math.max(0, Math.min(1, p)) * (n - 1);
  const i0 = Math.min(Math.floor(s), n - 2);
  const i1 = i0 + 1;
  const t  = s - i0;
  return {
    x: points[i0].x + (points[i1].x - points[i0].x) * t,
    y: points[i0].y + (points[i1].y - points[i0].y) * t,
    angle: Math.atan2(points[i1].x - points[i0].x, -(points[i1].y - points[i0].y)),
  };
}

function _drawChevron(ctx, x, y, angle, width, color, scale = 1) {
  const h = width * 0.55 * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -h);
  ctx.lineTo(width / 2, h * 0.5);
  ctx.lineTo(width * 0.18, h * 0.5);
  ctx.lineTo(0, -h * 0.15);
  ctx.lineTo(-width * 0.18, h * 0.5);
  ctx.lineTo(-width / 2, h * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

window.ArOverlay = ArOverlay;
