/**
 * venues/outdoor-hostels.js
 * -----------------------------------------------------------------------
 * Named anchor points for Ladies Hostel blocks G, H, and J, drawn from
 * hand-sketched maps of the actual entrances, roads, and landmarks (not
 * a generic guess) — main/side entrances per block, the shared mess
 * entrance, the main gate, both convenience stores, the guest house, and
 * bicycle parking. Outdoor routing itself is fetched live from an open
 * routing service (see js/route-provider.js), so the actual path SHAPE
 * between any two points comes from real map data, not something
 * authored here. What's here is just: given someone says "G block main
 * entrance" or "the guest house", what coordinate does that resolve to?
 *
 * As before, NONE of the coordinates below are guessed — every node
 * starts with lat/lon = null and stays that way until someone physically
 * walks to it and captures a real GPS reading via the in-app calibration
 * tool (Settings → Outdoor Calibration, or say "hey nav calibrate
 * waypoints"). Calibration is OPTIONAL for the block names themselves
 * (an uncalibrated "hostel g" still works — handleOutdoorDestinationRequest()
 * in app.js falls back to geocoding it via Nominatim), but the specific
 * entrances/landmarks below generally aren't distinct, findable places on
 * a public map, so THOSE really do need an on-site capture to be usable.
 *
 * Known relative layout, from the sketches (for context while calibrating,
 * not distances — nothing here is to scale):
 *   - J block's main entrance connects to G block's main entrance via a
 *     short direct walkway; J also has a separate lift/side entrance on
 *     the opposite side of the building.
 *   - G block's side entrance leads to a shared mess entrance, which also
 *     serves H block from the other side.
 *   - The main gate for the G/H/J hostel complex is on the opposite side
 *     from the guest house; several gates near the guest house are kept
 *     closed (marked on the sketch), so don't assume all mapped gates are
 *     usable routes.
 *
 * HOW TO CALIBRATE:
 * 1. Open the app outdoors, switch to "Outdoor — Hostel Paths".
 * 2. Open Settings → Outdoor Calibration.
 * 3. Stand at each point, tap "Capture here", wait for the sample count
 *    to finish (it averages several readings for accuracy).
 * 4. When done, tap "Export calibration" and paste the result into
 *    CALIBRATED_COORDS below, replacing the empty object.
 * 5. Commit and push — from then on everyone using the app has it.
 * -----------------------------------------------------------------------
 */
(function () {
  const { gpsNode } = window.__venueHelpers;

  // Paste the output of the in-app "Export calibration" button here.
  // Format: { nodeId: { lat: <number>, lon: <number> }, ... }
  // Calibrated on-site — verified against the sketched relative layout
  // before committing (e.g. J and G main entrances are ~7m apart here,
  // matching the short direct walkway shown connecting them).
  const CALIBRATED_COORDS = {
    hostel_g: { lat: 12.9681554, lon: 79.1593860 }, // accuracy ~10m, 5 samples
    j_main_entrance: { lat: 12.9682181, lon: 79.1594222 }, // accuracy ~13m, 5 samples
    g_side_entrance: { lat: 12.9680115, lon: 79.1594173 }, // accuracy ~7m, 5 samples
    g_main_entrance: { lat: 12.9682451, lon: 79.1594796 }, // accuracy ~14m, 5 samples
    hostel_j: { lat: 12.9683771, lon: 79.1594841 }, // accuracy ~8m, 5 samples
    convenience_store_north: { lat: 12.9677442, lon: 79.1596394 }, // accuracy ~14m, 5 samples
    hostel_h: { lat: 12.9679906, lon: 79.1594173 }, // accuracy ~19m, 5 samples
    j_side_lift_entrance: { lat: 12.9679915, lon: 79.1593436 }, // accuracy ~7m, 5 samples
    guest_house: { lat: 12.9678287, lon: 79.1593953 }, // accuracy ~15m, 5 samples
    convenience_store_south: { lat: 12.9678412, lon: 79.1595412 }, // accuracy ~33m, 5 samples
    bicycle_parking: { lat: 12.9679155, lon: 79.1598049 }, // accuracy ~6m, 5 samples
    main_gate: { lat: 12.9683245, lon: 79.1594908 }, // accuracy ~9m, 5 samples
    mess_entrance: { lat: 12.9677146, lon: 79.1596414 }, // accuracy ~8m, 5 samples
  };

  const NODES = [
    // Block names — broad, geocode-friendly fallback destinations.
    gpsNode('hostel_g', 'Ladies Hostel G', ['hostel g', 'g hostel', 'g block', 'block g', 'ladies hostel g', 'socrates block'], true),
    gpsNode('hostel_h', 'Ladies Hostel H', ['hostel h', 'h hostel', 'h block', 'block h', 'ladies hostel h'], true),
    gpsNode('hostel_j', 'Ladies Hostel J', ['hostel j', 'j hostel', 'j block', 'block j', 'ladies hostel j'], true),

    // Specific entrances from the sketch — these are the ones worth
    // calibrating precisely, since "the hostel" geocodes to a building
    // centroid, not a specific door.
    gpsNode('g_main_entrance', "G block's main entrance", ['g main entrance', 'g block main entrance', 'main entrance of g block'], true),
    gpsNode('g_side_entrance', "G block's side entrance", ['g side entrance', 'g block side entrance'], true),
    gpsNode('j_main_entrance', "J block's main entrance", ['j main entrance', 'j block main entrance', 'main entrance of j block'], true),
    gpsNode('j_side_lift_entrance', "J block's lift and side entrance", ['j side entrance', 'j lift entrance', 'j block lift', 'lift entrance'], true),
    gpsNode('mess_entrance', 'the mess entrance', ['mess entrance', 'mess', 'dining hall entrance'], true),

    // Other landmarks from the sketch.
    gpsNode('main_gate', 'the main gate for G, H and J hostels', ['main gate', 'the gate', 'hostel gate'], true),
    gpsNode('convenience_store_north', 'the convenience store near J block', ['convenience store', 'the shop', 'north convenience store'], true),
    gpsNode('convenience_store_south', 'the other convenience store', ['second convenience store', 'south convenience store'], true),
    gpsNode('guest_house', 'the guest house', ['guest house', 'guesthouse'], true),
    gpsNode('bicycle_parking', 'the bicycle parking area', ['bicycle parking', 'bike parking', 'cycle stand']),
  ];

  // No fixed edges — a route between any two points is fetched live via
  // route-provider.js instead of being authored here.
  const EDGES = [];

  // Apply any coordinates that have already been calibrated and pasted in above.
  for (const node of NODES) {
    const coords = CALIBRATED_COORDS[node.id];
    if (coords) {
      node.lat = coords.lat;
      node.lon = coords.lon;
    }
  }

  window.registerVenue({
    id: 'outdoor_hostels',
    label: 'Outdoor — Hostel Paths (G / H / J)',
    defaultStart: null, // GPS answers "where am I" directly outdoors; nothing to assume
    isOutdoor: true,
    nodes: NODES,
    edges: EDGES,
  });
})();


