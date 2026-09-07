/**
 * venues/hblock-3rd-floor.js
 * Map of the H Block 3rd floor dormitory wing, from the supplied photos
 * and walkthrough video. See venue-graph.js header for the calibration
 * approach — these coordinates are visual estimates, not a survey.
 *
 * Layout read from the footage: the lift, staircase, water cooler and a
 * common wash-basin area all sit together at one landing/hub; a long
 * dormitory corridor runs from that hub past a storage/pantry nook and a
 * common room (sofa) to a corridor turn, then further dormitory doors,
 * ending at a grille-enclosed balcony/drying area.
 */
(function () {
  const { n, e } = window.__venueHelpers;

  const NODES = [
    n('lift', 'the lift', ['lift', 'elevator', 'elevators'], 0.0, 0.0, false, false),
    n('stairs', 'the staircase', ['stairs', 'stairway', 'steps', 'staircase'], 1.0, -1.5, false, true),
    n('water_cooler', 'the water cooler', ['water cooler', 'drinking water', 'water dispenser'], 2.0, 1.5, false, false),
    n('washroom', 'the washroom', ['washroom', 'bathroom', 'toilet', 'restroom', 'wash area'], 2.8, 2.0, true, false),
    n('corridor_start', 'the main corridor', ['corridor', 'hallway', 'walking area', 'passage'], 3.0, 0.0, false, false),
    n('storage_pantry', 'the storage room', ['store room', 'storage', 'pantry', 'supplies room', 'utility room'], 5.5, 0.5, true, false),
    n('common_room', 'the common room', ['common room', 'sofa', 'sofa area', 'lounge', 'sitting area', 'tv room'], 8.0, 0.5, true, false),
    n('corridor_junction', 'the corridor turn', ['corridor turn', 'junction', 'the bend'], 11.0, 0.0, false, false),
    n('dormitory_rooms', 'the dormitory rooms', ['dormitory', 'dorm rooms', 'hostel rooms', 'my room', 'rooms', 'dormitories'], 13.5, 1.5, true, false),
    n('balcony', 'the balcony', ['balcony', 'drying area', 'terrace', 'clothesline', 'drying yard'], 17.0, 2.0, true, false),
  ];

  const EDGES = [
    e('lift', 'stairs', 2.0),
    e('lift', 'water_cooler', 2.5),
    e('water_cooler', 'washroom', 1.0),
    e('lift', 'corridor_start', 3.0),
    e('corridor_start', 'storage_pantry', 2.8),
    e('storage_pantry', 'common_room', 2.6),
    e('common_room', 'corridor_junction', 3.2),
    e('corridor_junction', 'dormitory_rooms', 3.0),
    e('dormitory_rooms', 'balcony', 4.0),
  ];

  window.registerVenue({
    id: 'hblock3',
    label: 'H Block — 3rd floor',
    defaultStart: 'lift',
    nodes: NODES,
    edges: EDGES,
  });
})();
