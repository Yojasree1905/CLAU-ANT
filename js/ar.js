/**
 * ar.js — Augmented Reality Building & Landmark Inspector
 * -----------------------------------------------------------------------
 * Replaces synthetic ground ribbons with TRUE LOCATION-BASED AR ANCHORING:
 *
 * 1. BUILDING ANCHORS & PURPOSE OVERLAYS:
 *    When you point your camera at or near a building:
 *    - Projects a floating AR label card positioned over the real building structure.
 *    - Displays: Building Name, Distance (m), and Main Purpose / Function.
 *    - Downward-pointing arrow/beacon points directly at the physical building.
 *    - Highlights active navigation destinations with glowing emerald/gold accents.
 *    - If destination is behind or off-screen, draws edge guidance arrows (◀ / ▶)
 *      telling the user which way to turn.
 *
 * 2. OUTLINING AR:
 *    Bounding boxes around detected people, vehicles, and hazards from hazards.js.
 *
 * 3. LANDMARK AMBIENT BUBBLES:
 *    Ambient "You might be near X" detection pills.
 * -----------------------------------------------------------------------
 */

const DEFAULT_FOV_H = 60; // horizontal camera field of view in degrees
const MAX_BUILDING_REVEAL_DIST = 400; // max meters to render AR building cards

class ArOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Heading and orientation
    this.heading = null;
    this.hasLiveHeading = false;

    // Location & buildings
    this.currentLat = null;
    this.currentLon = null;
    this.nearbyBuildings = [];
    this.activeDestination = null; // { name, lat, lon }
    this.routeDistanceMeters = null;

    // Detected obstacle bounding boxes
    this.detectedObjects = [];
    this.detectedVideoSize = { w: 1, h: 1 };

    // Ambient bubble and debug
    this.bubbleText = null;
    this.debugInfo = null;

    // Rendering params
    this.dpr = window.devicePixelRatio || 1;
    this.fovH = DEFAULT_FOV_H;
    this._bobPhase = 0;
    this._rafId = null;

    this._onOrientation = this._onOrientation.bind(this);
  }

  setDpr(dpr) { this.dpr = dpr; }
  setFov(h) { this.fovH = h || DEFAULT_FOV_H; }

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
   * Updates user's current GPS location and list of buildings in the area.
   */
  setNearbyBuildings(buildings, lat, lon) {
    this.nearbyBuildings = Array.isArray(buildings) ? buildings : [];
    this.currentLat = lat;
    this.currentLon = lon;
  }

  /**
   * Sets the active navigation target for highlight & edge-of-screen guidance.
   */
  setActiveDestination(destName, lat, lon, distanceMeters) {
    if (!destName) {
      this.activeDestination = null;
      this.routeDistanceMeters = null;
      return;
    }
    this.activeDestination = { name: destName, lat, lon };
    this.routeDistanceMeters = distanceMeters;
  }

  clearActiveDestination() {
    this.activeDestination = null;
    this.routeDistanceMeters = null;
  }

  setDetectedObjects(boxes, vw, vh) {
    this.detectedObjects = boxes || [];
    this.detectedVideoSize = { w: vw, h: vh };
  }

  showBubble(text)   { this.bubbleText = text; }
  clearBubble()      { this.bubbleText = null; }
  setDebugInfo(text) { this.debugInfo = text; }

  // Backward-compatible stubs so existing app calls don't crash
  setRoute(polyline, lat, lon, destLabel, dist) {
    this.currentLat = lat;
    this.currentLon = lon;
    if (destLabel && polyline && polyline.length) {
      const destPt = polyline[polyline.length - 1];
      this.setActiveDestination(destLabel, destPt[0], destPt[1], dist);
    }
  }
  clearRoute() { this.clearActiveDestination(); }
  setTarget() {}
  setPath() {}
  clearTarget() { this.clearActiveDestination(); }

  _onOrientation(e) {
    if (typeof e.webkitCompassHeading === 'number') {
      this.heading = e.webkitCompassHeading;
      this.hasLiveHeading = true;
    } else if (e.absolute && e.alpha !== null) {
      this.heading = (360 - e.alpha) % 360;
      this.hasLiveHeading = true;
    } else if (e.alpha !== null) {
      this.heading = (360 - e.alpha) % 360;
      this.hasLiveHeading = true;
    }
  }

  _raf() {
    this._draw();
    this._bobPhase = (this._bobPhase + 0.035) % (Math.PI * 2);
    this._rafId = requestAnimationFrame(() => this._raf());
  }

  // ------------------------------------------------------------------
  // Main Render Frame
  // ------------------------------------------------------------------
  _draw() {
    const { ctx, canvas } = this;
    const dpr = this.dpr || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const topOffset = (document.getElementById('top-bar')?.offsetHeight || 64) + 12;
    const botOffset = (document.getElementById('voice-hub')?.offsetHeight || 130) + 12;

    // 1. Ambient landmark bubble
    if (this.bubbleText) {
      this._drawBubble(w, topOffset);
    }

    // 2. Obstacle detection outlines
    if (this.detectedObjects?.length) {
      this._drawDetectionOutlines(w, h);
    }

    // 3. Debug readout
    if (this.debugInfo) {
      this._drawDebugInfo(w, h);
    }

    // 4. AR Building Labels & Pointing Arrows
    this._drawBuildingOverlays(w, h, topOffset, botOffset);

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // AR Building Labels & Arrow Overlays
  // ------------------------------------------------------------------
  _drawBuildingOverlays(w, h, topOffset, botOffset) {
    if (this.currentLat === null || this.currentLon === null) return;

    // Resolve heading: if live compass isn't reporting, align with active destination
    let heading = this.heading;
    if (heading === null) {
      if (this.activeDestination && this.activeDestination.lat != null) {
        heading = _initialBearing(this.currentLat, this.currentLon, this.activeDestination.lat, this.activeDestination.lon);
      } else {
        heading = 0;
      }
    }
    const halfFov = this.fovH / 2;

    // RULE 1: If navigating to a destination, FOCUS ONLY ON THE DESTINATION!
    // Never clutter the view with 10 other buildings when the user has an active route.
    let candidates = [];
    if (this.activeDestination && this.activeDestination.lat != null) {
      candidates = [{
        name: this.activeDestination.name,
        lat: this.activeDestination.lat,
        lon: this.activeDestination.lon,
        purpose: 'Target Destination',
        isDestination: true,
      }];
    } else {
      // Free exploration mode: only consider buildings within 75 meters!
      candidates = this.nearbyBuildings.filter(b => {
        if (!b.lat || !b.lon) return false;
        const d = _haversine(this.currentLat, this.currentLon, b.lat, b.lon);
        return d <= 75; // strict distance filter
      });
    }

    // Calculate screen projection for each candidate
    const visibleCards = [];
    let destOffScreenSide = null; // 'left' or 'right' if destination is out of FOV
    let destOffScreenAngle = 0;

    for (const b of candidates) {
      if (!b.lat || !b.lon) continue;
      const dist = _haversine(this.currentLat, this.currentLon, b.lat, b.lon);

      const bearing = _initialBearing(this.currentLat, this.currentLon, b.lat, b.lon);
      let rel = bearing - heading;
      rel = ((rel + 540) % 360) - 180; // -180 to 180

      const isDest = this.activeDestination && (
        b.name === this.activeDestination.name || b.isDestination
      );

      // Check if inside camera horizontal FOV
      if (Math.abs(rel) <= halfFov * 1.05) {
        const screenX = w / 2 + (rel / halfFov) * (w / 2);

        // Position comfortably in mid-viewport, away from top-bar and mini-map
        const usableH = h - topOffset - botOffset;
        const screenY = topOffset + usableH * 0.46 + Math.sin(this._bobPhase) * 3;

        visibleCards.push({
          building: b,
          dist,
          x: screenX,
          y: screenY,
          isDest,
        });
      } else if (isDest) {
        // Destination is outside FOV — track which side to show turn arrow
        destOffScreenSide = rel > 0 ? 'right' : 'left';
        destOffScreenAngle = Math.abs(Math.round(rel));
      }
    }

    // Sort by distance (closest first)
    visibleCards.sort((a, b) => a.dist - b.dist);

    // RULE 2: Declutter & prevent stacking.
    // If two cards are horizontally close (within 150px), keep ONLY the closer one!
    const filteredCards = [];
    for (const card of visibleCards) {
      if (filteredCards.length >= 2) break; // at most 2 cards on screen at any time!
      const overlaps = filteredCards.some(existing => Math.abs(existing.x - card.x) < 160);
      if (!overlaps) {
        filteredCards.push(card);
      }
    }

    // Render each building card and arrow
    for (const item of filteredCards) {
      this._drawSingleBuildingCard(item, w, h);
    }

    // If destination is off-screen, render turn indicator arrow
    if (destOffScreenSide && this.activeDestination) {
      this._drawOffScreenTurnGuide(destOffScreenSide, destOffScreenAngle, w, h);
    }
  }

  _drawSingleBuildingCard(item, screenW, screenH) {
    const { ctx } = this;
    const { building, dist, x, y, isDest } = item;

    const title = building.name || 'Building';
    const purpose = building.purpose || 'Campus Facility & Structure';
    const distText = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`;

    // Calculate dimensions
    ctx.save();
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const titleW = ctx.measureText(title).width;
    const badgeW = ctx.measureText(distText).width + 12;

    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const purposeW = ctx.measureText(purpose).width;

    const cardW = Math.max(160, Math.max(titleW + badgeW + 30, purposeW + 24));
    const cardH = 54;
    const cardX = Math.max(12, Math.min(screenW - cardW - 12, x - cardW / 2));
    const cardY = y - cardH - 16; // positioned above the arrow anchor

    // ---- 1. Downward Pointing Beacon Arrow ----
    const arrowTipX = x;
    const arrowTipY = y;
    const arrowBaseY = cardY + cardH;

    ctx.beginPath();
    ctx.moveTo(arrowTipX, arrowTipY);
    ctx.lineTo(arrowTipX - 7, arrowBaseY);
    ctx.lineTo(arrowTipX + 7, arrowBaseY);
    ctx.closePath();
    ctx.fillStyle = isDest ? '#10b981' : '#00e5cc';
    ctx.fill();

    // Pulsing target dot at arrow tip
    ctx.beginPath();
    ctx.arc(arrowTipX, arrowTipY, 4, 0, Math.PI * 2);
    ctx.fillStyle = isDest ? '#34d399' : '#38bdf8';
    ctx.fill();

    // ---- 2. Glassmorphic Card Container ----
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;

    // Background box
    _roundRect(ctx, cardX, cardY, cardW, cardH, 10);
    ctx.fillStyle = isDest
      ? 'rgba(6, 44, 34, 0.92)' // emerald tint for active destination
      : 'rgba(15, 23, 42, 0.88)'; // dark slate frosted
    ctx.fill();

    // Neon Accent Border
    ctx.lineWidth = isDest ? 2.2 : 1.4;
    ctx.strokeStyle = isDest ? '#10b981' : 'rgba(0, 229, 204, 0.75)';
    ctx.stroke();

    ctx.shadowBlur = 0; // reset shadow

    // ---- 3. Card Content ----
    // Title
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const icon = isDest ? '🎯 ' : '🏢 ';
    ctx.fillText(icon + title, cardX + 10, cardY + 9, cardW - badgeW - 20);

    // Distance Badge (pill in top right of card)
    const badgeX = cardX + cardW - badgeW - 8;
    const badgeY = cardY + 7;
    _roundRect(ctx, badgeX, badgeY, badgeW, 18, 9);
    ctx.fillStyle = isDest ? 'rgba(16, 185, 129, 0.3)' : 'rgba(59, 130, 246, 0.25)';
    ctx.fill();
    ctx.strokeStyle = isDest ? '#10b981' : '#38bdf8';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = isDest ? '#6ee7b7' : '#7dd3fc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(distText, badgeX + badgeW / 2, badgeY + 9);

    // Purpose line (bottom of card)
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(purpose, cardX + 10, cardY + 30, cardW - 20);

    ctx.restore();
  }

  _drawOffScreenTurnGuide(side, angleDeg, w, h) {
    const { ctx } = this;
    ctx.save();

    const isRight = side === 'right';
    const x = isRight ? w - 24 : 24;
    const y = h * 0.45;
    const arrow = isRight ? '▶' : '◀';

    // Glowing indicator pill
    ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
    _roundRect(ctx, isRight ? w - 90 : 10, y - 16, 80, 32, 16);
    ctx.fill();

    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${arrow} ${angleDeg}°`, isRight ? w - 50 : 50, y);

    ctx.restore();
  }

  // ------------------------------------------------------------------
  // Obstacle detection outlines & overlays
  // ------------------------------------------------------------------
  _videoToCanvas(x, y, canvasW, canvasH) {
    const { w: vw, h: vh } = this.detectedVideoSize;
    const scale = Math.max(canvasW / vw, canvasH / vh);
    const displayedW = vw * scale;
    const displayedH = vh * scale;
    const offsetX = (canvasW - displayedW) / 2;
    const offsetY = (canvasH - displayedH) / 2;
    return { x: x * scale + offsetX, y: y * scale + offsetY };
  }

  _drawDetectionOutlines(w, h) {
    const { ctx } = this;
    const ZONE_STYLE = {
      critical: { color: 'rgba(239, 68, 68, 0.95)', lineWidth: 3 },
      near:     { color: 'rgba(245, 158, 11, 0.90)', lineWidth: 2.5 },
      mid:      { color: 'rgba(16, 185, 129, 0.80)', lineWidth: 2 },
      far:      { color: 'rgba(148, 163, 184, 0.60)', lineWidth: 1.5 },
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

      ctx.font = '600 12px system-ui, sans-serif';
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
      ctx.restore();
    }
  }

  _drawBubble(w, topOffset) {
    const { ctx } = this;
    ctx.font = '600 14px system-ui, sans-serif';
    const paddingX = 16;
    const textWidth = ctx.measureText(this.bubbleText).width;
    const bubbleW = Math.min(textWidth + paddingX * 2, w - 32);
    const bubbleH = 32;
    const bx = (w - bubbleW) / 2;
    const by = topOffset;

    ctx.save();
    _roundRect(ctx, bx, by, bubbleW, bubbleH, 16);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.bubbleText, w / 2, by + bubbleH / 2 + 1);
    ctx.restore();
  }

  _drawDebugInfo(w, h) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 11px monospace';
    const text = this.debugInfo;
    const tw = ctx.measureText(text).width;
    const boxH = 20;
    const y = h - boxH - 10;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(8, y, tw + 14, boxH);
    ctx.fillStyle = '#34d399';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 14, y + boxH / 2 + 1);
    ctx.restore();
  }
}

// ------------------------------------------------------------------
// Geometry Helpers
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

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

window.ArOverlay = ArOverlay;
