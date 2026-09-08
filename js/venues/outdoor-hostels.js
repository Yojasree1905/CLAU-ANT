/**
 * venues/outdoor-hostels.js
 * -----------------------------------------------------------------------
 * Outdoor paths between Ladies Hostel blocks G, H, and J, covering all six
 * directions (G↔H, G↔J, H↔J). Unlike the indoor venues, NONE of the
 * coordinates below are guessed — every node starts with lat/lon = null
 * and stays that way until someone physically walks to it and captures a
 * real GPS reading via the in-app calibration tool (Settings → Outdoor
 * Calibration, or say "hey nav calibrate waypoints").
 *
 * The via-points between each pair of entrances are a *shape* guess, not
 * a coordinate guess — I don't know if the real path bends twice or five
 * times between, say, G and H. Three via-points per path is a reasonable
 * starting skeleton; add or remove nodes/edges below (and in the
 * calibration list) to match the actual path shape once you've walked it.
 * A node that's never calibrated just makes shortestPath() skip any edge
 * that needs it — it never gets treated as "close enough" or defaulted.
 *
 * HOW TO FILL THIS IN:
 * 1. Open the app outdoors, switch to "Outdoor — Hostel Paths".
 * 2. Open Settings → Outdoor Calibration.
 * 3. Walk to each waypoint in turn, tap "Capture here", wait for the
 *    sample count to finish (it averages several readings for accuracy).
 * 4. When done, tap "Export calibration" and paste the result into
 *    CALIBRATED_COORDS below, replacing the empty object.
 * 5. Commit and push — from then on everyone using the app has it.
 * -----------------------------------------------------------------------
 */
(function () {
  const { gpsNode, gpsEdge } = window.__venueHelpers;

  // Paste the output of the in-app "Export calibration" button here.
  // Format: { nodeId: { lat: <number>, lon: <number> }, ... }
  const CALIBRATED_COORDS = {
    // (empty until calibrated on-site)
  };

  const NODES = [
    gpsNode('hostel_g', 'Ladies Hostel G', ['hostel g', 'g hostel', 'g block', 'block g', 'ladies hostel g'], true),
    gpsNode('hostel_h', 'Ladies Hostel H', ['hostel h', 'h hostel', 'h block', 'block h', 'ladies hostel h'], true),
    gpsNode('hostel_j', 'Ladies Hostel J', ['hostel j', 'j hostel', 'j block', 'block j', 'ladies hostel j'], true),

    gpsNode('gh_via1', 'the path toward H, first bend', ['g h via one', 'gh waypoint one']),
    gpsNode('gh_via2', 'the path toward H, second bend', ['g h via two', 'gh waypoint two']),
    gpsNode('gh_via3', 'the path toward H, near H', ['g h via three', 'gh waypoint three']),

    gpsNode('gj_via1', 'the path toward J, first bend', ['g j via one', 'gj waypoint one']),
    gpsNode('gj_via2', 'the path toward J, second bend', ['g j via two', 'gj waypoint two']),
    gpsNode('gj_via3', 'the path toward J, near J', ['g j via three', 'gj waypoint three']),

    gpsNode('hj_via1', 'the path between H and J, first bend', ['h j via one', 'hj waypoint one']),
    gpsNode('hj_via2', 'the path between H and J, second bend', ['h j via two', 'hj waypoint two']),
    gpsNode('hj_via3', 'the path between H and J, near J', ['h j via three', 'hj waypoint three']),
  ];

  const EDGES = [
    gpsEdge('hostel_g', 'gh_via1'), gpsEdge('gh_via1', 'gh_via2'), gpsEdge('gh_via2', 'gh_via3'), gpsEdge('gh_via3', 'hostel_h'),
    gpsEdge('hostel_g', 'gj_via1'), gpsEdge('gj_via1', 'gj_via2'), gpsEdge('gj_via2', 'gj_via3'), gpsEdge('gj_via3', 'hostel_j'),
    gpsEdge('hostel_h', 'hj_via1'), gpsEdge('hj_via1', 'hj_via2'), gpsEdge('hj_via2', 'hj_via3'), gpsEdge('hj_via3', 'hostel_j'),
  ];

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
    defaultStart: null, // could be any of the three; the app always asks rather than assumes
    isOutdoor: true,
    nodes: NODES,
    edges: EDGES,
  });
})();
