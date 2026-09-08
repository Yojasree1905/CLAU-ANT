/**
 * app.js — Voice Navigation Assistant Controller
 *
 * Drives the voice-first indoor assistant:
 *   - Continuous ambient speech recognition and voice commands
 *   - Hands-free Dijkstra shortest-path turn-by-turn guidance
 *   - Dead-reckoning pedometer with customizable stride length
 *   - Slide-out Left Sidebar for all settings, venues, and destination directory
 *   - Real-time obstacle warnings & high-DPI AR directional overlay
 */

const state = {
  phase: 'unstarted', // unstarted | idle | navigating | arrived
  venueId: null,
  currentNodeId: null, // confirmed "you are here" node — replaces the old
                        // hardcoded defaultStart assumption. null until the
                        // user confirms it (by voice or tap), since they may
                        // be starting from anywhere on the floor.
  pendingDestination: null, // destination the user asked for before we knew
                             // where they were starting from
  legs: [],
  legIndex: 0,
  distanceWalkedOnLeg: 0,
  stepCount: 0,
  lastAccelMag: 0,
  lastStepAt: 0,
  lastMotionEventAt: null, // diagnostic: last time ANY devicemotion event fired, regardless of step threshold
  isAssistantRunning: false,
  lastAnnouncedLandmark: null, // for the ambient "you're near X" bubble
  outdoorPosition: null, // last known GPS fix, {lat, lon, accuracy, timestamp}
  outdoorRoute: null, // active outdoor route: {points, pointIndex, destLabel, totalDistance, steps}
  latestTraffic: null, // most recent traffic snapshot from the hazard detector
};

let localizer = null; // set once the camera is running (see startAssistant)
let gpsTracker = null; // outdoor live position tracking (see startAssistant)
let waypointCalibrator = null; // outdoor waypoint calibration tool (see startAssistant)
let routeProvider = null; // fetches real walking routes for outdoor navigation (see startAssistant)
let aiAssistant = null; // OpenAI "intelligence layer" for open-ended voice questions

const settings = {
  strideLengthM: 0.70,
  voiceRate: 1.0,
  audioChimes: true,
  hazardsEnabled: true,
};

const els = {};
let voice, ar, hazards, camStream;

window.addEventListener('DOMContentLoaded', init);

function currentVenue() {
  return window.VENUES[state.venueId];
}

function init() {
  // Load persisted settings
  try {
    const savedStride = localStorage.getItem('navassist_stride');
    if (savedStride) settings.strideLengthM = parseFloat(savedStride) || 0.70;
    const savedRate = localStorage.getItem('navassist_rate');
    if (savedRate) settings.voiceRate = parseFloat(savedRate) || 1.0;
    const savedChimes = localStorage.getItem('navassist_chimes');
    if (savedChimes !== null) settings.audioChimes = savedChimes === 'true';
    const savedHazards = localStorage.getItem('navassist_hazards');
    if (savedHazards !== null) settings.hazardsEnabled = savedHazards === 'true';
  } catch (_) {}

  // Cache elements
  els.video = document.getElementById('camera');
  els.overlay = document.getElementById('ar-canvas');
  els.currentVenueLabel = document.getElementById('current-venue-label');
  els.statusText = document.getElementById('status-text');
  els.indicatorText = document.getElementById('indicator-text');
  els.assistantIndicator = document.getElementById('assistant-indicator');
  els.subtitle = document.getElementById('subtitle');
  els.subtitleHud = document.getElementById('subtitle-hud');
  els.voiceHub = document.getElementById('voice-hub');
  els.voiceOrbWrapper = document.querySelector('.voice-orb-wrapper');
  els.micBtn = document.getElementById('mic-btn');
  els.voiceHint = document.getElementById('voice-hint');
  els.routeControls = document.getElementById('route-controls');
  els.repeatBtn = document.getElementById('repeat-btn');
  els.nextLegBtn = document.getElementById('next-leg-btn');
  els.stopBtn = document.getElementById('stop-btn');

  // Sidebar elements
  els.sidebar = document.getElementById('settings-sidebar');
  els.sidebarBackdrop = document.getElementById('sidebar-backdrop');
  els.sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  els.sidebarCloseBtn = document.getElementById('sidebar-close-btn');
  els.venuePicker = document.getElementById('venue-picker');
  els.destList = document.getElementById('dest-list');
  els.destFilter = document.getElementById('dest-filter');
  els.destCountBadge = document.getElementById('dest-count-badge');
  els.destSectionHeading = document.getElementById('dest-section-heading');
  els.destSectionDesc = document.getElementById('dest-section-desc');
  els.strideSlider = document.getElementById('stride-slider');
  els.strideVal = document.getElementById('stride-val');
  els.voiceRateSlider = document.getElementById('voice-rate-slider');
  els.voiceRateVal = document.getElementById('voice-rate-val');
  els.audioChimesToggle = document.getElementById('audio-chimes-toggle');
  els.hazardToggle = document.getElementById('hazard-toggle');
  els.testVoiceBtn = document.getElementById('test-voice-btn');
  els.openaiKeyInput = document.getElementById('openai-key-input');
  els.saveOpenaiKeyBtn = document.getElementById('save-openai-key-btn');
  els.openaiKeyStatus = document.getElementById('openai-key-status');
  els.calibrationSection = document.getElementById('calibration-section');
  els.calibrationList = document.getElementById('calibration-list');
  els.exportCalibrationBtn = document.getElementById('export-calibration-btn');
  els.calibrationExportOutput = document.getElementById('calibration-export-output');

  // Default to first venue
  const venueIds = Object.keys(window.VENUES);
  state.venueId = venueIds[0];

  // Initialize VoiceIO instance with Hey Nav wake word
  voice = new VoiceIO({
    onDestinationRequest: handleDestinationRequest,
    onStop: handleStopRequested,
    onRepeat: repeatCurrentLeg,
    onStatusRequest: announceCurrentStatus,
    onHelpRequest: announceHelp,
    onSettingsToggle: toggleSidebar,
    onStateChange: handleVoiceStateChange,
    onWakeWord: handleWakeWordDetected,
    onLocationSet: handleLocationSet,
    onNextRequested: forceAdvanceLeg,
    onCalibrateRequested: openCalibrationPanel,
    onAiQuery: handleAiQuery,
  });
  voice.rate = settings.voiceRate;
  voice.chimesEnabled = settings.audioChimes;

  // Initialize UI controls
  syncSettingsUI();
  renderVenuePicker();
  renderDestinationList();
  renderCalibrationSection();
  updateTopBadge();

  // Canvas setup
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Wire events
  els.micBtn.addEventListener('click', onMicTapped);
  els.repeatBtn.addEventListener('click', repeatCurrentLeg);
  els.nextLegBtn.addEventListener('click', forceAdvanceLeg);
  els.stopBtn.addEventListener('click', handleStopRequested);
  els.sidebarToggleBtn.addEventListener('click', () => toggleSidebar(true));
  els.sidebarCloseBtn.addEventListener('click', () => toggleSidebar(false));
  els.sidebarBackdrop.addEventListener('click', () => toggleSidebar(false));
  els.exportCalibrationBtn.addEventListener('click', handleExportCalibration);
  els.saveOpenaiKeyBtn.addEventListener('click', handleSaveOpenaiKey);

  // The OpenAI layer can be configured before the assistant is even
  // started — load any previously-saved key (device-local only, never
  // committed anywhere) right away.
  aiAssistant = new AiAssistant();
  const savedKey = localStorage.getItem('navassist_openai_key');
  if (savedKey) {
    aiAssistant.setApiKey(savedKey);
    els.openaiKeyInput.value = savedKey;
    els.openaiKeyStatus.textContent = 'Key loaded from this device.';
  } else {
    els.openaiKeyStatus.textContent = 'No key set — "what\'s ahead" and traffic questions won\'t work until one is added.';
  }

  // Keyboard accessibility (Escape closes sidebar)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.sidebar.classList.contains('active')) {
      toggleSidebar(false);
    }
  });

  // Destination live search
  els.destFilter.addEventListener('input', (e) => {
    filterDestinationList(e.target.value);
  });

  // Settings inputs
  els.strideSlider.addEventListener('input', (e) => {
    settings.strideLengthM = parseFloat(e.target.value);
    els.strideVal.textContent = `${settings.strideLengthM.toFixed(2)} m`;
    try { localStorage.setItem('navassist_stride', String(settings.strideLengthM)); } catch (_) {}
  });

  els.voiceRateSlider.addEventListener('input', (e) => {
    settings.voiceRate = parseFloat(e.target.value);
    voice.rate = settings.voiceRate;
    els.voiceRateVal.textContent = `${settings.voiceRate.toFixed(2)}x`;
    try { localStorage.setItem('navassist_rate', String(settings.voiceRate)); } catch (_) {}
  });

  els.audioChimesToggle.addEventListener('change', (e) => {
    settings.audioChimes = e.target.checked;
    voice.chimesEnabled = settings.audioChimes;
    try { localStorage.setItem('navassist_chimes', String(settings.audioChimes)); } catch (_) {}
  });

  els.hazardToggle.addEventListener('change', (e) => {
    settings.hazardsEnabled = e.target.checked;
    try { localStorage.setItem('navassist_hazards', String(settings.hazardsEnabled)); } catch (_) {}
    if (hazards) {
      if (settings.hazardsEnabled) hazards.start(4);
      else hazards.stop();
    }
  });

  els.testVoiceBtn.addEventListener('click', () => {
    voice.playChime('listen');
    voice.speak('Voice assistant volume and speed test. All systems ready.', {
      key: 'test-voice',
      interrupt: true,
    });
  });
}

