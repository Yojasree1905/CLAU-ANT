/**
 * venue-graph.js
 * -----------------------------------------------------------------------
 * Generic engine — no building-specific data here. Each floor/venue gets
 * its own data file in js/venues/*.js (see sjt-7th-floor.js and
 * hblock-3rd-floor.js), which calls `registerVenue()` below.
 *
 * WHY EDITABLE COORDINATES, NOT A FIXED GRAPH:
 * Every indoor venue's distances/bearings are *estimates* from photos/
 * video, not a survey. To calibrate: walk each edge once with a phone
 * pedometer or a tape measure and update `distance_m` in that venue's
 * file. Bearings are computed automatically from node (x, y) positions,
 * so you only ever touch coordinates, never bearings directly.
 *
 * Coordinate frame per indoor venue: arbitrary local frame, meters,
 * +x = "east" along the direction first walked in that venue's video,
 * +y = "north".
 *
 * OUTDOOR (GPS) VENUES work differently and more strictly: nodes carry
 * real (lat, lon) instead of local (x, y), and — critically — those
 * coordinates start as `null` and MUST be filled in by physically
 * standing at each waypoint and capturing a real GPS reading (see
 * js/gps-nav.js's calibration flow). This file will never fabricate or
 * fall back to a guessed coordinate for a GPS node: an edge between two
 * nodes that aren't both calibrated is simply treated as not existing,
 * so Dijkstra can never route through invented coordinates. For a tool
 * guiding someone who can't see the path, a wrong outdoor waypoint is a
 * safety issue, not a rounding error.
 * -----------------------------------------------------------------------
 */

function n(id, label, aliases, x, y, isDoor, isStairs) {
  return { id, label, aliases, x, y, isDoor: !!isDoor, isStairs: !!isStairs };
}
function e(a, b, distance_m) {
  return { a, b, distance_m };
}

/** GPS waypoint node — coordinates start uncalibrated (null) on purpose. */
function gpsNode(id, label, aliases, isDoor) {
  return { id, label, aliases, lat: null, lon: null, isDoor: !!isDoor, isStairs: false, isGps: true };
}
/** GPS edge — no fixed distance; it's computed live from whatever the current calibrated coordinates are. */
function gpsEdge(a, b) {
  return { a, b, distance_m: null };
}

const EARTH_RADIUS_M = 6371000;
function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

/** Great-circle distance in meters. Verified against the known London-Paris distance (~344km) and cardinal-direction test cases. */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial compass bearing (degrees, 0=north) from point 1 to point 2. */
function initialBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

