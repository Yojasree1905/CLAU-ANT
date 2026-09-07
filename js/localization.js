/**
 * localization.js
 * -----------------------------------------------------------------------
 * Answers two questions without GPS, beacons, or any special hardware:
 *   1. "Where does the user seem to be starting from?" — replaces the old
 *      hardcoded `defaultStart` assumption, which is what caused the
 *      reported bug (assistant claimed 0m to the lift when the user was
 *      actually standing 3m away, because it always assumed they started
 *      exactly at the venue's default node).
 *   2. "Does a known landmark appear to be in view right now?" — feeds the
 *      on-screen "you're near X" bubble, independent of whether X is the
 *      current destination.
 *
 * HOW IT WORKS (and its real limits):
 * Each landmark has 1-4 reference photos (see dataset/ and
 * scripts/precompute_fingerprints.py). Offline, each reference photo was
 * reduced to an 8x8 grid of average RGB values (192 numbers) — a classical
 * "tiny image" color/layout descriptor, NOT a deep neural embedding. At
 * runtime this file computes the exact same descriptor from a live camera
 * frame and compares it (cosine similarity) against every reference.
 *
 * This is intentionally lightweight — it needs no extra model download —
 * but it is a coarse tool. It can usually tell a lift's metal doors apart
 * from a sofa or a stairwell, because those look very different in overall
 * color and layout. It will NOT reliably distinguish two similar-looking
 * stretches of the same beige corridor, and lighting changes will hurt it.
 * Treat every match as a suggestion the user (or the graph-based nav
 * already in progress) can override — never as ground truth on its own.
 * That's why `locate()` below always returns a confidence alongside the
 * guess, and app.js asks for confirmation rather than silently trusting it.
 * -----------------------------------------------------------------------
 */

const FP_GRID = 8;

window.__fingerprintDB = window.__fingerprintDB || {}; // venueId -> { nodeId: [vector, ...] }

function registerFingerprints(venueId, nodeVectors) {
  window.__fingerprintDB[venueId] = nodeVectors;
}
window.registerFingerprints = registerFingerprints;

class Localizer {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this._scratch = document.createElement('canvas');
    this._scratch.width = FP_GRID;
    this._scratch.height = FP_GRID;
  }

  /** Compute the current camera frame's fingerprint (192-length array, 0..1 per channel). */
  captureFingerprint() {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;

    const ctx = this._scratch.getContext('2d');
    ctx.drawImage(this.videoEl, sx, sy, side, side, 0, 0, FP_GRID, FP_GRID);
    const { data } = ctx.getImageData(0, 0, FP_GRID, FP_GRID);
    const vec = new Array(FP_GRID * FP_GRID * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      vec[j] = data[i] / 255;
      vec[j + 1] = data[i + 1] / 255;
      vec[j + 2] = data[i + 2] / 255;
    }
    return vec;
  }

  static cosineSimilarity(a, b) {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  /**
   * Match the current frame against every reference vector for a venue.
   * Returns a ranked list: [{ nodeId, confidence }, ...] (confidence 0..1,
   * roughly: >0.985 strong match, 0.97-0.985 weak match, below that noise).
   * Empty array if no camera frame or no fingerprint database for the venue.
   */
  matchVenue(venueId) {
    const db = window.__fingerprintDB[venueId];
    if (!db) return [];
    const live = this.captureFingerprint();
    if (!live) return [];

    const scores = [];
    for (const [nodeId, vectors] of Object.entries(db)) {
      let best = 0;
      for (const ref of vectors) {
        const sim = Localizer.cosineSimilarity(live, ref);
        if (sim > best) best = sim;
      }
      if (vectors.length > 0) scores.push({ nodeId, confidence: best });
    }
    scores.sort((a, b) => b.confidence - a.confidence);
    return scores;
  }

  /**
   * One-shot "where am I" guess for the start-of-navigation flow. Samples
   * a few frames over ~1.5s (the user may still be raising the phone) and
   * returns the best candidate across all of them, or null if nothing
   * cleared the confidence floor.
   */
  async locate(venueId, { samples = 5, intervalMs = 300, minConfidence = 0.975 } = {}) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const ranked = this.matchVenue(venueId);
      if (ranked.length && (!best || ranked[0].confidence > best.confidence)) {
        best = ranked[0];
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!best || best.confidence < minConfidence) return null;
    return best;
  }
}

window.Localizer = Localizer;