function syncSettingsUI() {
  els.strideSlider.value = settings.strideLengthM;
  els.strideVal.textContent = `${settings.strideLengthM.toFixed(2)} m`;
  els.voiceRateSlider.value = settings.voiceRate;
  els.voiceRateVal.textContent = `${settings.voiceRate.toFixed(2)}x`;
  els.audioChimesToggle.checked = settings.audioChimes;
  els.hazardToggle.checked = settings.hazardsEnabled;
}

function toggleSidebar(open) {
  const shouldOpen = typeof open === 'boolean' ? open : !els.sidebar.classList.contains('active');
  els.sidebar.classList.toggle('active', shouldOpen);
  els.sidebarBackdrop.classList.toggle('active', shouldOpen);
  els.sidebarToggleBtn.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) {
    els.destFilter.focus();
  }
}

function updateTopBadge() {
  const venue = currentVenue();
  if (venue) {
    els.currentVenueLabel.textContent = venue.label.split('—')[0].trim();
  }
}

function renderVenuePicker() {
  els.venuePicker.innerHTML = '';
  for (const venue of Object.values(window.VENUES)) {
    const card = document.createElement('button');
    card.className = 'venue-card' + (venue.id === state.venueId ? ' active' : '');
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(venue.id === state.venueId));

    card.innerHTML = `
      <span>${venue.label}</span>
      <span class="card-check">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </span>
    `;

    card.addEventListener('click', () => {
      switchVenue(venue.id, { spoken: true });
      toggleSidebar(false);
    });
    els.venuePicker.appendChild(card);
  }
}

function switchVenue(venueId, { spoken = true } = {}) {
  if (!window.VENUES[venueId] || venueId === state.venueId) return;
  state.venueId = venueId;
  state.phase = 'idle';
  state.legs = [];
  state.currentNodeId = null; // a different floor invalidates any confirmed location
  state.pendingDestination = null;
  state.lastAnnouncedLandmark = null;
  state.outdoorRoute = null;
  ar && ar.clearTarget();
  ar && ar.clearBubble();
  els.routeControls.classList.add('hidden');
  stopGpsNavigation();
  renderVenuePicker();
  renderDestinationList();
  renderCalibrationSection();
  updateTopBadge();
  const label = currentVenue().label;
  setStatus(`Switched to ${label}. Ready for voice requests.`);
  if (voice) {
    voice.speak(spoken ? `Switched to ${label}.` : `Now using ${label}.`, {
      key: 'venue-switch',
      interrupt: true,
    });
  }
}

