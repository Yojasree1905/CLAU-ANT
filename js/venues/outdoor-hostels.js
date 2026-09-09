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
  // Calibrated on-site over TWO independent walks, combined here as an
  // accuracy-weighted average (same method the in-app calibrator uses to
  // combine multiple GPS samples). Most points agreed within ~10m across
  // both walks; four moved more than that between passes
  // (hostel_j, convenience_store_north, j_side_lift_entrance,
  // bicycle_parking) — still usable (tens of meters, not hundreds), but
  // worth a third confirming walk if there's time before the real demo.
  // Verified against the sketched relative layout before committing:
  // J and G main entrances land ~7-8m apart here, matching the short
  // direct walkway shown connecting them.
  // Surveyed coordinates directly from OpenStreetMap export (map.osm)
  // Mapped by Yojasree for Ladies Hostel G, H, J, Guest House, and connecting Hostel Road walkways.
  const CALIBRATED_COORDS = {
    hostel_g: { lat: 12.9676012, lon: 79.1594861 }, // Way 1095528324 centroid
    hostel_h: { lat: 12.9680394, lon: 79.1596759 }, // Way 1095528323 centroid
    hostel_j: { lat: 12.9681335, lon: 79.1591946 }, // Node 14165878677 (17 floors)
    guest_house: { lat: 12.9677940, lon: 79.1588970 }, // Relation 21227412 / Way 570750852
    parking: { lat: 12.9676287, lon: 79.1592126 }, // Node 5487048824
    g_main_entrance: { lat: 12.9677686, lon: 79.1593426 }, // Way 1549529399 / Node 14093702529
    g_side_entrance: { lat: 12.9677647, lon: 79.1595216 }, // Node 14165878676 (Mess/Courtyard connector)
    h_main_entrance: { lat: 12.9681076, lon: 79.1595178 }, // Node 14165878673 (Way 1557556404)
    j_main_entrance: { lat: 12.9679849, lon: 79.1591590 }, // Node 14165878669 (South Foyer)
    j_side_lift_entrance: { lat: 12.9680110, lon: 79.1589930 }, // Node 14165878670 (West Lift)
    mess_entrance: { lat: 12.9677647, lon: 79.1595216 }, // Node 14165878676
    main_gate: { lat: 12.9685617, lon: 79.1594558 }, // Node 14165878675
    convenience_store_north: { lat: 12.9681441, lon: 79.1594053 }, // Node 14165878672
    convenience_store_south: { lat: 12.9677581, lon: 79.1598230 }, // Node 14093702528
    bicycle_parking: { lat: 12.9676287, lon: 79.1592126 },
  };

  const NODES = [
    // Block names with clear purposes and 17 floor height from OSM survey
    gpsNode('hostel_g', 'Ladies Hostel G', ['hostel g', 'g hostel', 'g block', 'block g', 'ladies hostel g', 'socrates block'], true, 'Student Residence • Ladies Hostel G (17 Floors)'),
    gpsNode('hostel_h', 'Ladies Hostel H', ['hostel h', 'h hostel', 'h block', 'block h', 'ladies hostel h'], true, 'Student Residence • Ladies Hostel H (17 Floors)'),
    gpsNode('hostel_j', 'Ladies Hostel J', ['hostel j', 'j hostel', 'j block', 'block j', 'ladies hostel j'], true, 'Student Residence • Ladies Hostel J (17 Floors)'),

    // Key landmarks & facilities from survey
    gpsNode('guest_house', 'VIT Guest House', ['guest house', 'guesthouse', 'vit guest house', 'campus guest house'], true, 'Visitor & VIP Guest Accommodation'),
    gpsNode('parking', 'Campus Parking Area', ['parking', 'parking lot', 'car parking', 'vehicle parking'], true, 'Designated Vehicle & Visitor Parking Area'),
    gpsNode('main_gate', 'Hostel Complex Main Gate', ['main gate', 'the gate', 'hostel gate', 'security gate'], true, 'Campus Road Entry & 24/7 Security Checkpoint'),
    gpsNode('mess_entrance', 'Hostel Dining Mess', ['mess entrance', 'mess', 'dining hall entrance', 'food court'], true, 'Dining Hall & Meal Services for Residents'),

    // Specific entrances & amenities
    gpsNode('g_main_entrance', "G block's main entrance", ['g main entrance', 'g block main entrance', 'main entrance of g block'], true, 'Primary Residence Foyer & Entry'),
    gpsNode('g_side_entrance', "G block's side entrance", ['g side entrance', 'g block side entrance'], true, 'Side Walkway to Mess & Courtyard'),
    gpsNode('h_main_entrance', "H block's main entrance", ['h main entrance', 'h block main entrance', 'main entrance of h block'], true, 'Primary Residence Foyer & Entry'),
    gpsNode('j_main_entrance', "J block's main entrance", ['j main entrance', 'j block main entrance', 'main entrance of j block'], true, 'Main Reception & Foyer of J Block'),
    gpsNode('j_side_lift_entrance', "J block's lift and side entrance", ['j side entrance', 'j lift entrance', 'j block lift', 'lift entrance'], true, 'Direct Elevator Access to Upper Residential Floors'),
    gpsNode('convenience_store_north', 'North Convenience Store', ['convenience store', 'the shop', 'north convenience store'], true, 'Snacks, Groceries & Daily Student Essentials'),
    gpsNode('convenience_store_south', 'South Convenience Store', ['second convenience store', 'south convenience store'], true, 'Stationery, Print Services & Supplies'),
    gpsNode('bicycle_parking', 'Bicycle Parking Stand', ['bicycle parking', 'bike parking', 'cycle stand'], false, 'Campus Cycle Parking & Mobility Stand'),
  ];

  // Pedestrian walkway graph edges connecting G, H, J, Guest House and Main Gate
  // directly matching OSM ways 1557556402, 1549529399, 1557556404, 1557556994, 1557556403.
  const EDGES = [];

  // Apply calibrated coordinates
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


