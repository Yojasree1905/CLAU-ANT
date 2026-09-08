# Voice-guided indoor navigation + hazard warnings — multi-venue

Covers **two floors** — the SJT 7th floor corner and the H Block 3rd floor
dormitory wing — through one voice-first assistant with a "Hey Nav" wake
word, a slide-out settings sidebar, live obstacle warnings, and an
AR-style ground path overlay. Built to match the design decisions already
in `visionassist-ai` (on-device only, no cloud, Dijkstra routing,
pedestrian dead reckoning), so it can be merged in as new venues later.

## Voice commands (wake word: "Hey Nav")

Say "Hey Nav" then any of:
- **"take me to [place]"** / **"where is [place]"** — routes you there
- **"I'm at [place]"** / **"my location is [place]"** — tells the assistant
  where you're standing right now, without starting navigation (see
  "Where are you starting from?" below — this is the important one)
- **"repeat"** — replays the current turn instruction
- **"where am I"** — re-checks your location, or reports nav progress if
  you're mid-route
- **"switch floor"** — cycles between SJT and H Block
- **"stop"** — cancels the current route
- **"help"** — spoken list of commands

A bare **"nav"** or **"navigator"** also works as a shorter wake word. The
wake-word regex is anchored so it never fires mid-word — "navigate to the
lift" does not accidentally trigger it twice.

## Where are you starting from? (the bug you reported, actually fixed)

The earlier version assumed every route started from a fixed default node
(e.g. always the stairwell), which is exactly what caused "3 meters from
the lift showing as 0 meters" — the app wasn't wrong about the distance
along the route, it was wrong about where the route started.

That assumption is gone. `state.currentNodeId` is now `null` until you
confirm it, by voice or by tapping a place in the sidebar. Ask for a
destination before confirming your location, and the assistant asks
"where are you right now?" first, then resumes your original request once
you answer — it never silently guesses.

**I did try to make this fully automatic first, and backed off on purpose.**
I built a visual place-recognition system (`js/localization.js`) that
matches the live camera feed against reference photos of each landmark,
and tested it against your actual dataset before shipping it. The result:
in this building, two *different* landmarks (e.g. the lift and a plain
corridor turn) can look more similar to each other (0.99 match) than two
photos of the *same* landmark do to each other (0.93–0.96) — the uniform
walls and lighting defeat simple visual matching. Shipping that as a
confident auto-detect would have just moved your bug somewhere sneakier.