function renderDestinationList() {
  els.destList.innerHTML = '';
  const nodes = [...currentVenue().graph.nodes.values()];
  const locating = state.awaitingLocationConfirmation;
  els.sidebar.classList.toggle('locating', locating);

  els.destCountBadge.textContent = locating ? 'Tap where you are' : `${nodes.length} places`;
  if (els.destSectionHeading) {
    els.destSectionHeading.textContent = locating ? 'Where are you now?' : 'Known Destinations';
  }
  if (els.destSectionDesc) {
    els.destSectionDesc.textContent = locating
      ? 'Tap a place below, or say "hey nav I\'m at" and a place.'
      : 'Or speak: "Hey Nav, take me to [destination]"';
  }

  for (const node of nodes) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.innerHTML = `
      <span>${node.label}</span>
      <span class="item-arrow">${locating ? '📍' : '→'}</span>
    `;
    li.addEventListener('click', () => {
      if (locating) {
        toggleSidebar(false);
        handleLocationSet(node.label);
        return;
      }
      toggleSidebar(false);
      if (!state.isAssistantRunning) {
        startAssistant().then(() => handleDestinationRequest(node.label));
      } else {
        handleDestinationRequest(node.label);
      }
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        li.click();
      }
    });
    els.destList.appendChild(li);
  }
}

function filterDestinationList(query) {
  const q = query.toLowerCase().trim();
  const items = els.destList.querySelectorAll('li');
  let visibleCount = 0;
  items.forEach((item) => {
    const text = item.textContent.toLowerCase();
    const match = !q || text.includes(q);
    item.style.display = match ? 'flex' : 'none';
    if (match) visibleCount++;
  });
  els.destCountBadge.textContent = `${visibleCount} places`;
}

// ---------------------------------------------------------------------
// Outdoor GPS Waypoint Calibration UI
// ---------------------------------------------------------------------
// The only place in this app where an outdoor coordinate is ever set.
// Every value here comes from an actual navigator.geolocation reading
// taken while physically standing at the waypoint — nothing here invents
// or defaults a coordinate. See venue-graph.js and gps-nav.js headers.

function openCalibrationPanel() {
  if (!currentVenue().isOutdoor) {
    voice.speak('Calibration is only needed for the outdoor venue. Say "switch floor" to get to it.', {
      key: 'calibration-wrong-venue',
    });
    return;
  }
  toggleSidebar(true);
  els.calibrationSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  voice.speak('Outdoor calibration is open. Walk to a waypoint and tap Capture, or say its name.', {
    key: 'calibration-opened',
    interrupt: true,
  });
}

function renderCalibrationSection() {
  const isOutdoor = currentVenue().isOutdoor;
  els.calibrationSection.style.display = isOutdoor ? 'block' : 'none';
  if (!isOutdoor) return;

  const graph = currentVenue().graph;
  els.calibrationList.innerHTML = '';
  els.calibrationExportOutput.style.display = 'none';

  for (const node of graph.nodes.values()) {
    const calibrated = waypointCalibrator ? waypointCalibrator.isCalibrated(graph, node.id) : (node.lat !== null);
    const li = document.createElement('li');
    li.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);';
    li.innerHTML = `
      <span style="flex:1;">${calibrated ? '✅' : '⭕'} ${node.label}</span>
      <button class="pill-action-btn calib-capture-btn" data-node-id="${node.id}" style="padding:6px 10px; font-size:0.8rem;">
        ${calibrated ? 'Re-capture' : 'Capture here'}
      </button>
    `;
    els.calibrationList.appendChild(li);
  }

  els.calibrationList.querySelectorAll('.calib-capture-btn').forEach((btn) => {
    btn.addEventListener('click', () => captureWaypoint(btn.dataset.nodeId, btn));
  });
}

async function captureWaypoint(nodeId, buttonEl) {
  if (!waypointCalibrator) {
    voice.speak('The assistant needs to be started first.', { key: 'calibration-not-ready' });
    return;
  }
  const graph = currentVenue().graph;
  const node = graph.nodes.get(nodeId);
  if (!node) return;

  const originalText = buttonEl.textContent;
  buttonEl.disabled = true;

  const result = await waypointCalibrator.captureHere({
    samples: 5,
    intervalMs: 700,
    onProgress: (i, total) => {
      buttonEl.textContent = `Capturing ${i}/${total}…`;
    },
  });

  buttonEl.disabled = false;
  buttonEl.textContent = originalText;

  if (!result) {
    voice.speak(`Couldn't get a GPS reading for ${node.label}. Make sure location access is allowed and try again outdoors.`, {
      key: 'calibration-failed',
    });
    return;
  }

  waypointCalibrator.record(nodeId, result);
  waypointCalibrator.applyToGraph(graph); // usable immediately this session
  renderCalibrationSection();

  const accuracyNote = result.accuracy > 15
    ? ` GPS accuracy is only about ${Math.round(result.accuracy)} meters here — consider re-capturing in a more open spot.`
    : '';
  voice.speak(`Captured ${node.label}.${accuracyNote}`, { key: 'calibration-captured', interrupt: true });
}

function handleExportCalibration() {
  if (!waypointCalibrator || Object.keys(waypointCalibrator.captured).length === 0) {
    voice.speak('Nothing captured yet — walk to a waypoint and tap Capture first.', { key: 'export-empty' });
    return;
  }
  const snippet = waypointCalibrator.exportSnippet();
  els.calibrationExportOutput.value = snippet;
  els.calibrationExportOutput.style.display = 'block';
  els.calibrationExportOutput.focus();
  els.calibrationExportOutput.select();
  voice.speak('Calibration exported below. Copy it into the outdoor venue file to make it permanent.', {
    key: 'export-done',
    interrupt: true,
  });
}

// ---------------------------------------------------------------------
// Assistant Launch & Voice Button Interaction
// ---------------------------------------------------------------------

async function onMicTapped() {
  if (!state.isAssistantRunning) {
    await startAssistant();
    voice.triggerWakeMode();
  } else {
    voice.triggerWakeMode();
  }
}

async function startAssistant() {
  state.isAssistantRunning = true;
  setStatus('Starting camera & sensors…');
  els.voiceHint.textContent = 'Activating assistant…';

  await ArOverlay.requestPermission();
  await requestMotionPermission();

  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    els.video.srcObject = camStream;
    await els.video.play();
    localizer = new Localizer(els.video);
    startAmbientLandmarkWatch();
  } catch (err) {
    setStatus('Voice guidance active (no camera).');
  }

  resizeCanvas();

  ar = new ArOverlay(els.overlay);
  ar.start();

  window.addEventListener('devicemotion', onDeviceMotion);
  gpsTracker = new GpsTracker();
  waypointCalibrator = new WaypointCalibrator();
  routeProvider = new RouteProvider();

  voice.start();
  state.phase = 'idle';

  const venueName = currentVenue().label;
  voice.speak(
    `Assistant ready on ${venueName}. Say "Hey Nav" followed by your destination, or tap the mic.`,
    { key: 'ready', cooldownMs: 30000 }
  );

  setStatus('Say "Hey Nav" or tap mic');
  els.voiceHint.textContent = 'Say "Hey Nav" or tap mic to begin';

  if (camStream && settings.hazardsEnabled) {
    hazards = new HazardDetector({ videoEl: els.video, onHazard: handleHazard, onTrafficUpdate: handleTrafficUpdate });
    setStatus('Loading hazard detector…');
    await hazards.load();
    hazards.start(4);
    setStatus('Say "Hey Nav" or tap mic');
  }
}

