/**
 * route-provider.js
 * -----------------------------------------------------------------------
 * Fetches a real walking route between two points from an open routing
 * service, and geocodes free-text place names into coordinates — this is
 * what makes "any destination" outdoor navigation possible, instead of
 * only routing between hand-calibrated waypoints.
 *
 * TWO HONEST CAVEATS, please read before trusting this for real guidance:
 *
 * 1. OSRM's free public demo server's foot/walking support is genuinely
 *    disputed. The official docs say it serves car+foot+bike profiles;
 *    independent developer reports (OpenStreetMap's own help forum,
 *    GitHub issues) say the public demo only actually holds car-routing
 *    data and silently returns driving-style routes for foot requests.
 *    This file defaults to OSRM because it needs zero setup, but VERIFY
 *    early that the routes/times you get back look like walking, not
 *    driving — if not, switch `DEFAULT_PROVIDER` below to 'ors' and get a
 *    free OpenRouteService API key (openrouteservice.org/sign-up), which
 *    has an unambiguous dedicated walking profile.
 *
 * 2. A route is only as good as the map data it's routing over.
 *    OpenStreetMap very often does NOT have internal campus footpaths
 *    mapped, even when it has the surrounding public roads — this is a
 *    well-documented, common gap. If your campus's internal paths aren't
 *    mapped, any router (this, Google, anything) will route along the
 *    nearest mapped ROAD instead of the real walking path, which is a
 *    real safety concern for a mobility aid, not a cosmetic issue. Fix:
 *    add the real paths at openstreetmap.org (free account, iD editor,
 *    trace the paths you actually walk) — after that, routing through
 *    them works immediately, here and in any other OSM-based router.
 *    `checkRouteSanity()` below does a rough automated check for routes
 *    that look suspiciously indirect, but it can't catch every case.
 * -----------------------------------------------------------------------
 */

const DEFAULT_PROVIDER = 'osrm'; // 'osrm' (no key, disputed foot support) | 'ors' (needs free API key, reliable walking profile)

class RouteProvider {
  constructor({ provider = DEFAULT_PROVIDER, orsApiKey = null } = {}) {
    this.provider = provider;
    this.orsApiKey = orsApiKey;
  }

  /**
   * Returns { points: [[lat,lon], ...], distanceMeters, durationSeconds, steps }
   * or null if no route could be found / the request failed.
   * `steps` (when available) are OSRM/ORS's own turn-by-turn maneuver text,
   * more reliable for real road-based routing than computing turn labels
   * from bearing deltas ourselves.
   */
  async getWalkingRoute(from, to) {
    try {
      if (this.provider === 'ors') return await this._getRouteOrs(from, to);
      return await this._getRouteOsrm(from, to);
    } catch (err) {
      console.warn('Route fetch failed:', err);
      return null;
    }
  }

  async _getRouteOsrm(from, to) {
    const url = `https://router.project-osrm.org/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}` +
      `?geometries=geojson&overview=full&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) return null;

    const route = data.routes[0];
    const points = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]); // GeoJSON is [lon,lat]; we use [lat,lon] everywhere else
    const steps = (route.legs || []).flatMap((leg) =>
      (leg.steps || []).map((s) => ({
        instruction: describeOsrmManeuver(s.maneuver, s.name),
        distanceMeters: s.distance,
      }))
    );
    return { points, distanceMeters: route.distance, durationSeconds: route.duration, steps };
  }

  async _getRouteOrs(from, to) {
    if (!this.orsApiKey) throw new Error('OpenRouteService requires an API key (set orsApiKey).');
    const url = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.orsApiKey },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]] }),
    });
    if (!res.ok) throw new Error(`ORS HTTP ${res.status}`);
    const data = await res.json();
    const feature = data.features && data.features[0];
    if (!feature) return null;

    const points = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const summary = feature.properties.summary || {};
    const steps = (feature.properties.segments || []).flatMap((seg) =>
      (seg.steps || []).map((s) => ({ instruction: s.instruction, distanceMeters: s.distance }))
    );
    return { points, distanceMeters: summary.distance, durationSeconds: summary.duration, steps };
  }

  /**
   * Free-text place search via Nominatim (OpenStreetMap's geocoder).
   * Returns [{ label, lat, lon }, ...], best match first, or [] if nothing
   * found / the request failed. Usage-policy note: Nominatim's public
   * instance asks for max ~1 request/second and a descriptive User-Agent;
   * browsers can't set a custom User-Agent header, so the browser's
   * default is sent — fine for light use, but don't hammer this in a
   * loop, and self-host or use a paid geocoder for production traffic.
   */
  async geocode(query, { limit = 5, viewbox = null } = {}) {
    const params = new URLSearchParams({ q: query, format: 'json', limit: String(limit) });
    if (viewbox) params.set('viewbox', viewbox.join(','));
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((r) => ({ label: r.display_name, lat: parseFloat(r.lat), lon: parseFloat(r.lon) }));
    } catch (err) {
      console.warn('Geocode failed:', err);
      return [];
    }
  }
}

/** Turns an OSRM maneuver object into a short human instruction. Real turn types (roundabouts etc.) fall back to a generic phrase rather than guessing. */
function describeOsrmManeuver(maneuver, roadName) {
  const road = roadName ? ` onto ${roadName}` : '';
  switch (maneuver.type) {
    case 'depart': return `Head out${road}`;
    case 'arrive': return 'You have arrived';
    case 'turn':
      return `Turn ${maneuver.modifier || ''}${road}`.replace(/\s+/g, ' ').trim();
    case 'new name': return `Continue${road}`;
    case 'continue': return `Continue straight${road}`;
    default: return `Continue${road}`;
  }
}

/**
 * Rough automated sanity check: compares the route's actual distance to
 * the straight-line (as-the-crow-flies) distance. A huge ratio suggests
 * the router went a strange way — very possibly because it couldn't find
 * a direct path through unmapped campus footpaths and routed around via
 * public roads instead. This can't catch every bad route, just an
 * obviously suspicious one; always sanity-check unfamiliar routes.
 */
function checkRouteSanity(routeDistanceMeters, straightLineMeters) {
  if (straightLineMeters < 5) return { ok: true }; // too short to be meaningful
  const ratio = routeDistanceMeters / straightLineMeters;
  if (ratio > 3) {
    return {
      ok: false,
      reason: `The route is ${ratio.toFixed(1)}x longer than a straight line — it may be detouring via a road because the direct path isn't mapped yet.`,
    };
  }
  return { ok: true };
}

window.RouteProvider = RouteProvider;
window.checkRouteSanity = checkRouteSanity;
