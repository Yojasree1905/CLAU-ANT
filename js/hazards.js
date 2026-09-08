/**
 * hazards.js
 * -----------------------------------------------------------------------
 * Real-time obstacle warnings from the live camera feed.
 *
 * Object hazards (person, chair, table, and — for outdoor use — vehicles)
 * use TensorFlow.js's pretrained COCO-SSD model, same family as the
 * SSD-Lite MobileNetv2 detector described in build-status.md. COCO has no
 * "door" or "stairs" class, so:
 *   - Door state comes from the venue graph (nodes flagged isDoor) — the
 *     app announces "there should be a door ahead" from map data, which
 *     is far more reliable than trying to vision-classify open/closed
 *     from COCO-SSD. `detectDoorState()` below is a stub: drop in the
 *     project's real geometric door/stairs detector (structure.js) here
 *     if you have it, to confirm state visually instead of just from
 *     the map.
 *   - Steps get a lightweight edge-density heuristic as a low-confidence
 *     fallback. Treat it as a hint, not a replacement for structure.js.
 *
 * Reaction-distance zones and priority weighting reuse the calibration
 * already tuned in the existing app (build-status.md "Key calibration"):
 *   critical ~1.5m, near ~2.5m, mid ~4.5m, far ~8m — approximated here
 * from bounding-box height as a fraction of frame height, since a single
 * phone camera has no depth sensor. NOTE: these thresholds were tuned for
 * indoor furniture at indoor distances — a car at typical road distance
 * fills far less of the frame than a chair at the same "close" distance,
 * so vehicle zone calls are a rougher approximation. Treat "critical" on
 * a vehicle as "it's in frame and looks close," not a precise measurement.
 *
 * TRAFFIC AWARENESS (new): a rolling count of vehicle-class detections
 * per tick, smoothed over a short window, classified into LOW/MEDIUM/HIGH.
 * This is a simple heuristic count of what's visible in the camera's
 * field of view, not a calibrated traffic-engineering metric — it answers
 * "does it look busy right now," which is what the "how's the traffic"
 * voice command needs, not more than that.
 * -----------------------------------------------------------------------
 */

const HAZARD_LABELS = new Set([
  'person', 'chair', 'dining table', 'couch', 'bench',
  'car', 'motorcycle', 'bus', 'bicycle', 'truck',
]);
const LABEL_SPOKEN_AS = {
  'dining table': 'table',
  person: 'person',
  chair: 'chair',
  couch: 'sofa',
  bench: 'bench',
  car: 'car',
  motorcycle: 'motorcycle',
  bus: 'bus',
  bicycle: 'bicycle',
  truck: 'truck',
};
const VEHICLE_CLASSES = new Set(['car', 'motorcycle', 'bus', 'bicycle', 'truck']);

// Bounding-box height / frame height thresholds, mapped to the app's
// existing reaction-distance zones. Tune per-phone during calibration.
const ZONE_THRESHOLDS = [
  { zone: 'critical', minHeightRatio: 0.55 },
  { zone: 'near', minHeightRatio: 0.32 },
  { zone: 'mid', minHeightRatio: 0.16 },
  { zone: 'far', minHeightRatio: 0.0 },
];

// Rough, adjustable thresholds for "how busy does this look" — average
// vehicle count in frame over the last TRAFFIC_WINDOW ticks.
const TRAFFIC_WINDOW = 5;
const TRAFFIC_THRESHOLDS = { low: 2, medium: 5 }; // < low -> LOW, < medium -> MEDIUM, else HIGH

function zoneFor(heightRatio) {
  for (const t of ZONE_THRESHOLDS) {
    if (heightRatio >= t.minHeightRatio) return t.zone;
  }
  return 'far';
}

function lateralGuidance(centerXRatio) {
  // centerXRatio in [0,1]; 0.5 = dead ahead
  if (centerXRatio < 0.4) return 'move slightly right';
  if (centerXRatio > 0.6) return 'move slightly left';
  return 'stop, or step around carefully';
}

function trafficLevelFor(avgCount) {
  if (avgCount < TRAFFIC_THRESHOLDS.low) return 'LOW';
  if (avgCount < TRAFFIC_THRESHOLDS.medium) return 'MEDIUM';
  return 'HIGH';
}

class HazardDetector {
  constructor({ videoEl, onHazard, onTrafficUpdate }) {
    this.videoEl = videoEl;
    this.onHazard = onHazard; // ({label, zone, guidance, priority}) => void
    this.onTrafficUpdate = onTrafficUpdate; // ({level, counts, totalVehicles}) => void
    this.model = null;
    this.running = false;
    this._vehicleCountHistory = [];
    this.latestSnapshot = { hazard: null, traffic: { level: 'LOW', counts: {}, totalVehicles: 0 }, timestamp: null };
  }

