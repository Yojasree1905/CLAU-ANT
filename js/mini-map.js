/**
 * mini-map.js
 * -----------------------------------------------------------------------
 * Interactive top-right Mini-Map widget for NAV-AR.
 *
 * Behavior:
 *   - Compact 3x3 square widget in top-right viewport corner.
 *   - Shows user's live GPS position with blue pulsing beacon.
 *   - When navigating to a destination, draws the walking route polyline
 *     and destination flag marker.
 *   - Tap on the 3x3 widget -> expands smoothly to a large 6x6 modal map view
 *     with zoom controls and route preview.
 *   - Tap collapse button (or tap outside) -> shrinks back to 3x3 widget.
 * -----------------------------------------------------------------------
 */

class MiniMapController {
  constructor() {
    this.container = document.getElementById('mini-map-card');
    this.mapEl = document.getElementById('mini-map');
    this.expandBtn = document.getElementById('mini-map-expand-btn');
    this.closeBtn = document.getElementById('mini-map-close-btn');
    this.distBadge = document.getElementById('mini-map-dist-badge');
    this.isExpanded = false;

    this.map = null;
    this.userMarker = null;
    this.userCircle = null;
    this.destMarker = null;
    this.routePolyline = null;
    this.currentPosition = null;
    this.activeRoute = null;

    this._initMap();
    this._wireEvents();
  }

  _initMap() {
    if (typeof L === 'undefined' || !this.mapEl) return;

    // Default center at VIT Vellore campus
    const defaultCenter = [12.9682, 79.1594];

    this.map = L.map(this.mapEl, {
      zoomControl: false,
      attributionControl: false,
      center: defaultCenter,
      zoom: 17,
      maxZoom: 19,
    });

    // Dark-mode friendly OpenStreetMap Carto tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(this.map);

    // Custom user location beacon icon
    const userIcon = L.divIcon({
      className: 'user-gps-beacon',
      html: '<div class="beacon-pulse"></div><div class="beacon-dot"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    this.userMarker = L.marker(defaultCenter, { icon: userIcon }).addTo(this.map);

    // Accuracy circle
    this.userCircle = L.circle(defaultCenter, {
      radius: 12,
      color: '#3b82f6',
      fillColor: '#3b82f6',
      fillOpacity: 0.15,
      weight: 1.5,
    }).addTo(this.map);
  }

  _wireEvents() {
    if (!this.container) return;

    this.container.addEventListener('click', (e) => {
      // Don't toggle if clicking close button specifically
      if (e.target.closest('#mini-map-close-btn')) return;
      if (!this.isExpanded) {
        this.expand();
      }
    });

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.collapse();
      });
    }
  }

  expand() {
    this.isExpanded = true;
    this.container.classList.add('expanded');
    if (this.expandBtn) this.expandBtn.style.display = 'none';
    if (this.closeBtn) this.closeBtn.style.display = 'flex';

    setTimeout(() => {
      this.map && this.map.invalidateSize();
      this.fitView();
    }, 280);
  }

  collapse() {
    this.isExpanded = false;
    this.container.classList.remove('expanded');
    if (this.expandBtn) this.expandBtn.style.display = 'flex';
    if (this.closeBtn) this.closeBtn.style.display = 'none';

    setTimeout(() => {
      this.map && this.map.invalidateSize();
      this.fitView();
    }, 280);
  }

  updatePosition(lat, lon, accuracy = 10) {
    this.currentPosition = { lat, lon };
    if (!this.map || !this.userMarker) return;

    const latlng = [lat, lon];
    this.userMarker.setLatLng(latlng);
    if (this.userCircle) {
      this.userCircle.setLatLng(latlng);
      this.userCircle.setRadius(Math.max(8, accuracy));
    }

    if (!this.activeRoute) {
      this.map.panTo(latlng, { animate: true, duration: 0.5 });
    }
  }

  setRoute(polyline, destName, distanceMeters) {
    if (!this.map) return;
    this.activeRoute = { polyline, destName };

    // Show widget container if hidden
    this.container.style.display = 'block';

    // Remove old route layer
    if (this.routePolyline) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.destMarker) {
      this.map.removeLayer(this.destMarker);
      this.destMarker = null;
    }

    if (!polyline || polyline.length < 2) return;

    // Draw glowing route line
    this.routePolyline = L.polyline(polyline, {
      color: '#00e5cc',
      weight: 5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(this.map);

    // Destination pin
    const lastPoint = polyline[polyline.length - 1];
    const destIcon = L.divIcon({
      className: 'dest-flag-pin',
      html: `<div class="flag-bubble">🎯 ${destName || 'Destination'}</div><div class="flag-stem"></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
    });

    this.destMarker = L.marker(lastPoint, { icon: destIcon }).addTo(this.map);

    // Update distance badge
    if (this.distBadge) {
      this.distBadge.textContent = distanceMeters < 1000
        ? `${Math.round(distanceMeters)}m`
        : `${(distanceMeters / 1000).toFixed(1)}km`;
      this.distBadge.style.display = 'block';
    }

    this.fitView();
  }

  updateRemainingDistance(distanceMeters) {
    if (this.distBadge && distanceMeters != null) {
      this.distBadge.textContent = distanceMeters < 1000
        ? `${Math.round(distanceMeters)}m`
        : `${(distanceMeters / 1000).toFixed(1)}km`;
    }
  }

  clearRoute() {
    this.activeRoute = null;
    if (this.routePolyline && this.map) {
      this.map.removeLayer(this.routePolyline);
      this.routePolyline = null;
    }
    if (this.destMarker && this.map) {
      this.map.removeLayer(this.destMarker);
      this.destMarker = null;
    }
    if (this.distBadge) {
      this.distBadge.style.display = 'none';
    }
    if (this.currentPosition && this.map) {
      this.map.setView([this.currentPosition.lat, this.currentPosition.lon], 17);
    }
  }

  fitView() {
    if (!this.map) return;
    if (this.routePolyline) {
      this.map.fitBounds(this.routePolyline.getBounds(), {
        padding: this.isExpanded ? [30, 30] : [12, 12],
        maxZoom: 18,
      });
    } else if (this.currentPosition) {
      this.map.setView([this.currentPosition.lat, this.currentPosition.lon], this.isExpanded ? 18 : 17);
    }
  }
}

window.MiniMapController = MiniMapController;
