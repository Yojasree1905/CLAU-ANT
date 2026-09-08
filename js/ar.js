/**
 * ar.js
 * -----------------------------------------------------------------------
 * Two things get drawn on the AR canvas over the live camera feed:
 *
 * 1. A ground-style guidance path: a tapered shape sitting low in the
 *    frame that curves left/right toward the next turn, with chevrons
 *    flowing along it, plus a distance readout. This is a heading-locked
 *    illusion, not true world-locked AR — it doesn't track the real floor
 *    plane, so there's no depth sensing or SLAM involved. That's
 *    deliberate: real plane-tracked AR needs WebXR hit-testing (Chrome +
 *    ARCore on Android only, not Safari/iPhone), which would break this
 *    app on half of phones. This version works on any phone with a
 *    compass, matching the project's "no special hardware" design.
 *
 * 2. A landmark "bubble" — a small pill near the top of the screen naming
 *    whatever place the ambient visual-recognition system (localization.js)
 *    currently believes is in view, independent of the nav destination.
 *
 * iOS requires an explicit user gesture to grant orientation permission
 * (DeviceOrientationEvent.requestPermission()) — call
 * ArOverlay.requestPermission() from a tap handler before start().
 * -----------------------------------------------------------------------
 */

class ArOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.heading = null; // degrees, 0 = north; null until a real sensor reading arrives
    this.hasLiveHeading = false; // true once at least one real orientation event has arrived
    this.targetBearing = null;
    this.distanceRemaining = null;
    this.destinationLabel = '';
    this.bubbleText = null;
    this.dpr = window.devicePixelRatio || 1;
    this._reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._flowPhase = 0;
    this._startedAt = null;
    this._onOrientation = this._onOrientation.bind(this);
  }

  setDpr(dpr) {
    this.dpr = dpr;
  }

  static async requestPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const state = await DeviceOrientationEvent.requestPermission();
        return state === 'granted';
      } catch (_) {
        return false;
      }
    }
    return true; // Android / desktop don't require explicit permission
  }

  start() {
    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    this._startedAt = Date.now();
    this._raf();
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    if (this._raf_id) cancelAnimationFrame(this._raf_id);
  }

  _onOrientation(e) {
    // webkitCompassHeading (iOS Safari) is already 0=north, clockwise-positive.
    if (typeof e.webkitCompassHeading === 'number') {
      this.heading = e.webkitCompassHeading;
      this.hasLiveHeading = true;
    } else if (e.alpha !== null) {
      // 'alpha' increases counter-clockwise from device's initial orientation;
      // absolute=true + screen orientation 0 gives a usable compass proxy.
      this.heading = (360 - e.alpha) % 360;
      this.hasLiveHeading = true;
    }
    // If alpha is null, this event fired but carried no usable reading —
    // common on phones without a working magnetometer, or where indoor
    // metal/rebar has scrambled the compass. We deliberately do NOT set
    // hasLiveHeading here, so _effectiveHeading() below keeps using the
    // straight-ahead fallback instead of trusting a reading that never came.
  }

  /**
   * Real device heading if we have one; otherwise a synthetic "assume
   * you're already facing the target" heading, so the ground path always
   * renders something instead of silently drawing nothing forever. This
   * was a real bug found via on-device screenshots: several Android
   * phones never fire a usable deviceorientation reading indoors (compass
   * confused by structural steel/rebar), and the arrow overlay used to
   * just never appear in that case — which looked exactly like "the
   * arrows aren't implemented" even though the rendering code was fine.
   */
  _effectiveHeading() {
    if (this.hasLiveHeading) return this.heading;
    if (this.targetBearing === null) return null;
    return this.targetBearing; // relative bearing 0 == "draw it straight ahead"
  }

  setTarget(bearingDeg, distanceMeters, label) {
    this.setPath([{ bearing: bearingDeg, distance: distanceMeters }], distanceMeters, label);
  }

  /**
   * Multi-point version: points is an array of {bearing, distance} pairs
   * (absolute compass bearing in degrees, distance in meters), nearest
   * first, for several upcoming stops along the actual route — not just
   * the very next one. This is what makes the rendered path curve like
   * the real road instead of always drawing a single straight-ish shape:
   * each point gets projected to screen space based on its own bearing
   * and distance, and a smooth curve is traced through all of them.
   */
  setPath(points, totalDistanceRemaining, label) {
    this.pathPoints = points && points.length ? points : null;
    this.targetBearing = this.pathPoints ? this.pathPoints[0].bearing : null;
    this.distanceRemaining = totalDistanceRemaining;
    this.destinationLabel = label;
  }

  clearTarget() {
    this.targetBearing = null;
    this.pathPoints = null;
  }

  showBubble(text) {
    this.bubbleText = text;
  }

  clearBubble() {
    this.bubbleText = null;
  }

  _raf() {
    this._draw();
    if (!this._reducedMotion) this._flowPhase = (this._flowPhase + 0.015) % 1;
    this._raf_id = requestAnimationFrame(() => this._raf());
  }

  _draw() {
    const { ctx, canvas } = this;
    const dpr = this.dpr || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Vertical space actually available for drawing, between the top bar
    // and the bottom voice hub, so nothing we draw sits under either.
    const topOffset = (document.getElementById('top-bar')?.offsetHeight || 64) + 10;
    const bottomOffset = (document.getElementById('voice-hub')?.offsetHeight || 130) + 10;

    // Stack bubble -> distance label -> ground path top-to-bottom with
    // fixed gaps, so they never overlap regardless of screen size.
    let contentTop = topOffset;
    if (this.bubbleText) {
      this._drawBubble(w, contentTop);
      contentTop += 34 + 14; // bubble height + gap
    }

    if (this.targetBearing === null) {
      ctx.restore();
      return;
    }
    const heading = this._effectiveHeading();
    if (heading === null) {
      ctx.restore();
      return;
    }

    let rel = this.targetBearing - heading;
    rel = ((rel + 540) % 360) - 180; // -180..180, 0 = straight ahead; drives the turn-around check below

    const labelTop = contentTop;
    let pathTop = labelTop + 52 + 16; // label height + gap
    if (!this.hasLiveHeading) {
      this._drawCompassFallbackNotice(w, pathTop);
      pathTop += 26;
    }

    // Beyond ~70deg the nearest point is essentially behind you — a
    // curving ground path can't sensibly represent that, so show a
    // turn-around badge instead of a stretched-out arrow.
    if (Math.abs(rel) > 70) {
      this._drawTurnAround(rel, w, h, pathTop, bottomOffset);
      this._drawLabel(w, labelTop);
      ctx.restore();
      return;
    }

    this._drawCurvingPath(heading, w, h, pathTop, bottomOffset);
    this._drawLabel(w, labelTop);
    ctx.restore();
  }

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
    ctx.fillStyle = 'rgba(59, 130, 246, 0.85)'; // distinct blue — never confused with the red/amber hazard/turn colors
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

  /**
   * Projects each upcoming route point into screen space based on its own
   * bearing (relative to current heading) and distance, then traces a
   * smooth curve through all of them — this is what makes the path bend
   * like the real road shape instead of a single left/right lean. Nearer
   * points sit low and wide on screen; farther points sit higher and
   * narrower, approximating perspective without real depth data.
   */
  _drawCurvingPath(heading, w, h, pathTop, bottomOffset) {
    const { ctx } = this;
    const points = this.pathPoints;
    const bottomY = h - bottomOffset - 20;
    const topY = pathTop + (bottomY - pathTop) * 0.15;
    const bottomHalfW = w * 0.24;
    const topHalfW = w * 0.05;

    const maxDist = Math.max(...points.map((p) => p.distance), 1);
    const projected = points.map((p) => {
      let rel = p.bearing - heading;
      rel = ((rel + 540) % 360) - 180;
      const clampedRel = Math.max(-85, Math.min(85, rel));
      // sqrt compresses farther points so they don't all crowd near the
      // top when the lookahead spans a wide range of distances.
      const t = Math.min(1, Math.sqrt(p.distance / maxDist));
      return { rel: clampedRel, t };
    });

    const screenPoint = ({ rel, t }) => {
      const y = bottomY - t * (bottomY - topY);
      const lateralSpread = w * 0.3 * (1 - t * 0.25);
      const x = w / 2 + (rel / 85) * lateralSpread;
      const halfWidth = bottomHalfW * (1 - t) + topHalfW * t;
      return { x, y, halfWidth };
    };

    // The user's own position anchors the bottom of the path, always
    // dead-center — the path always starts "at your feet."
    const screenPts = [{ x: w / 2, y: bottomY, halfWidth: bottomHalfW }, ...projected.map(screenPoint)];

    const urgency = Math.min(Math.abs(projected[0].rel) / 70, 1);
    const r = Math.round(60 + urgency * 190);
    const g = Math.round(200 - urgency * 60);
    const pathColor = `rgb(${r}, ${g}, 90)`;

    ctx.save();
    ctx.beginPath();
    const leftEdge = screenPts.map((p) => ({ x: p.x - p.halfWidth, y: p.y }));
    const rightEdge = screenPts.map((p) => ({ x: p.x + p.halfWidth, y: p.y })).reverse();
    this._tracePolylineSmooth(ctx, leftEdge, false);
    this._tracePolylineSmooth(ctx, rightEdge, true);
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

    // Chevrons flowing along the path's centerline, each pointing along
    // its local tangent so they visually "aim" around every curve, not
    // just a single overall lean.
    const centerPts = screenPts.map((p) => ({ x: p.x, y: p.y }));
    const chevronCount = 4;
    for (let i = 0; i < chevronCount; i++) {
      const p = (i / chevronCount + this._flowPhase) % 1;
      const pt = this._pointOnPolyline(centerPts, p);
      const localWidth = bottomHalfW * (1 - p) + topHalfW * p;
      this._drawChevron(pt.x, pt.y, pt.angle, localWidth * 0.9, pathColor);
    }

    const tip = this._pointOnPolyline(centerPts, 1);
    this._drawChevron(tip.x, tip.y - 6, tip.angle, topHalfW * 2.2, pathColor, 1.4);
  }

  /**
   * Traces a smooth curve through a polyline's points using quadratic
   * curves through consecutive midpoints — a standard, simple technique
   * for a smooth line through arbitrary control points without needing a
   * full spline implementation. `continuePath` appends to the current
   * canvas path (via lineTo for the first point) instead of starting a
   * new subpath, so a left edge and a reversed right edge can be traced
   * back-to-back into one closed shape.
   */
  _tracePolylineSmooth(ctx, points, continuePath) {
    if (points.length === 0) return;
    if (continuePath) ctx.lineTo(points[0].x, points[0].y);
    else ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) return;
    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
      return;
    }
    for (let i = 1; i < points.length - 1; i++) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  /** Point + tangent angle at parameter p (0=first, 1=last) along a polyline, interpolating evenly by segment index. */
  _pointOnPolyline(points, p) {
    const n = points.length;
    if (n === 1) return { x: points[0].x, y: points[0].y, angle: 0 };
    const scaled = Math.max(0, Math.min(1, p)) * (n - 1);
    const i0 = Math.min(Math.floor(scaled), n - 2);
    const i1 = i0 + 1;
    const localT = scaled - i0;
    const x = points[i0].x + (points[i1].x - points[i0].x) * localT;
    const y = points[i0].y + (points[i1].y - points[i0].y) * localT;
    const dx = points[i1].x - points[i0].x;
    const dy = points[i1].y - points[i0].y;
    return { x, y, angle: Math.atan2(dx, -dy) };
  }

  _drawChevron(x, y, angle, width, color, scale = 1) {
    const { ctx } = this;
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
    ctx.restore();
  }

  _drawTurnAround(rel, w, h, pathTop, bottomOffset) {
    const { ctx } = this;
    const availHeight = Math.max(h - pathTop - bottomOffset, 160);
    const cx = w / 2;
    const cy = pathTop + availHeight * 0.35;
    const size = Math.min(w, availHeight) * 0.16;
    const side = rel > 0 ? 1 : -1; // which way to loop around

    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(217,154,43,0.95)'; // caution amber
    ctx.lineWidth = size * 0.28;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, size, Math.PI * 0.15 * side, Math.PI * 1.6 * side, side < 0);
    ctx.stroke();

    // Arrowhead at the open end of the loop
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

  _drawCompassFallbackNotice(w, y) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(217,154,43,0.9)'; // caution amber, matches turn-around color
    ctx.fillText('No compass signal — showing straight-ahead', w / 2, y);
    ctx.restore();
  }

  _drawLabel(w, labelTop) {
    const { ctx } = this;
    const barY = labelTop;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, barY, w, 52);
    ctx.fillStyle = '#fff';
    ctx.font = '600 19px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const distText = this.distanceRemaining !== null ? `${this.distanceRemaining.toFixed(1)} m` : '';
    ctx.fillText(`${this.destinationLabel}  ${distText}`, w / 2, barY + 33);
  }
}

window.ArOverlay = ArOverlay;