class VenueGraph {
  constructor(nodes, edges) {
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.rawEdges = edges;
    // Connectivity only here — actual bearing/distance is computed lazily
    // in _edgeMetrics() so that recalibrating a GPS node's coordinates
    // mid-session (or after this graph was constructed) is reflected
    // immediately, without rebuilding the graph.
    this.adjacency = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      this.adjacency.get(edge.a).push(edge.b);
      this.adjacency.get(edge.b).push(edge.a);
    }
  }

  /**
   * Bearing + distance between two adjacent nodes, computed from whatever
   * coordinates they currently have. Returns null if the edge can't be
   * used right now — either an indoor edge with a hand-authored distance
   * (never null in practice), or a GPS edge where either endpoint hasn't
   * been calibrated yet. A null edge is treated as not existing by
   * shortestPath, so an uncalibrated waypoint can never silently produce
   * a fabricated direction.
   */
  _edgeMetrics(aId, bId) {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    if (a.isGps || b.isGps) {
      if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) return null;
      return {
        dist: haversineDistance(a.lat, a.lon, b.lat, b.lon),
        bearing: initialBearing(a.lat, a.lon, b.lat, b.lon),
      };
    }
    // Indoor local (x, y) mode
    const edgeData = this.rawEdges.find((e) => (e.a === aId && e.b === bId) || (e.a === bId && e.b === aId));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return { dist: edgeData ? edgeData.distance_m : undefined, bearing: deg };
  }

  /** Fuzzy-match a spoken phrase to a node id. Returns null if no confident match. */
  resolveDestination(phrase) {
    const text = phrase.toLowerCase().trim();
    let best = null;
    let bestScore = 0;
    for (const node of this.nodes.values()) {
      for (const alias of node.aliases) {
        const score = this._matchScore(text, alias.toLowerCase());
        if (score > bestScore) {
          bestScore = score;
          best = node.id;
        }
      }
    }
    return bestScore >= 0.5 ? best : null;
  }

  _matchScore(text, alias) {
    // Exact substring matches always outrank fuzzy ones, and among those,
    // a longer/more specific alias wins (e.g. "corridor turn" should beat
    // a bare "corridor" alias belonging to a different node).
    if (text.includes(alias)) return 1 + alias.length / 100;
    const tset = new Set(text.split(/\s+/));
    const aset = alias.split(/\s+/);
    const hits = aset.filter((tok) => tset.has(tok)).length;
    return hits / aset.length; // always < 1, so never beats a substring match
  }

  /** Dijkstra shortest path. Returns {path:[ids], totalDist} or null. Edges with unusable metrics (uncalibrated GPS nodes) are skipped entirely. */
  shortestPath(fromId, toId) {
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    for (const id of this.nodes.keys()) dist.set(id, Infinity);
    dist.set(fromId, 0);

    while (visited.size < this.nodes.size) {
      let current = null;
      let currentDist = Infinity;
      for (const [id, d] of dist) {
        if (!visited.has(id) && d < currentDist) {
          current = id;
          currentDist = d;
        }
      }
      if (current === null) break;
      if (current === toId) break;
      visited.add(current);

      for (const neighborId of this.adjacency.get(current)) {
        const metrics = this._edgeMetrics(current, neighborId);
        if (!metrics || metrics.dist === undefined) continue; // uncalibrated / unusable edge
        const alt = currentDist + metrics.dist;
        if (alt < dist.get(neighborId)) {
          dist.set(neighborId, alt);
          prev.set(neighborId, current);
        }
      }
    }

    if (!prev.has(toId) && fromId !== toId) return null;
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) {
      cur = prev.get(cur);
      if (cur === undefined) return null;
      path.unshift(cur);
    }
    return { path, totalDist: dist.get(toId) };
  }

  /**
   * Turn path node ids into a list of navigation legs, each with the
   * bearing to walk, distance in meters, and a human turn instruction
   * relative to the previous leg's bearing (first leg has no turn).
   */
  buildLegs(path) {
    const legs = [];
    let prevBearing = null;
    for (let i = 0; i < path.length - 1; i++) {
      const fromId = path[i];
      const toId = path[i + 1];
      const metrics = this._edgeMetrics(fromId, toId);
      if (!metrics) continue; // shouldn't happen if shortestPath already validated the route
      const turn = prevBearing === null ? 'start' : this._turnLabel(prevBearing, metrics.bearing);
      legs.push({
        fromId,
        toId,
        toLabel: this.nodes.get(toId).label,
        bearing: metrics.bearing,
        distance_m: metrics.dist,
        turn,
        passesDoor: this.nodes.get(toId).isDoor,
        passesStairs: this.nodes.get(toId).isStairs,
      });
      prevBearing = metrics.bearing;
    }
    return legs;
  }

  _turnLabel(prevBearing, newBearing) {
    let diff = newBearing - prevBearing;
    diff = ((diff + 540) % 360) - 180; // normalize to [-180,180]
    if (Math.abs(diff) < 20) return 'straight';
    if (diff >= 20 && diff < 120) return 'right';
    if (diff <= -20 && diff > -120) return 'left';
    return diff > 0 ? 'sharp-right' : 'sharp-left';
  }
}

// ---------------------------------------------------------------------
// Venue registry — each venue file (js/venues/*.js) calls registerVenue()
// once, in a <script> tag loaded after this file.
// ---------------------------------------------------------------------
window.VENUES = {}; // id -> { id, label, defaultStart, graph }

function registerVenue({ id, label, defaultStart, nodes, edges, isOutdoor }) {
  window.VENUES[id] = {
    id,
    label,
    defaultStart,
    isOutdoor: !!isOutdoor,
    graph: new VenueGraph(nodes, edges),
  };
}

window.VenueGraph = VenueGraph;
window.registerVenue = registerVenue;
window.__venueHelpers = { n, e, gpsNode, gpsEdge, haversineDistance, initialBearing };

