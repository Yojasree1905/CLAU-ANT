/**
 * venues/sjt-7th-floor.js
 * Map of the SJT 7th floor corner, from the original photo/video set.
 * See venue-graph.js header for the calibration approach.
 */
(function () {
  const { n, e } = window.__venueHelpers;

  const NODES = [
    n('stairs', 'the staircase', ['stairs', 'stairway', 'steps'], 0.0, 0.0, false, true),
    n('lobby', 'the entrance lobby', ['lobby', 'entrance', 'entry'], 1.5, 0.5, false, false),
    n('room_711_712', 'rooms 711 and 712', ['711', '712', 'room 711', 'room 712', 'seven eleven', 'seven twelve'], 4.0, 2.0, true, false),
    n('faculty_cabins', 'the faculty cabins', ['faculty cabin', 'faculty cabins', 'staff room', 'professor cabin', 'professors cabin'], 2.0, 3.0, true, false),
    n('water_cooler', 'the water cooler', ['water cooler', 'drinking water', 'water dispenser'], 6.5, 1.5, false, false),
    n('washroom_women', "the women's washroom", ["women's washroom", 'womens washroom', 'ladies washroom', 'ladies room', '714', 'room 714'], 7.5, 1.5, true, false),
    n('room_715', 'room 715', ['715', 'room 715', 'seven fifteen'], 7.5, 2.6, true, false),
    n('open_corridor', 'the open corridor', ['open corridor', 'corridor', 'hallway', 'walking area'], 9.5, 3.5, false, false),
    n('corridor_end', 'the far end of the corridor', ['end of corridor', 'far end', 'last room'], 12.0, 4.0, true, false),
  ];

  const EDGES = [
    e('stairs', 'lobby', 2.0),
    e('lobby', 'faculty_cabins', 2.8),
    e('lobby', 'room_711_712', 3.2),
    e('room_711_712', 'water_cooler', 3.0),
    e('water_cooler', 'washroom_women', 1.2),
    e('washroom_women', 'room_715', 1.4),
    e('room_715', 'open_corridor', 2.5),
    e('open_corridor', 'corridor_end', 3.0),
  ];

  window.registerVenue({
    id: 'sjt7',
    label: 'SJT — 7th floor corner',
    defaultStart: 'stairs',
    nodes: NODES,
    edges: EDGES,
  });
})();
