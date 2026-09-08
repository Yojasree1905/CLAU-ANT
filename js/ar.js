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
    this.targetBearing = bearingDeg;
    this.distanceRemaining = distanceMeters;
    this.destinationLabel = label;
  }

  clearTarget() {
    this.targetBearing = null;
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
    rel = ((rel + 540) % 360) - 180; // -180..180, 0 = straight ahead

    const labelTop = contentTop;
    let pathTop = labelTop + 52 + 16; // label height + gap
    if (!this.hasLiveHeading) {
      this._drawCompassFallbackNotice(w, pathTop);
      pathTop += 26;
    }

    // Beyond ~70deg the destination is essentially behind you — a curving
    // ground path can't sensibly represent that, so show a turn-around
    // badge instead of a stretched-out arrow.
    if (Math.abs(rel) > 70) {
      this._drawTurnAround(rel, w, h, pathTop, bottomOffset);
      this._drawLabel(w, labelTop);
      ctx.restore();
      return;
    }

    this._drawGroundPath(rel, w, h, pathTop, bottomOffset);
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

  _drawGroundPath(rel, w, h, pathTop, bottomOffset) {
    const { ctx } = this;
    const t = rel / 70; // -1..1
    const urgency = Math.min(Math.abs(rel) / 70, 1);
    const r = Math.round(60 + urgency * 190);
    const g = Math.round(200 - urgency * 60);
    const pathColor = `rgb(${r}, ${g}, 90)`;

    // Ground path: a curved trapezoid from low in the viewport up toward a
    // vanishing point, bending toward the turn direction.
    const bottomY = h - bottomOffset - 20;
    const topY = pathTop + (bottomY - pathTop) * 0.15;
    const bottomHalfW = w * 0.24;
    const topHalfW = w * 0.045;
    const centerX = w / 2;
    const topCenterX = centerX + t * w * 0.3;
    const controlY = (bottomY + topY) / 2;
    const controlShift = t * w * 0.22;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(centerX - bottomHalfW, bottomY);
    ctx.quadraticCurveTo(centerX - bottomHalfW * 0.4 + controlShift, controlY, topCenterX - topHalfW, topY);
    ctx.lineTo(topCenterX + topHalfW, topY);
    ctx.quadraticCurveTo(centerX + bottomHalfW * 0.4 + controlShift, controlY, centerX + bottomHalfW, bottomY);
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
    // its local tangent so they visually "aim" around the curve.
    const chevronCount = 4;
    for (let i = 0; i < chevronCount; i++) {
      const p = (i / chevronCount + this._flowPhase) % 1;
      const pt = this._pointOnPath(p, centerX, bottomY, topCenterX, topY, controlShift, controlY);
      const localWidth = bottomHalfW * (1 - p) + topHalfW * p;
      this._drawChevron(pt.x, pt.y, pt.angle, localWidth * 0.9, pathColor);
    }

    // Arrowhead at the top of the path, pointing further into the turn.
    const tip = this._pointOnPath(1, centerX, bottomY, topCenterX, topY, controlShift, controlY);
    this._drawChevron(topCenterX, topY - 6, tip.angle, topHalfW * 2.2, pathColor, 1.4);
  }

  /** Point + tangent angle at parameter p (0=bottom, 1=top) along the quadratic curve used for the path's centerline. */
  _pointOnPath(p, x0, y0, x1, y1, controlShift, controlY) {
    const cx = (x0 + x1) / 2 + controlShift;
    const cy = controlY;
    const x = (1 - p) * (1 - p) * x0 + 2 * (1 - p) * p * cx + p * p * x1;
    const y = (1 - p) * (1 - p) * y0 + 2 * (1 - p) * p * cy + p * p * y1;
    const dx = 2 * (1 - p) * (cx - x0) + 2 * p * (x1 - cx);
    const dy = 2 * (1 - p) * (cy - y0) + 2 * p * (y1 - cy);
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