So the vision system is used as a **hint, not an answer**: when it's
confident, it suggests a place first ("it looks like you might be near the
lift — say yes or tell me your real location"), but a human always
confirms. It also runs in the background the whole time you're using the
app to power the landmark bubble below.

## QR location stickers — the actual reliable fix

Prompted by AR research showing indoor systems typically calibrate
position by scanning a marker at a known point ("Anchor Points"), the
soft color-matching above now has a hard, unambiguous counterpart: a
printed QR sticker at each landmark. Scanning one gives an exact position
fix — no confidence thresholds, no confirmation round-trip.

**Setup**: print `qr-codes/sjt7-print-sheet.pdf` and
`qr-codes/hblock3-print-sheet.pdf` (or individual stickers from
`qr-codes/<venue>/<place>.png`), cut them apart, and stick one up at each
landmark. Each encodes `NAVASSIST:<venue>:<place>` and includes a
human-readable label so you know which goes where even without scanning
it. Re-run `python3 scripts/generate_qr_codes.py` if you rename or add
nodes in `js/venues/*.js` — keep the `REFERENCES`-equivalent node list at
the top of that script in sync with the venue files.

**What it does**, once stickers are up:
- During the "where are you?" check-in, pointing the camera at a sticker
  resolves it instantly — faster and far more reliable than the voice/tap
  fallback, which still works if you don't have a sticker handy.
- Scanning the wrong building's sticker auto-switches the active floor.
- **Mid-route drift correction**: if a sticker comes into view while
  you're already navigating, the app silently re-anchors your position and
  recalculates the remaining path from there — instead of trusting
  accumulated step-counting, which drifts. This is very likely the actual
  fix for "the arrows aren't working" reports: a wrong current-position
  estimate produces a wrong bearing, which looks exactly like broken arrow
  rendering even though the arrow math itself is fine.

This doesn't replace the voice/tap location check-in — it's a faster, more
reliable option layered on top, for anywhere you're willing to put up a
sticker.

## The "you're near X" bubble

Per the request that identifying *any* recognized place — not just your
destination — should surface something on screen: the same visual matcher
runs continuously (every 2.5s) while the assistant is active. QR stickers
are checked first and are authoritative — spotting one shows "You're at:
[place]" with full confidence and no wording hedge. Without a sticker in
view, it falls back to the soft color-matching hint from the section
above, worded "You might be near..." on purpose, and stays silent rather
than guess when the vision signal is ambiguous, which is often in this
building.

## AR ground path

The camera overlay draws a tapered path low in the frame that curves left
or right toward your next turn, with chevrons flowing along it, instead of
a floating rotating arrow badge. Beyond about 70° off — meaning the
destination is essentially behind you — it switches to a clear "turn
around" loop icon instead of stretching the path into something confusing.
This is still a heading-based illusion (uses the phone's compass), not
true floor-locked AR — see the comment at the top of `js/ar.js` for why
real plane-tracked AR (WebXR) was deliberately not used: it only works on
ARCore Android phones in Chrome, not iPhones.

**Real-device finding**: on-device screenshots at SJT showed the path
never rendering at all — not misdirected, just never appearing. The
"you're near X" bubble (also canvas-drawn) DID appear, proving the canvas
pipeline itself was fine; the actual bug was that the arrow-drawing code
refused to draw anything unless it had a valid compass reading, and this
phone's compass apparently never delivered one — plausibly because
concrete-and-rebar buildings are notorious for scrambling magnetometers.
Fixed: `ArOverlay` now falls back to "assume you're already facing the
target" (a straight-ahead arrow) whenever no live compass reading has
arrived, with a small on-screen note ("No compass signal — showing
straight-ahead") so it's clear when this fallback is active. It
transparently upgrades to true compass-relative rendering the moment a
real reading does show up.

## Two sensor-dependent features can silently fail — here's the safety net

The same device testing surfaced a second, related issue: all five
screenshots taken while walking through clearly different physical spots
showed the *identical* turn instruction and distance. That means
step-counting (`onDeviceMotion` in `js/app.js`) never advanced the route
past the first leg — most likely the same root cause as the compass issue
(this phone/browser not delivering `devicemotion` events at all indoors).

Rather than keep guessing at exactly why a given phone's sensors go quiet,
the app now has an explicit escape hatch: a **"Next" button** next to
Repeat/End Route, and the voice command **"hey nav next"** (also "skip",
"I'm there", "I've arrived"), which manually advances to the next leg the
same way reaching the distance threshold normally would. Asking "where am
I" while navigating now also reports whether footsteps or a compass signal
have been detected recently, so you don't have to infer sensor health from
symptoms the way this round of testing had to.

## Outdoor navigation (GPS) — Ladies Hostel G / H / J

A third venue, "Outdoor — Hostel Paths," covers all six directions between
the three hostel blocks (G↔H, G↔J, H↔J). It works completely differently
from the two indoor venues, on purpose:

**No coordinate is ever guessed.** Every outdoor waypoint (`js/venues/
outdoor-hostels.js`) starts with `lat`/`lon` set to `null` and *stays*
`null` until someone physically stands there and captures a real GPS
reading. I tested this directly: with zero waypoints calibrated,
`shortestPath()` returns `null` rather than routing through invented
coordinates — confirmed with a script before this shipped. For a tool
guiding someone who can't see the path, a wrong outdoor coordinate is a
safety issue, not a rounding error, so there's no fallback here the way
there is for the indoor compass/step-counting issues above.

**How to calibrate it**: open Settings → Outdoor Calibration (or say "hey
nav calibrate waypoints") while on the outdoor venue. Walk to each of the
12 waypoints listed, tap **Capture here** (it averages 5 GPS readings over
a few seconds, weighted toward the more accurate ones, and shows a
warning if accuracy is poor), and its status flips to ✅. When done, tap
**Export calibration** and paste the result into the `CALIBRATED_COORDS`
object at the top of `js/venues/outdoor-hostels.js` — that's what makes it
permanent for everyone, the same pattern as the QR sticker workflow.

**The 9 via-points between entrances are a *shape* guess, not a coordinate
guess** — I don't know if the real path bends twice or five times between
any two hostels. Add or remove waypoints in that file to match the actual
path once you've walked it; nothing about the calibration tool requires
exactly this skeleton.

**Once calibrated, navigation is GPS-driven, not step-counted.** This is a
meaningful improvement over the indoor approach: bearing and remaining
distance are recomputed from your actual live position on every GPS
update (roughly once a second), so there's no accumulating drift and
nothing to get permanently stuck the way indoor step-counting could
(see above) — "arrival" is real proximity to the waypoint's calibrated
coordinates, scaled to the phone's reported GPS accuracy. The AR ground
path, turn-by-turn voice, and hazard detection all reuse the exact same
code as indoor; only the position source changes.

I verified the full loop end-to-end with a simulated walk: calibrate 5
waypoints along a straight line → route between them → feed in sequential
GPS fixes approximating an actual walk → correct turn-by-turn distances
throughout → correct arrival. The haversine distance and bearing formulas
were checked against independent references (cardinal-direction test
cases, and the well-documented ~344km London-to-Paris distance) before
being trusted for any of this.

## Venues included

| Venue | Destinations it knows |
|---|---|
| **SJT — 7th floor corner** | staircase, entrance lobby, rooms 711/712, faculty cabins, water cooler, women's washroom (714), room 715, open corridor, far end of corridor |
| **H Block — 3rd floor** | lift, staircase, water cooler, washroom, main corridor / walking area, storage room, common room (sofa), corridor turn, dormitory rooms, balcony (drying area) |
| **Outdoor — Hostel Paths** | Ladies Hostel G, H, J, and 9 path waypoints between them — see "Outdoor navigation" above; requires on-site calibration before it can route anywhere |

Indoor venues' data live in `js/venues/*.js` in the same format, so adding
a fourth floor later is just a new file plus one `registerVenue()` call.
The raw photos and walkthrough videos for the two indoor venues are kept
in `dataset/` for reference and for re-deriving the map (or the visual
fingerprints — see `scripts/precompute_fingerprints.py`) if you
recalibrate.

## What's new for H Block specifically

- **Sofa detection**: COCO-SSD's `couch` class is now spoken as "sofa" in
  hazard warnings (was labelled "couch" before) — the H Block common room
  has one squarely in the walking path in the video.
- **Lift** is a first-class destination (`"where is the lift"`, `"take me
  to the elevator"`), separate from the staircase.
- **Balcony / drying area**, **storage room**, and **common room** are
  destinations with `isDoor: true`, so the app calls out a door check
  before arrival, same as it does for washrooms and dormitory room doors.
- The dormitory doors themselves are one grouped destination
  (`dormitory_rooms`) rather than individual numbered rooms — none of the
  room number plates were clearly legible in the photos. If you can read
  the actual numbers off the doors, split this into per-room nodes the
  same way SJT has `room_715` as its own node.

## PWA manifest quality (PWABuilder scan)

Running the hosted URL through pwabuilder.com surfaces "Action Items" —
mostly optional metadata. What's actually addressed:

- **Real screenshots** (`screenshots/`) generated from the running app via
  Playwright — idle screen, listening state, the settings sidebar, and an
  active route with the AR ground path + landmark bubble — and referenced
  in `manifest.json`'s `screenshots` array.
- **`id`**, **`categories`**, **`lang`**, **`dir`**, and
  **`prefer_related_applications`** added to the manifest.

Left alone, on purpose: `related_applications` (no native app exists),
IARC rating (a content-age rating doesn't meaningfully apply to a
navigation utility), and the various "enhancement" items (`share_target`,
`file_handlers`, `protocol_handlers`, `widgets`, `edge_side_panel`,
`windows-control-overlay`, `tabbed`, notes-app registration, background
sync, push notifications) — none of them fit what this app actually does,
and adding manifest fields with no real behavior behind them just adds
surface area to maintain.

## Run it

Needs HTTPS (or `localhost`) for camera/mic/motion permissions:

```
cd sjt7-navassist
python3 -m http.server 8443   # or any static server; use ngrok/GitHub Pages for a real phone test over HTTPS
```

Open on a phone in Chrome (Android) or Safari (iOS), tap **Start assistant**,
grant camera / microphone / motion permissions, then either say a place
("take me to the water cooler", "where is room 715", "faculty cabin") or
tap it from **Show destination list**.

## What's real vs. what's a placeholder

| Feature | Status |
|---|---|
| Voice destination recognition (Web Speech API + synonym matching, "Hey Nav" wake word) | Working |
| Shortest-path routing (Dijkstra) + turn-by-turn instructions | Working |
| Location check-in ("I'm at the lift") replacing the fixed-start assumption | Working |
| QR sticker location scanning (authoritative, drift-correcting) | Working — needs stickers physically printed and placed, see "QR location stickers" above |
| Ambient visual place matching (soft hint + bubble, no sticker in view) | Working, but low-confidence by design — see "Where are you starting from?" above for why it's deliberately conservative |
| AR ground-path overlay, curves toward turns | Working, with a straight-ahead fallback confirmed necessary on real hardware — see "AR ground path" above |
| Manual "Next" advance (voice or button) as a step-counting safety net | Working — added after real-device testing showed step-counting can silently never fire |
| Outdoor GPS navigation (Ladies Hostel G/H/J) | Working, but requires on-site calibration before it can route anywhere — no coordinate is ever guessed, see "Outdoor navigation" above |
| Step-counted progress along a route (dead reckoning) | Working, adjustable stride length in Settings |
| Person / chair / table / sofa hazard warnings with left-right correction | Working (TensorFlow.js COCO-SSD) |
| "Steps ahead" detection | **Heuristic placeholder** — edge-density guess, will false-positive on plain tile floors. Swap in a real geometric detector for production use. |
| "Door closed / open" | **Not vision-detected** — the app announces "there's a door here" from the map data (`isDoor` flag) since COCO-SSD has no door class. |

## Calibration (do this once, on each real floor)

Each venue file in `js/venues/` was authored by inspecting photos and
video, not surveyed — the room layout and connections are right, but
distances and exact bearings are estimates. To calibrate:

1. Walk each edge in that venue's `EDGES` array and update `distance_m`
   with the actual paced or taped distance.
2. If a turn direction ever sounds wrong to a test user, nudge the `(x, y)`
   coordinates of the node it turns *toward* — bearings are computed
   automatically from coordinates, so you never edit bearings by hand.
3. Tune stride length live in Settings → Walking Calibration, or the
   accelerometer `THRESHOLD` / `MIN_GAP_MS` in `js/app.js`'s
   `onDeviceMotion()`, against the actual tester's gait.
4. **SJT**: I placed **room 715 next to 714** based on typical even/odd
   room-number pairing — I only saw signage for 714 (women's washroom) in
   the photos. Please confirm 715's real position.
5. **H Block**: I clustered the lift, staircase, water cooler and washroom
   together at one landing based on the video, and treated the dormitory
   doors as one group rather than individual rooms. Confirm both against
   the real floor before relying on it.
6. **Visual fingerprints**: to add or improve landmark recognition
   accuracy, add more reference photos to `dataset/<venue>/`, list them in
   `scripts/precompute_fingerprints.py`'s `REFERENCES` dict, and re-run
   `python3 scripts/precompute_fingerprints.py`. More photos per landmark,
   taken from different distances/angles, directly improves match quality.

## Known lessons carried over from `build-status.md`

Your build-status doc listed four defects testing caught in the original
app. Two directly apply to voice/hazard code and are already handled here:

- **Repeating hazard too fast** (was every 0.9s) → every spoken warning in
  `voice.speak()` has a cooldown key + minimum interval (2.5–6s depending on
  urgency), in `js/app.js`'s `handleHazard()`.
- **Steering advice not marked as spoken, so it repeated** → hazard and
  turn messages are always built as one combined string before being
  passed to `speak()`, never spoken in separate pieces.

## Suggested next steps

1. Get me (or drop into your own editor) the actual `visionassist-ai`
   source so this can become a new venue module inside it, reusing your
   real `structure.js` and decision engine instead of the placeholders
   above.
2. Run the user study your build-status doc already flagged as the
   biggest gap — phrasing, alert timing, and turn instructions need real
   blind or low-vision testers on this specific floor, not just automated
   checks. This matters even more now with the location check-in flow —
   test whether "say I'm at the lift" is actually the easiest way for a
   real user to confirm their position, or whether something like a
   distinctive floor marker + a simpler yes/no confirmation would work
   better in practice.
3. If you can get more/better reference photos per landmark (see
   Calibration item 6), the visual hint and bubble will improve — but
   given what the current dataset shows, don't expect it to become fully
   reliable through photos alone in a building this visually uniform;
   budget for the voice/tap confirmation staying the primary mechanism.

## Turning this into an .apk you can send over WhatsApp

I can't build the `.apk` file myself in this environment — packaging a real
Android app needs the Android SDK and Google's Maven repository, and both
are network-blocked in this sandbox. Here are two ways to get an actual
`.apk`, both realistic without installing Android Studio:

### Option A — fastest: PWABuilder (no coding, ~5 minutes)

This app is now a proper installable PWA (manifest + icons + service worker
added). [PWABuilder](https://www.pwabuilder.com) is Microsoft's free tool
that turns any hosted PWA into a signed, installable `.apk`/`.aab`.

1. Host this folder somewhere with HTTPS. Easiest: create a GitHub repo,
   upload this folder, then turn on **Settings → Pages** — this is the same
   plan already in `build-status.md`. You'll get a URL like
   `https://yourname.github.io/sjt7-navassist/`.
2. Go to pwabuilder.com, paste that URL, click **Start**.
3. Click the **Android** package option → **Generate**.
4. Download the `.apk` it produces.
5. Send that `.apk` file over WhatsApp like any other file. The recipient
   taps it, allows "install from unknown sources" once, and it installs
   like a normal app — full-screen, with its own icon, camera/mic/motion
   permissions requested the first time it runs.

No signing keys or Play Store account needed for this — PWABuilder signs it
for you (fine for sharing directly; you'd only need your own signing key
for a Play Store listing).

### Option B — if you have Android Studio on your own machine

Google's own `bubblewrap` CLI does the same thing as PWABuilder, from your
terminal, once the folder above is hosted at an HTTPS URL:

```
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://yourname.github.io/sjt7-navassist/manifest.json
bubblewrap build
```

This produces `app-release-signed.apk` in the project folder it creates —
send that over WhatsApp the same way.

### Why not skip the APK entirely?

Since this is already a PWA, sending people the *link* (once hosted) and
having them tap **Add to Home Screen** in Chrome gets them a home-screen
icon, offline support, and full permissions — functionally identical to an
installed app, with no APK, no "unknown sources" warning, and no
re-packaging every time you edit the code. The APK route above is worth it
if you specifically want a file to send, or want it to eventually reach the
Play Store.
