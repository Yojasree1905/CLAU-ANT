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
  isAssistantRunning: false,
  lastAnnouncedLandmark: null, // for the ambient "you're near X" bubble
};

let localizer = null; // set once the camera is running (see startAssistant)

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
  });
  voice.rate = settings.voiceRate;
  voice.chimesEnabled = settings.audioChimes;

  // Initialize UI controls
  syncSettingsUI();
  renderVenuePicker();
  renderDestinationList();
  updateTopBadge();

  // Canvas setup
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Wire events
  els.micBtn.addEventListener('click', onMicTapped);
  els.repeatBtn.addEventListener('click', repeatCurrentLeg);
  els.stopBtn.addEventListener('click', handleStopRequested);
  els.sidebarToggleBtn.addEventListener('click', () => toggleSidebar(true));
  els.sidebarCloseBtn.addEventListener('click', () => toggleSidebar(false));
  els.sidebarBackdrop.addEventListener('click', () => toggleSidebar(false));

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
  ar && ar.clearTarget();
  els.routeControls.classList.add('hidden');
  renderVenuePicker();
  renderDestinationList();
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
      ? 'Tap the place closest to you, or say "hey nav I\'m at" and a place.'
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
    hazards = new HazardDetector({ videoEl: els.video, onHazard: handleHazard });
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
 * assuming a fixed starting point. If the camera's running, the visual
 * localizer's best guess (if any) is offered first — but always as a
 * suggestion to confirm or override, never silently trusted (see
 * localization.js for why: this building's corridors are visually similar
 * enough that a confident auto-guess would just reintroduce the same bug
 * in a different form).
 */
async function promptForLocation() {
  state.awaitingLocationConfirmation = true;
  renderDestinationList(); // re-render so taps set location instead of routing
  setStatus('Where are you right now?');
  els.subtitle.textContent = 'Where are you right now?';

  let suggestion = null;
  if (localizer) {
    try {
      const guess = await localizer.locate(state.venueId, { samples: 4, intervalMs: 250 });
      if (guess) suggestion = currentVenue().graph.nodes.get(guess.nodeId)?.label;
    } catch (_) { /* camera not ready yet — fine, just skip the hint */ }
  }

  if (suggestion) {
    voice.speak(
      `Where are you right now? It looks like you might be near ${suggestion} — say "hey nav I'm at ${suggestion}" if that's right, or tell me your actual location.`,
      { key: 'locate-prompt', interrupt: true }
    );
  } else {
    voice.speak(
      'Where are you right now? Say "hey nav I\'m at" followed by a place, like the lift or the water cooler, or pick it from the list.',
      { key: 'locate-prompt', interrupt: true }
    );
  }
  toggleSidebar(true);
}

function handleLocationSet(phrase) {
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
  ar && ar.clearTarget();
  els.routeControls.classList.add('hidden');
  els.subtitle.textContent = '';
  voice.speak('Navigation stopped.', { key: 'stopped', interrupt: true });
  setStatus('Say "Hey Nav" or tap mic');
}

function repeatCurrentLeg() {
  if (state.phase !== 'navigating' || !state.legs[state.legIndex]) {
    voice.speak('No active navigation route. Say "Hey Nav" followed by your destination to start.', { key: 'no-active-route' });
    return;
  }
  announceCurrentLeg();
}

function announceCurrentStatus() {
  // "Where am I" / "locate me" always re-runs the location check-in rather
  // than assuming the last confirmed spot still holds — the user may have
  // walked somewhere else since (e.g. dead-reckoning drift, or they just
  // want to re-anchor).
  if (state.phase !== 'navigating') {
    promptForLocation();
    return;
  }
  const leg = state.legs[state.legIndex];
  const remaining = Math.max(leg.distance_m - state.distanceWalkedOnLeg, 0);
  const destLabel = state.legs[state.legs.length - 1].toLabel;
  const fromLabel = currentVenue().graph.nodes.get(state.currentNodeId)?.label || 'your last confirmed spot';
  voice.speak(
    `Heading toward ${destLabel}, started from ${fromLabel}. About ${remaining.toFixed(0)} meters left to ${leg.toLabel}.`,
    { key: 'status-nav', interrupt: true }
  );
}

function announceHelp() {
  voice.speak(
    'Say "Hey Nav" followed by: "Take me to [place]", "I\'m at [place]" to set your location, ' +
      '"Where is [place]", "Repeat", "Where am I", "Switch floor", or "Stop".',
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

function advanceLeg() {
  state.legIndex += 1;
  state.distanceWalkedOnLeg = 0;
  if (state.legIndex >= state.legs.length) {
    state.phase = 'arrived';
    els.routeControls.classList.add('hidden');
    const lastLabel = state.legs[state.legs.length - 1].toLabel;
    voice.speak(`You have arrived at ${lastLabel}.`, { key: 'arrived', interrupt: true });
    setStatus(`Arrived at ${lastLabel}`);
    els.subtitle.textContent = `Arrived at ${lastLabel}`;
    if (ar) ar.clearTarget();
    return;
  }
  announceCurrentLeg();
}

// ---------------------------------------------------------------------
// Pedometer Dead Reckoning
// ---------------------------------------------------------------------

function onDeviceMotion(e) {
  if (state.phase !== 'navigating') return;
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
    if (!localizer || !state.venueId || !settings.hazardsEnabled) return;
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

function setStatus(text) {
  els.statusText.textContent = text;
}

