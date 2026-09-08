/**
 * qr-scanner.js
 * -----------------------------------------------------------------------
 * The "Anchor Point" idea, done in plain JS: each landmark has a small
 * printed QR sticker (see scripts/generate_qr_codes.py and qr-codes/) that
 * encodes "NAVASSIST:<venueId>:<nodeId>". Scanning one gives an exact,
 * unambiguous position fix — no guessing, no confidence thresholds. This
 * is the reliable counterpart to the soft visual-fingerprint hint in
 * localization.js, which is intentionally never trusted alone (see that
 * file's header for why: this building's corridors are too visually
 * similar for simple color matching to be trustworthy by itself).
 *
 * A wrong or ambiguous "where am I" is the most likely root cause behind
 * "the arrows aren't working" reports — if the start node is wrong, every
 * bearing computed from it is wrong too, which looks exactly like broken
 * arrow rendering even though the rendering itself is fine. Scanning a
 * sticker sidesteps that class of bug entirely.
 * -----------------------------------------------------------------------
 */

const QR_PREFIX = 'NAVASSIST:';

class QrScanner {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this._scratch = document.createElement('canvas');
    this.running = false;
  }

  /** One-shot decode of the current camera frame. Returns {venueId, nodeId} or null. */
  scanFrame() {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh || typeof jsQR !== 'function') return null;

    // Downscaling keeps this cheap enough to run several times a second on
    // a mid-range phone; QR codes are high-contrast so resolution loss
    // rarely stops a decode as long as the sticker fills a reasonable
    // fraction of the frame.
    const scale = Math.min(1, 480 / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    this._scratch.width = w;
    this._scratch.height = h;
    const ctx = this._scratch.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.videoEl, 0, 0, w, h);

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, w, h);
    } catch (_) {
      return null;
    }

    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (!result || !result.data || !result.data.startsWith(QR_PREFIX)) return null;

    const parts = result.data.slice(QR_PREFIX.length).split(':');
    if (parts.length !== 2) return null;
    const [venueId, nodeId] = parts;
    return { venueId, nodeId };
  }

  /**
   * Polls the camera at `intervalMs` looking for a valid sticker, until
   * `timeoutMs` elapses or one is found. Used during the "where are you?"
   * check-in so the user can just point the camera at a sticker instead of
   * talking or tapping.
   */
  async scanUntilFound({ timeoutMs = 8000, intervalMs = 300 } = {}) {
    this.running = true;
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      const hit = this.scanFrame();
      if (hit) {
        this.running = false;
        return hit;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    this.running = false;
    return null;
  }

  stop() {
    this.running = false;
  }
}

window.QrScanner = QrScanner;