async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      await DeviceMotionEvent.requestPermission();
    } catch (_) {}
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  els.overlay.width = Math.round(w * dpr);
  els.overlay.height = Math.round(h * dpr);
  els.overlay.style.width = `${w}px`;
  els.overlay.style.height = `${h}px`;
  if (ar) {
    ar.setDpr(dpr);
  }
}

// ---------------------------------------------------------------------
// Voice State UI Coordination & Wake Word Handling
// ---------------------------------------------------------------------

function handleWakeWordDetected() {
  els.assistantIndicator.className = 'indicator-pill state-listening';
  els.indicatorText.textContent = '"Hey Nav"';
  els.voiceOrbWrapper.className = 'voice-orb-wrapper listening';
  els.voiceHint.textContent = '⚡ "Hey Nav" heard — listening for command…';
}

function handleVoiceStateChange(assistantState) {
  // Update indicator pill
  els.assistantIndicator.className = `indicator-pill state-${assistantState}`;
  
  if (assistantState === 'listening') {
    els.voiceOrbWrapper.className = 'voice-orb-wrapper listening';
    els.indicatorText.textContent = 'Listening';
    els.voiceHint.textContent = state.phase === 'navigating' ? 'Listening for commands…' : 'Listening… say a destination';
  } else if (assistantState === 'speaking') {
    els.voiceOrbWrapper.className = 'voice-orb-wrapper speaking';
    els.indicatorText.textContent = 'Speaking';
    els.voiceHint.textContent = 'Assistant speaking…';
  } else if (assistantState === 'processing') {
    els.voiceOrbWrapper.className = 'voice-orb-wrapper';
    els.indicatorText.textContent = 'Processing';
    els.voiceHint.textContent = 'Understanding…';
  } else {
    els.voiceOrbWrapper.className = 'voice-orb-wrapper';
    els.indicatorText.textContent = state.phase === 'navigating' ? 'Navigating' : 'Ready';
    els.voiceHint.textContent = state.phase === 'navigating' ? 'Say "Hey Nav", "Repeat", or "Stop"' : 'Say "Hey Nav" or tap mic';
  }
}

// ---------------------------------------------------------------------
// Destination Handling & Voice Command Actions
// ---------------------------------------------------------------------

function resolveNodeId(graph, phraseOrLabel) {
  return [...graph.nodes.keys()].find((id) => graph.nodes.get(id).label === phraseOrLabel)
    || graph.resolveDestination(phraseOrLabel);
}

function handleDestinationRequest(phraseOrLabel) {
  const venueSwitch = matchVenueSwitchPhrase(phraseOrLabel);
  if (venueSwitch) {
    switchVenue(venueSwitch);
    return;
  }

  if (currentVenue().isOutdoor) {
    handleOutdoorDestinationRequest(phraseOrLabel);
    return;
  }

  const graph = currentVenue().graph;
  const destId = resolveNodeId(graph, phraseOrLabel);

  if (!destId) {
    voice.speak("I didn't find a place matching that on this floor. Say \"help\" or open the settings menu.", {
      key: 'no-match',
    });
    setStatus('Place not recognized — try again');
    return;
  }

  // The user might be starting from anywhere on the floor — don't assume a
  // fixed point. If we don't yet have a confirmed "you are here", ask
  // first, then resume this exact request once they answer.
  if (!state.currentNodeId) {
    state.pendingDestination = destId;
    promptForLocation();
    return;
  }

  routeTo(destId);
}

/**
 * Outdoor destinations aren't limited to a fixed set of pre-mapped nodes:
 * resolve against the known hostel waypoints first (fast, and precise if
 * calibrated), and fall back to geocoding any free-text place name via
 * Nominatim so "all kinds of paths" actually means any real destination,
 * not just the three hostels. See route-provider.js for the two caveats
 * that come with that (disputed OSRM foot-routing reliability, and
 * possibly-unmapped campus footpaths) — both are surfaced to the user via
 * voice rather than silently hoped away.
 */
async function handleOutdoorDestinationRequest(phraseOrLabel) {
  if (!state.isAssistantRunning) await startAssistant();
  if (!routeProvider) routeProvider = new RouteProvider();

  const graph = currentVenue().graph;
  const nodeId = resolveNodeId(graph, phraseOrLabel);
  let destCoords = null;
  let destLabel = phraseOrLabel;

  if (nodeId) {
    const node = graph.nodes.get(nodeId);
    destLabel = node.label;
    if (node.lat !== null && node.lon !== null) {
      destCoords = { lat: node.lat, lon: node.lon };
    } else {
      voice.speak(`${node.label} hasn't been calibrated yet — searching for it instead.`, {
        key: 'outdoor-uncalibrated-fallback',
      });
    }
  }

  if (!destCoords) {
    voice.speak(`Looking up ${phraseOrLabel}.`, { key: 'outdoor-geocoding' });
    const results = await routeProvider.geocode(phraseOrLabel);
    if (!results.length) {
      voice.speak(`I couldn't find "${phraseOrLabel}". Try being more specific, or say one of the hostel names.`, {
        key: 'outdoor-geocode-failed',
        interrupt: true,
      });
      setStatus('Destination not found');
      return;
    }
    destCoords = { lat: results[0].lat, lon: results[0].lon };
    destLabel = results[0].label.split(',')[0];
  }

  await routeToOutdoorDestination(destCoords, destLabel);
}