  async load() {
    // Loaded from CDN in index.html: window.cocoSsd
    this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  }

  start(fps = 4) {
    this.running = true;
    const interval = 1000 / fps;
    const loop = async () => {
      if (!this.running) return;
      await this._tick();
      setTimeout(loop, interval);
    };
    loop();
  }

  stop() {
    this.running = false;
  }

  async _tick() {
    if (!this.model || this.videoEl.readyState < 2) return;
    const predictions = await this.model.detect(this.videoEl);
    const w = this.videoEl.videoWidth;
    const h = this.videoEl.videoHeight;
    if (!w || !h) return;

    let worst = null; // pick the single highest-priority hazard per tick
    const vehicleCounts = { car: 0, motorcycle: 0, bus: 0, bicycle: 0, truck: 0 };

    for (const p of predictions) {
      if (VEHICLE_CLASSES.has(p.class) && p.score >= 0.5) vehicleCounts[p.class]++;
      if (!HAZARD_LABELS.has(p.class) || p.score < 0.55) continue;
      const [x, y, bw, bh] = p.bbox;
      const heightRatio = bh / h;
      const centerXRatio = (x + bw / 2) / w;
      const zone = zoneFor(heightRatio);
      const priority = ZONE_THRESHOLDS.findIndex((t) => t.zone === zone); // lower index = more urgent
      if (zone === 'far') continue; // not worth interrupting the user yet

      const candidate = {
        label: LABEL_SPOKEN_AS[p.class] || p.class,
        zone,
        centerXRatio,
        guidance: zone === 'critical' ? lateralGuidance(centerXRatio) : null,
        priority,
        isVehicle: VEHICLE_CLASSES.has(p.class),
      };
      if (!worst || candidate.priority < worst.priority) worst = candidate;
    }

    // Traffic level: smoothed over a short rolling window so a single
    // frame's miscount (or a car briefly leaving frame) doesn't flip the
    // reported level back and forth.
    const totalVehicles = Object.values(vehicleCounts).reduce((a, b) => a + b, 0);
    this._vehicleCountHistory.push(totalVehicles);
    if (this._vehicleCountHistory.length > TRAFFIC_WINDOW) this._vehicleCountHistory.shift();
    const avgVehicles = this._vehicleCountHistory.reduce((a, b) => a + b, 0) / this._vehicleCountHistory.length;
    const trafficInfo = { level: trafficLevelFor(avgVehicles), counts: vehicleCounts, totalVehicles };

    // Low-confidence "possible steps" hint from edge density (see file header).
    const stepsHint = this._stepsHeuristic();
    if (stepsHint && (!worst || worst.priority > 0)) {
      worst = { label: 'steps', zone: 'near', guidance: null, priority: 1, isHeuristic: true };
    }

    this.latestSnapshot = { hazard: worst, traffic: trafficInfo, timestamp: Date.now() };
    if (worst) this.onHazard(worst);
    if (this.onTrafficUpdate) this.onTrafficUpdate(trafficInfo);
  }

  /**
   * Rough, low-confidence heuristic: downsample the lower-center third of
   * the frame to grayscale and look for a high density of strong
   * horizontal luminance edges (stair nosings tend to produce repeated
   * horizontal contrast bands). This WILL false-positive on tiled floors
   * and skirting boards — it is a hint to slow down, not a confirmed
   * detection. Swap in the project's real structure.js geometric detector
   * for production accuracy.
   */
  _stepsHeuristic() {
    if (!this._scratch) {
      this._scratch = document.createElement('canvas');
      this._scratch.width = 40;
      this._scratch.height = 30;
    }
    const ctx = this._scratch.getContext('2d');
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return false;
    // sample lower-center third of frame
    ctx.drawImage(this.videoEl, vw * 0.25, vh * 0.55, vw * 0.5, vh * 0.4, 0, 0, 40, 30);
    const { data } = ctx.getImageData(0, 0, 40, 30);
    let edgeRows = 0;
    for (let row = 1; row < 30; row++) {
      let rowDiff = 0;
      for (let col = 0; col < 40; col++) {
        const i1 = (row * 40 + col) * 4;
        const i0 = ((row - 1) * 40 + col) * 4;
        const l1 = data[i1] + data[i1 + 1] + data[i1 + 2];
        const l0 = data[i0] + data[i0 + 1] + data[i0 + 2];
        rowDiff += Math.abs(l1 - l0);
      }
      if (rowDiff / 40 > 90) edgeRows++;
    }
    return edgeRows >= 5; // several distinct horizontal bands
  }

  /** Stub: wire in a real geometric door detector here if available. */
  async detectDoorState(_videoEl) {
    return 'unknown';
  }
}

window.HazardDetector = HazardDetector;
