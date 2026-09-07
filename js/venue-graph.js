/**
 * venue-graph.js
 * -----------------------------------------------------------------------
 * Generic engine — no building-specific data here. Each floor/venue gets
 * its own data file in js/venues/*.js (see sjt-7th-floor.js and
 * hblock-3rd-floor.js), which calls `registerVenue()` below.
 *
 * WHY EDITABLE COORDINATES, NOT A FIXED GRAPH:
 * Every venue's distances/bearings are *estimates* from photos/video, not
 * a survey. To calibrate: walk each edge once with a phone pedometer or a
 * tape measure and update `distance_m` in that venue's file. Bearings are
 * computed automatically from node (x, y) positions, so you only ever
 * touch coordinates, never bearings directly.
 *
 * Coordinate frame per venue: arbitrary local frame, meters, +x = "east"
 * along the direction first walked in that venue's video, +y = "north".
 * -----------------------------------------------------------------------
 */

function n(id, label, aliases, x, y, isDoor, isStairs) {
  return { id, label, aliases, x, y, isDoor: !!isDoor, isStairs: !!isStairs };
}
function e(a, b, distance_m) {
  return { a, b, distance_m };
}

class VenueGraph {
  constructor(nodes, edges) {
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.adjacency = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      const bearing = this._bearing(edge.a, edge.b);
      this.adjacency.get(edge.a).push({ to: edge.b, dist: edge.distance_m, bearing });
      this.adjacency.get(edge.b).push({ to: edge.a, dist: edge.distance_m, bearing: (bearing + 180) % 360 });
    }
  }

  _bearing(aId, bId) {
    const a = this.nodes.get(aId);
    const b = this.nodes.get(bId);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // 0deg = north(+y), 90deg = east(+x), matches compass convention
    let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
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

  /** Dijkstra shortest path. Returns {path:[ids], totalDist} or null. */
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

      for (const neighbor of this.adjacency.get(current)) {
        const alt = currentDist + neighbor.dist;
        if (alt < dist.get(neighbor.to)) {
          dist.set(neighbor.to, alt);
          prev.set(neighbor.to, current);
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
      const edge = this.adjacency.get(fromId).find((x) => x.to === toId);
      const turn = prevBearing === null ? 'start' : this._turnLabel(prevBearing, edge.bearing);
      legs.push({
        fromId,
        toId,
        toLabel: this.nodes.get(toId).label,
        bearing: edge.bearing,
        distance_m: edge.dist,
        turn,
        passesDoor: this.nodes.get(toId).isDoor,
        passesStairs: this.nodes.get(toId).isStairs,
      });
      prevBearing = edge.bearing;
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

function registerVenue({ id, label, defaultStart, nodes, edges }) {
  window.VENUES[id] = {
    id,
    label,
    defaultStart,
    graph: new VenueGraph(nodes, edges),
  };
}

window.VenueGraph = VenueGraph;
window.registerVenue = registerVenue;
window.__venueHelpers = { n, e };