/** One fresh, reasonably-current GPS reading — reuses an in-flight tracker's last fix if it's recent, otherwise takes a single new reading. */
async function getFreshGpsFix() {
  if (gpsTracker && gpsTracker.lastFix && Date.now() - gpsTracker.lastFix.timestamp < 5000) {
    return gpsTracker.lastFix;
  }
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy, timestamp: pos.timestamp,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

async function routeToOutdoorDestination(destCoords, destLabel) {
  voice.speak('Getting your GPS location.', { key: 'outdoor-gps-wait' });
  const fix = await getFreshGpsFix();
  if (!fix) {
    voice.speak("I can't get a GPS fix. Make sure location access is allowed and you're outdoors.", {
      key: 'outdoor-gps-fail',
      interrupt: true,
    });
    return;
  }
  state.outdoorPosition = fix;

  voice.speak(`Finding a walking route to ${destLabel}.`, { key: 'outdoor-routing' });
  const route = await routeProvider.getWalkingRoute(fix, destCoords);
  if (!route || !route.points || route.points.length < 2) {
    voice.speak(
      `I couldn't find a walking route to ${destLabel}. The path there may not be mapped yet.`,
      { key: 'outdoor-no-route', interrupt: true }
    );
    setStatus('No route found');
    return;
  }

  const { haversineDistance } = window.__venueHelpers;
  const straightLine = haversineDistance(fix.lat, fix.lon, destCoords.lat, destCoords.lon);
  const sanity = window.checkRouteSanity(route.distanceMeters, straightLine);

  state.outdoorRoute = {
    points: route.points,
    pointIndex: 1, // index 0 is the starting point itself
    destLabel,
    totalDistance: route.distanceMeters,
    steps: route.steps || [],
  };
  state.phase = 'navigating';
  els.routeControls.classList.remove('hidden');

  let msg = `Route found to ${destLabel}. About ${route.distanceMeters.toFixed(0)} meters.`;
  if (!sanity.ok) msg += ' ' + sanity.reason + ' Double check this looks right before trusting it.';
  voice.speak(msg, { key: 'outdoor-route-start', interrupt: true });
  setStatus(`Route: ${destLabel}`);
  startGpsNavigation();
  announceOutdoorProgress();
}

function announceOutdoorProgress() {
  const route = state.outdoorRoute;
  if (!route) return;
  const firstStep = route.steps[0];
  const msg = firstStep ? firstStep.instruction : `Head toward ${route.destLabel}.`;
  els.subtitle.textContent = msg;
  voice.speak(msg, { key: 'outdoor-first-step', interrupt: true, cooldownMs: 500 });
}

function routeTo(destId) {
  const graph = currentVenue().graph;
  const destLabel = graph.nodes.get(destId).label;

  if (destId === state.currentNodeId) {
    // Same node the user just confirmed they're standing at/near — don't
    // claim a false precise "0 meters" the way the old hardcoded-start
    // version did. Be honest that this is based on what they told us.
    if (!state.isAssistantRunning) startAssistant();
    state.legs = [];
    state.phase = 'idle';
    els.routeControls.classList.add('hidden');
    voice.speak(
      `You told me you're at ${destLabel}, so you should already be right there. ` +
        `If that's not quite right, say "hey nav I'm at" and your actual location.`,
      { key: 'already-there', interrupt: true }
    );
    setStatus(`At ${destLabel} (as you confirmed)`);
    els.subtitle.textContent = `At ${destLabel}`;
    return;
  }

  const result = graph.shortestPath(state.currentNodeId, destId);
  if (!result) {
    voice.speak("I couldn't find a walkable route to that destination.", { key: 'no-route' });
    setStatus('No route available');
    return;
  }

  if (!state.isAssistantRunning) {
    startAssistant();
  }

  state.legs = graph.buildLegs(result.path);
  state.legIndex = 0;
  state.distanceWalkedOnLeg = 0;
  state.phase = 'navigating';
  els.routeControls.classList.remove('hidden');

  voice.speak(`Navigating to ${destLabel}. Total distance: about ${result.totalDist.toFixed(0)} meters.`, {
    key: 'route-start',
    interrupt: true,
  });
  setStatus(`Route: ${destLabel}`);
  announceCurrentLeg();
}

/**
 * Asks the user to confirm where they're standing right now, instead of
 * assuming a fixed starting point. This only applies indoors — outdoors,
 * GPS answers "where am I" automatically (see announceGpsPosition).
 * If the camera's running, the visual localizer's best guess (if any) is
 * offered first — but always as a suggestion to confirm or override,
 * never silently trusted (see localization.js for why: this building's
 * corridors are visually similar enough that a confident auto-guess would
 * just reintroduce the same bug in a different form).
 */
async function promptForLocation() {
  if (currentVenue().isOutdoor) {
    announceGpsPosition();
    return;
  }

  state.awaitingLocationConfirmation = true;
  renderDestinationList(); // re-render so taps set location instead of routing
  setStatus('Where are you right now?');
  els.subtitle.textContent = 'Say where you are, or pick from the list';

  let suggestion = null;
  if (localizer) {
    try {
      const guess = await localizer.locate(state.venueId, { samples: 4, intervalMs: 250 });
      if (guess) suggestion = currentVenue().graph.nodes.get(guess.nodeId)?.label;
    } catch (_) { /* camera not ready yet — fine, just skip the hint */ }
  }

  if (!state.awaitingLocationConfirmation) return; // resolved another way while we were sampling

  if (suggestion) {
    voice.speak(
      `Where are you right now? It looks like you might be near ${suggestion} — say "hey nav I'm at ${suggestion}" if that's right, or tell me your actual location.`,
      { key: 'locate-prompt', interrupt: true }
    );
  } else {
    voice.speak(
      'Where are you right now? Say "hey nav I\'m at" followed by a place, or pick it from the list.',
      { key: 'locate-prompt', interrupt: true }
    );
  }
  toggleSidebar(true);
}

/** Outdoors, GPS tells us where the user is directly — no confirmation needed, unlike the indoor voice/tap flow. */
async function announceGpsPosition() {
  voice.speak('Getting your GPS location.', { key: 'gps-locate-wait' });
  const fix = await getFreshGpsFix();
  if (!fix) {
    voice.speak("I can't get a GPS fix right now. Make sure location access is allowed and you're outdoors.", {
      key: 'gps-locate-fail',
      interrupt: true,
    });
    return;
  }
  state.outdoorPosition = fix;
  const accuracyNote = fix.accuracy > 20
    ? ` GPS accuracy here is only about ${Math.round(fix.accuracy)} meters, so this is approximate.`
    : '';
  voice.speak(`GPS lock acquired.${accuracyNote} Say a destination whenever you're ready.`, {
    key: 'gps-locate-done',
    interrupt: true,
  });
  setStatus('GPS location acquired');
}

function handleLocationSet(phrase) {
  if (currentVenue().isOutdoor) {
    voice.speak("Outdoors, I use your GPS location automatically — no need to tell me where you are.", {
      key: 'outdoor-location-set-noop',
    });
    return;
  }

  const graph = currentVenue().graph;
  const nodeId = resolveNodeId(graph, phrase);
  if (!nodeId) {
    voice.speak("I didn't recognize that place on this floor. Try again, or pick it from the list.", {
      key: 'location-no-match',
    });
    return;
  }

  state.currentNodeId = nodeId;
  state.awaitingLocationConfirmation = false;
  state.distanceWalkedOnLeg = 0;
  const label = graph.nodes.get(nodeId).label;
  renderDestinationList(); // back to normal routing behavior on tap

  if (state.pendingDestination) {
    const destId = state.pendingDestination;
    state.pendingDestination = null;
    voice.speak(`Got it, you're at ${label}.`, { key: 'location-confirmed', interrupt: true });
    routeTo(destId);
  } else {
    voice.speak(`Got it, you're at ${label}. Say a destination whenever you're ready.`, {
      key: 'location-confirmed',
      interrupt: true,
    });
    setStatus(`Location set: ${label}`);
  }
}

function matchVenueSwitchPhrase(phrase) {
  const text = phrase.toLowerCase();
  if (!/\b(switch|change|go to)\b.*\b(floor|building|block|venue)\b|^switch floor$/.test(text)) {
    return null;
  }
  const venues = Object.values(window.VENUES);
  for (const venue of venues) {
    const short = venue.label.toLowerCase().split('—')[0].trim();
    if (text.includes(short) || text.includes(venue.id)) return venue.id;
  }
  const idx = venues.findIndex((v) => v.id === state.venueId);
  return venues[(idx + 1) % venues.length].id;
}

function handleStopRequested() {
  state.phase = 'idle';
  state.legs = [];
  state.outdoorRoute = null;
  ar && ar.clearTarget();
  ar && ar.clearBubble();
  els.routeControls.classList.add('hidden');
  els.subtitle.textContent = '';
  stopGpsNavigation();
  voice.speak('Navigation stopped.', { key: 'stopped', interrupt: true });
  setStatus('Say "Hey Nav" or tap mic');
}

function repeatCurrentLeg() {
  if (state.phase !== 'navigating') {
    voice.speak('No active navigation route. Say "Hey Nav" followed by your destination to start.', { key: 'no-active-route' });
    return;
  }
  if (currentVenue().isOutdoor) {
    announceOutdoorProgress();
    return;
  }
  if (!state.legs[state.legIndex]) return;
  announceCurrentLeg();
}

function announceCurrentStatus() {
  // "Where am I" / "locate me" always re-runs the location check-in rather
  // than assuming the last confirmed spot still holds — the user may have
  // walked somewhere else since (e.g. dead-reckoning drift, or they just
  // want to re-anchor).
  if (currentVenue().isOutdoor) {
    if (state.phase === 'navigating' && state.outdoorRoute) {
      const route = state.outdoorRoute;
      const [lat, lon] = route.points[route.pointIndex];
      const dist = state.outdoorPosition
        ? window.__venueHelpers.haversineDistance(state.outdoorPosition.lat, state.outdoorPosition.lon, lat, lon)
        : null;
      const distText = dist !== null ? `About ${dist.toFixed(0)} meters to the next point.` : '';
      voice.speak(`Heading toward ${route.destLabel}. ${distText}`, { key: 'status-outdoor-nav', interrupt: true });
    } else {
      announceGpsPosition();
    }
    return;
  }

  if (state.phase !== 'navigating') {
    promptForLocation();
    return;
  }
  const leg = state.legs[state.legIndex];
  const remaining = Math.max(leg.distance_m - state.distanceWalkedOnLeg, 0);
  const destLabel = state.legs[state.legs.length - 1].toLabel;
  const fromLabel = currentVenue().graph.nodes.get(state.currentNodeId)?.label || 'your last confirmed spot';
  let msg = `Heading toward ${destLabel}, started from ${fromLabel}. About ${remaining.toFixed(0)} meters left to ${leg.toLabel}.`;

  // Diagnostic add-on: found via real-device testing that step-counting can
  // silently never fire on some phones, freezing progress with no obvious
  // symptom other than "the distance never changes." Surface that directly
  // instead of leaving the person to guess.
  const motionSilent = state.lastMotionEventAt === null || Date.now() - state.lastMotionEventAt > 5000;
  if (motionSilent) {
    msg += ' I\'m not detecting your footsteps on this phone — say "next" or tap Next when you reach a point.';
  }
  if (ar && !ar.hasLiveHeading) {
    msg += ' No compass signal either, so the arrow is just pointing straight ahead.';
  }

  voice.speak(msg, { key: 'status-nav', interrupt: true });
}

function announceHelp() {
  voice.speak(
    'Say "Hey Nav" followed by: "Take me to [place]" — indoors that\'s a room or amenity, outdoors it can be ' +
      'any place name, not just the hostels. Also "I\'m at [place]" to set your location indoors, "Repeat", ' +
      '"Next" to manually advance a step, "Where am I", "Switch floor", or "Stop".',
    { key: 'help', interrupt: true }
  );
}

function announceCurrentLeg() {
  const leg = state.legs[state.legIndex];
  if (!leg) return;

  const remaining = Math.max(leg.distance_m - state.distanceWalkedOnLeg, 0);
  if (ar) {
    ar.setTarget(leg.bearing, remaining, leg.toLabel);
  }

  const turnPhrase = {
    start: 'Face forward and walk',
    straight: 'Continue straight',
    left: 'Turn left, then walk',
    right: 'Turn right, then walk',
    'sharp-left': 'Turn sharply left, then walk',
    'sharp-right': 'Turn sharply right, then walk',
  }[leg.turn];

  let msg = `${turnPhrase} ${remaining.toFixed(0)} meters toward ${leg.toLabel}.`;
  if (leg.passesDoor) msg += ' Check for a door ahead.';
  if (leg.passesStairs) msg += ' Caution: stairs nearby.';

  voice.speak(msg, { key: `leg-${state.legIndex}`, interrupt: true, cooldownMs: 500 });
  els.subtitle.textContent = msg;
}

// ---------------------------------------------------------------------
// Outdoor GPS-driven navigation
// ---------------------------------------------------------------------
// Position is driven directly by live GPS fixes rather than counted
// steps — there's no drift to accumulate, and "have I arrived" is real
// proximity, not a guess. Bearing/distance are recomputed on every GPS
// update from the user's actual current position to the next point on
// the route polyline fetched from route-provider.js, not a static
// node-to-node value — the route can have many points, and the user's
// real position during travel is anywhere along it, not just at a vertex.

const GPS_ARRIVAL_BASE_M = 6; // baseline "close enough" radius
let gpsNavActive = false;

function startGpsNavigation() {
  if (!gpsTracker || gpsNavActive) return;
  gpsNavActive = true;
  gpsTracker.start({ onUpdate: handleGpsUpdate, onError: handleGpsError });
}

function stopGpsNavigation() {
  gpsNavActive = false;
  gpsTracker && gpsTracker.stop();
}

function handleGpsUpdate(fix) {
  state.outdoorPosition = fix;
  if (!gpsNavActive || state.phase !== 'navigating' || !currentVenue().isOutdoor) return;
  const route = state.outdoorRoute;
  if (!route || !route.points.length) return;

  const { haversineDistance, initialBearing } = window.__venueHelpers;
  const arrivalRadius = Math.max(GPS_ARRIVAL_BASE_M, (fix.accuracy || 0) * 0.6);

  // Skip past any polyline points we've already effectively reached, so
  // the arrow always targets a point meaningfully ahead rather than one
  // right behind us (otherwise GPS noise can make it flicker back and
  // forth near closely-spaced points).
  while (route.pointIndex < route.points.length - 1) {
    const [plat, plon] = route.points[route.pointIndex];
    if (haversineDistance(fix.lat, fix.lon, plat, plon) > arrivalRadius) break;
    route.pointIndex++;
  }

  const isFinalPoint = route.pointIndex === route.points.length - 1;

  // Build a short lookahead (up to 4 upcoming points, all bearings/
  // distances measured from the CURRENT position) so the AR overlay can
  // trace a curve matching the real route shape, not just point at the
  // single nearest vertex. The label's distance still reflects only the
  // nearest point, same as before — the extra points are for the visual.
  const LOOKAHEAD = 4;
  const lookaheadEnd = Math.min(route.pointIndex + LOOKAHEAD, route.points.length);
  const aheadPoints = [];
  for (let i = route.pointIndex; i < lookaheadEnd; i++) {
    const [plat, plon] = route.points[i];
    aheadPoints.push({
      bearing: initialBearing(fix.lat, fix.lon, plat, plon),
      distance: haversineDistance(fix.lat, fix.lon, plat, plon),
    });
  }

  const distance = aheadPoints[0].distance;
  ar && ar.setPath(aheadPoints, distance, isFinalPoint ? route.destLabel : 'next point');

  if (isFinalPoint && distance <= arrivalRadius) {
    state.phase = 'arrived';
    els.routeControls.classList.add('hidden');
    stopGpsNavigation();
    voice.speak(`You have arrived at ${route.destLabel}.`, { key: 'outdoor-arrived', interrupt: true });
    setStatus(`Arrived at ${route.destLabel}`);
    els.subtitle.textContent = `Arrived at ${route.destLabel}`;
    ar && ar.clearTarget();
  } else if (isFinalPoint && distance <= arrivalRadius * 2.5) {
    voice.speak(`Almost there, about ${distance.toFixed(0)} meters.`, {
      key: 'outdoor-close',
      cooldownMs: 6000,
    });
  }
}

function handleGpsError(err) {
  voice.speak(
    "I can't get a GPS signal right now. Make sure location access is allowed and you're outdoors.",
    { key: 'gps-error', cooldownMs: 15000 }
  );
}

function advanceLeg() {
  state.legIndex += 1;
  state.distanceWalkedOnLeg = 0;
  if (state.legIndex >= state.legs.length) {
    state.phase = 'arrived';
    els.routeControls.classList.add('hidden');
    stopGpsNavigation();
    const lastLabel = state.legs[state.legs.length - 1].toLabel;
    voice.speak(`You have arrived at ${lastLabel}.`, { key: 'arrived', interrupt: true });
    setStatus(`Arrived at ${lastLabel}`);
    els.subtitle.textContent = `Arrived at ${lastLabel}`;
    if (ar) ar.clearTarget();
    return;
  }
  announceCurrentLeg();
}

/**
 * Manual escape hatch for when step-counting silently never fires — found
 * to be a real issue on-device: if devicemotion events never arrive (some
 * phones/browsers gate this, or the accelerometer isn't delivering data),
 * distanceWalkedOnLeg never increases and the route gets stuck on the
 * first leg forever, no matter how far the user actually walks. Tapping
 * "Next" (or saying "hey nav next") advances the route the same way
 * reaching the distance threshold would, without waiting on a sensor that
 * may never report in.
 */
function forceAdvanceLeg() {
  if (state.phase !== 'navigating') return;
  if (currentVenue().isOutdoor) {
    voice.speak('Outdoors, your position updates automatically from GPS — there\'s no manual step to skip.', {
      key: 'outdoor-next-noop',
    });
    return;
  }
  voice.speak('Moving to the next step.', { key: 'manual-advance', interrupt: true });
  advanceLeg();
}

// ---------------------------------------------------------------------
// Pedometer Dead Reckoning
// ---------------------------------------------------------------------

function onDeviceMotion(e) {
  state.lastMotionEventAt = Date.now(); // diagnostic: proves devicemotion fires at all, even below the step threshold
  if (state.phase !== 'navigating' || currentVenue().isOutdoor) return; // outdoor uses live GPS instead, see handleGpsUpdate
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
  const now = Date.now();

  const THRESHOLD = 11.5;
  const MIN_GAP_MS = 300;
  if (mag > THRESHOLD && mag > state.lastAccelMag && now - state.lastStepAt > MIN_GAP_MS) {
    state.lastStepAt = now;
    state.stepCount += 1;
    state.distanceWalkedOnLeg += settings.strideLengthM;

    const leg = state.legs[state.legIndex];
    if (leg) {
      const remaining = Math.max(leg.distance_m - state.distanceWalkedOnLeg, 0);
      ar.setTarget(leg.bearing, remaining, leg.toLabel);
      if (remaining <= 0.5) {
        advanceLeg();
      } else if (remaining <= 2) {
        voice.speak(`Almost there, ${remaining.toFixed(1)} meters.`, {
          key: `leg-${state.legIndex}-close`,
          cooldownMs: 4000,
        });
      }
    }
  }
  state.lastAccelMag = mag;
}

// ---------------------------------------------------------------------
// Ambient Landmark Recognition — the "you're near X" bubble
// ---------------------------------------------------------------------
// This runs continuously in the background and announces ANY recognized
// landmark it passes, not just the current destination — per the request
// that identifying a place, destination or not, should surface a bubble
// and a spoken callout.
//
// Because this building's corridors often look more like each other than
// like themselves from different angles (see localization.js), a plain
// confidence floor isn't a reliable filter on its own. The main defense
// against noisy/wrong announcements is the MARGIN check: the top match
// has to clearly lead the runner-up, not just clear some absolute score.
// Even so, treat every bubble as "might be" — worded that way on purpose.
const LANDMARK_MARGIN = 0.015;
const LANDMARK_MIN_CONFIDENCE = 0.93;
let ambientWatchTimer = null;

function startAmbientLandmarkWatch() {
  if (ambientWatchTimer) clearInterval(ambientWatchTimer);
  ambientWatchTimer = setInterval(() => {
    if (!state.venueId || !settings.hazardsEnabled) return;
    if (currentVenue().isOutdoor) return; // outdoors, GPS is the position signal — no visual landmark matching

    if (!localizer) return;
    const ranked = localizer.matchVenue(state.venueId);
    if (ranked.length < 1) {
      ar && ar.clearBubble();
      return;
    }
    const [top, second] = ranked;
    const margin = second ? top.confidence - second.confidence : 1;
    const confident = top.confidence >= LANDMARK_MIN_CONFIDENCE && margin >= LANDMARK_MARGIN;

    if (!confident) {
      ar && ar.clearBubble();
      return;
    }

    const label = currentVenue().graph.nodes.get(top.nodeId)?.label;
    if (!label) return;
    ar && ar.showBubble(`You might be near: ${label}`);

    if (state.lastAnnouncedLandmark !== top.nodeId) {
      state.lastAnnouncedLandmark = top.nodeId;
      voice.speak(`You might be near ${label}.`, {
        key: `landmark-${top.nodeId}`,
        cooldownMs: 15000,
      });
    }
  }, 2500);
}

// ---------------------------------------------------------------------
// Hazards Detection
// ---------------------------------------------------------------------

function handleHazard(hazard) {
  if (!settings.hazardsEnabled) return;
  if (state.phase !== 'navigating' && state.phase !== 'listening' && state.phase !== 'idle') return;

  let msg;
  if (hazard.zone === 'critical') {
    msg = `${hazard.label} ahead. ${hazard.guidance || 'stop.'}`;
    voice.playChime('hazard');
  } else if (hazard.zone === 'near') {
    msg = hazard.isHeuristic ? 'Possible steps ahead, slow down.' : `${hazard.label} nearby, ahead.`;
  } else {
    msg = `${hazard.label} in the distance.`;
  }

  const cooldownMs = hazard.zone === 'critical' ? 2500 : hazard.zone === 'near' ? 4000 : 6000;
  voice.speak(msg, {
    key: `hazard-${hazard.label}-${hazard.zone}`,
    cooldownMs,
    interrupt: hazard.zone === 'critical',
  });
}

function handleTrafficUpdate(trafficInfo) {
  state.latestTraffic = trafficInfo;
}

function handleSaveOpenaiKey() {
  const key = els.openaiKeyInput.value.trim();
  if (!key) {
    localStorage.removeItem('navassist_openai_key');
    aiAssistant && aiAssistant.setApiKey(null);
    els.openaiKeyStatus.textContent = 'Key cleared.';
    return;
  }
  if (!key.startsWith('sk-')) {
    els.openaiKeyStatus.textContent = 'That doesn\'t look like an OpenAI key (should start with "sk-") — saved anyway, but double-check it.';
  } else {
    els.openaiKeyStatus.textContent = 'Key saved to this device.';
  }
  localStorage.setItem('navassist_openai_key', key);
  if (!aiAssistant) aiAssistant = new AiAssistant();
  aiAssistant.setApiKey(key);
}

function setStatus(text) {
  els.statusText.textContent = text;
}

// ---------------------------------------------------------------------
// AI Voice Assistant (OpenAI) — answers open-ended questions using the
// same structured, deterministic data everything else in the app already
// computes. See ai-assistant.js's header for why the key lives only in
// localStorage, and why this layer never gates hazard warnings.
// ---------------------------------------------------------------------

function buildAiContext() {
  const context = {};
  if (state.venueId) context.venue = currentVenue().label;

  if (state.phase === 'navigating') {
    if (currentVenue().isOutdoor && state.outdoorRoute) {
      context.destination = state.outdoorRoute.destLabel;
      const route = state.outdoorRoute;
      if (state.outdoorPosition && route.points[route.pointIndex]) {
        const [lat, lon] = route.points[route.pointIndex];
        context.distanceRemaining = window.__venueHelpers.haversineDistance(
          state.outdoorPosition.lat, state.outdoorPosition.lon, lat, lon
        );
      }
    } else if (state.legs[state.legIndex]) {
      const leg = state.legs[state.legIndex];
      context.destination = state.legs[state.legs.length - 1].toLabel;
      context.distanceRemaining = Math.max(leg.distance_m - state.distanceWalkedOnLeg, 0);
    }
  }

  if (currentVenue() && currentVenue().isOutdoor && state.outdoorPosition) {
    context.position = state.outdoorPosition;
  }

  if (hazards && hazards.latestSnapshot) {
    context.hazard = hazards.latestSnapshot.hazard;
    context.traffic = hazards.latestSnapshot.traffic;
  }

  return context;
}

async function handleAiQuery(question) {
  if (!aiAssistant) {
    voice.speak("The AI assistant hasn't started yet. Tap Start first.", { key: 'ai-not-ready' });
    return;
  }
  if (!aiAssistant.hasKey()) {
    voice.speak('Add an OpenAI key in Settings to use this — the app works fine without it, this just adds richer answers.', {
      key: 'ai-no-key',
      interrupt: true,
    });
    return;
  }

  voice.speak('Let me check.', { key: 'ai-thinking', cooldownMs: 0 });
  const context = buildAiContext();
  const answer = await aiAssistant.ask(question, context);
  voice.speak(answer, { key: 'ai-answer', interrupt: true });
}

