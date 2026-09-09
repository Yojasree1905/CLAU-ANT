/**
 * route-provider.js
 * -----------------------------------------------------------------------
 * Fetches a real walking route between two GPS points from an open routing
 * service, and geocodes free-text place names into coordinates.
 *
 * Supported providers (set via Settings or DEFAULT_PROVIDER):
 *   'osrm'  — OSRM public demo. No key required. Walking support disputed
 *             (may return car routes). Good for quick testing.
 *   'ors'   — OpenRouteService. Free API key required. Unambiguously
 *             walking profile. Recommended for real use.
 *   'gmaps' — Google Maps Directions API. Requires a billing-enabled
 *             Google Cloud API key. Best real-world path coverage for
 *             Indian campuses. Set key via Settings → Routing.
 *
 * All providers return the same shape:
 *   { points: [[lat,lon], ...], distanceMeters, durationSeconds, steps }
 *
 * `points` is a DENSE polyline — all geometry vertices, not just
 * turn-by-turn waypoints — so the AR overlay can project the actual road
 * curve onto the camera, not just point at the next vertex.
 *
 * TWO HONEST CAVEATS (same as before, still true):
 *   1. OSRM public demo foot-routing reliability is disputed.
 *   2. Campus internal footpaths are often not in OSM. Fix: add them at
 *      openstreetmap.org. After that, OSM-based routers route through them
 *      immediately. Google Maps usually already has them.
 * -----------------------------------------------------------------------
 */

const DEFAULT_PROVIDER = 'ors';

class RouteProvider {
  constructor({ provider = DEFAULT_PROVIDER, orsApiKey = null, gmapsApiKey = null } = {}) {
    this.provider = provider;
    this.orsApiKey = orsApiKey;
    this.gmapsApiKey = gmapsApiKey;
  }

  setProvider(p) { this.provider = p; }
  setOrsKey(k)   { this.orsApiKey = k; }
  setGmapsKey(k) { this.gmapsApiKey = k; }

  /**
   * Returns { points: [[lat,lon], ...], distanceMeters, durationSeconds, steps }
   * or null on failure.
   * from / to: { lat, lon }
   */
  async getWalkingRoute(from, to) {
    try {
      if (this.provider === 'gmaps' && this.gmapsApiKey) {
        return await this._getRouteGmaps(from, to);
      }
      if (this.provider === 'ors' && this.orsApiKey) {
        return await this._getRouteOrs(from, to);
      }
      return await this._getRouteOsrm(from, to);
    } catch (err) {
      console.warn('Route fetch failed:', err);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // OSRM
  // ------------------------------------------------------------------
  async _getRouteOsrm(from, to) {
    const url =
      `https://router.project-osrm.org/route/v1/foot/` +
      `${from.lon},${from.lat};${to.lon},${to.lat}` +
      `?geometries=geojson&overview=full&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;

    const route = data.routes[0];
    // GeoJSON geometry is [lon,lat]; we use [lat,lon] everywhere else
    const points = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const steps = (route.legs || []).flatMap((leg) =>
      (leg.steps || []).map((s) => ({
        instruction: _describeOsrmManeuver(s.maneuver, s.name),
        distanceMeters: s.distance,
      }))
    );
    return { points, distanceMeters: route.distance, durationSeconds: route.duration, steps };
  }

  // ------------------------------------------------------------------
  // OpenRouteService
  // ------------------------------------------------------------------
  async _getRouteOrs(from, to) {
    // ORS migrated from api.openrouteservice.org → api.heigit.org (Directions V2)
    const url = 'https://api.heigit.org/ors/v2/directions/foot-walking/geojson';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.orsApiKey },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]] }),
    });
    if (!res.ok) throw new Error(`ORS HTTP ${res.status}`);
    const data = await res.json();
    const feature = data.features?.[0];
    if (!feature) return null;

    const points = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const summary = feature.properties.summary || {};
    const steps = (feature.properties.segments || []).flatMap((seg) =>
      (seg.steps || []).map((s) => ({ instruction: s.instruction, distanceMeters: s.distance }))
    );
    return { points, distanceMeters: summary.distance, durationSeconds: summary.duration, steps };
  }

  // ------------------------------------------------------------------
  // Google Maps Directions API
  // ------------------------------------------------------------------
  async _getRouteGmaps(from, to) {
    const params = new URLSearchParams({
      origin: `${from.lat},${from.lon}`,
      destination: `${to.lat},${to.lon}`,
      mode: 'walking',
      key: this.gmapsApiKey,
    });
    const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GMaps HTTP ${res.status}`);
    const data = await res.json();

    if (data.status !== 'OK' || !data.routes?.length) {
      console.warn('GMaps Directions:', data.status, data.error_message);
      return null;
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    // Decode the overview_polyline for a dense point set
    const points = _decodePolyline(route.overview_polyline.points);

    const steps = (leg.steps || []).map((s) => ({
      instruction: s.html_instructions.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      distanceMeters: s.distance.value,
    }));

    return {
      points,
      distanceMeters: leg.distance.value,
      durationSeconds: leg.duration.value,
      steps,
    };
  }

  // ------------------------------------------------------------------
  // Nominatim geocoding — free-text place name → {lat, lon}
  // ------------------------------------------------------------------
  async geocode(query, { limit = 5, viewbox = null } = {}) {
    const params = new URLSearchParams({ q: query, format: 'json', limit: String(limit) });
    if (viewbox) params.set('viewbox', viewbox.join(','));
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((r) => ({
        label: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
      }));
    } catch (err) {
      console.warn('Geocode failed:', err);
      return [];
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function _describeOsrmManeuver(maneuver, roadName) {
  const road = roadName ? ` onto ${roadName}` : '';
  switch (maneuver.type) {
    case 'depart':    return `Head out${road}`;
    case 'arrive':    return 'You have arrived';
    case 'turn':      return `Turn ${maneuver.modifier || ''}${road}`.replace(/\s+/g, ' ').trim();
    case 'new name':  return `Continue${road}`;
    case 'continue':  return `Continue straight${road}`;
    default:          return `Continue${road}`;
  }
}

/**
 * Decodes a Google Maps encoded polyline string into [[lat,lon], ...].
 * Algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function _decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lon = 0;

  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

/**
 * Rough sanity check: compare route distance to straight-line distance.
 * A ratio > 3 suggests the router went via roads because campus paths
 * aren't mapped yet.
 */
function checkRouteSanity(routeDistanceMeters, straightLineMeters) {
  if (straightLineMeters < 5) return { ok: true };
  const ratio = routeDistanceMeters / straightLineMeters;
  if (ratio > 3) {
    return {
      ok: false,
      reason: `The route is ${ratio.toFixed(1)}× longer than a straight line — ` +
        `it may be detouring via roads because the direct path isn't mapped yet.`,
    };
  }
  return { ok: true };
}

window.RouteProvider = RouteProvider;
window.checkRouteSanity = checkRouteSanity;
