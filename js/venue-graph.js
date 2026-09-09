/**
 * venue-graph.js  (stripped — math utilities only)
 * -----------------------------------------------------------------------
 * The Dijkstra graph engine and hand-authored venue nodes/edges have been
 * removed. Routing is now done by route-provider.js (real walking routes
 * from OSRM / ORS / Google Maps), and destination discovery is handled
 * by map-discovery.js (Overpass API / Nominatim).
 *
 * What remains here:
 *   - Haversine distance + initial bearing math (used by ar.js, gps-nav.js,
 *     app.js for all GPS calculations)
 *   - registerVenue() and window.VENUES registry (still used by the outdoor
 *     hostel venue to register its named GPS anchor points)
 *   - gpsNode() / gpsEdge() helpers (used by outdoor-hostels.js)
 * -----------------------------------------------------------------------
 */

const EARTH_RADIUS_M = 6371000;
function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

/** Great-circle distance in meters. Verified against London–Paris (~344 km)
 *  and cardinal-direction test cases. */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial compass bearing (degrees, 0 = north, clockwise) from point 1 to point 2. */
function initialBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** GPS waypoint node — coordinates start uncalibrated (null) on purpose.
 *  Used by outdoor-hostels.js to register known named anchor points. */
function gpsNode(id, label, aliases, isDoor) {
  return { id, label, aliases: aliases || [], lat: null, lon: null, isDoor: !!isDoor, isGps: true };
}

function gpsEdge(a, b) {
  return { a, b, distance_m: null };
}

// Fuzzy-match a spoken phrase against a list of GPS nodes' aliases.
// Used by the outdoor venue to resolve "hostel g" → a calibrated GPS anchor
// before falling back to Overpass / Nominatim.
function resolveGpsNode(nodes, phrase) {
  const text = phrase.toLowerCase().trim();
  let best = null;
  let bestScore = 0;
  for (const node of nodes) {
    for (const alias of (node.aliases || [])) {
      const score = _matchScore(text, alias.toLowerCase());
      if (score > bestScore) { bestScore = score; best = node; }
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function _matchScore(text, alias) {
  if (text.includes(alias)) return 1 + alias.length / 100;
  const tset = new Set(text.split(/\s+/));
  const aset = alias.split(/\s+/);
  const hits = aset.filter((tok) => tset.has(tok)).length;
  return hits / aset.length;
}

// ---------------------------------------------------------------------
// Venue registry — outdoor-hostels.js calls registerVenue() once.
// No indoor venues any more; this registry exists solely for the outdoor
// GPS anchor set.
// ---------------------------------------------------------------------
window.VENUES = {};

function registerVenue({ id, label, nodes, edges, isOutdoor }) {
  window.VENUES[id] = {
    id,
    label,
    isOutdoor: !!isOutdoor,
    nodes,   // raw array of gpsNode objects
    edges,   // raw array of gpsEdge objects (empty for outdoor_hostels)
  };
}

window.registerVenue = registerVenue;
window.resolveGpsNode = resolveGpsNode;
window.__venueHelpers = { gpsNode, gpsEdge, haversineDistance, initialBearing };
