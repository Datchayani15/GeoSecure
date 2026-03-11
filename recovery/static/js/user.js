let userMap = null;
let userMarker = null;
let shelterMarker = null;
let routeControl = null;
let allShelters = [];

document.addEventListener('DOMContentLoaded', () => {
    initUserMap();
    loadShelters();
});

function showToast(msg, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<div class="toast-icon">${type === 'success' ? '✓' : '!'}</div><div class="toast-msg">${msg}</div>`;
    document.getElementById('toastArea').appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function initUserMap() {
    if (userMap) return;
    userMap = L.map('userMap').setView([11.1271, 78.6569], 7); // Center defaults to Tamil Nadu

    // Dark modern map tiles to match the theme
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(userMap);
}

async function loadShelters() {
    try {
        const res = await fetch('/api/recovery/shelters');
        allShelters = await res.json();
    } catch (e) {
        console.error("Failed to load shelters", e);
        showToast("Error loading shelters from server.", "error");
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function findNearestShelter() {
    const statusDiv = document.getElementById('loc-status-text');
    const btn = document.getElementById('btn-find-loc');

    statusDiv.textContent = "Acquiring GPS signal...";
    statusDiv.classList.add('status-scanning');
    btn.disabled = true;
    btn.innerHTML = '<span>📡 SCANNING...</span>';

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const userLat = position.coords.latitude;
                const userLng = position.coords.longitude;
                statusDiv.textContent = "Location Acquired ✔️";
                statusDiv.classList.remove('status-scanning');
                btn.innerHTML = '<span>📍 FIND MY LOCATION & ROUTE</span>';
                btn.disabled = false;
                processLocation(userLat, userLng);
            },
            (error) => {
                console.error("Geolocation error:", error);
                statusDiv.textContent = "GPS Failed. Using mock location.";
                statusDiv.classList.remove('status-scanning');
                btn.innerHTML = '<span>📍 RE-TRY LOCATION</span>';
                btn.disabled = false;
                showToast("Real location failed. Simulating random active location.", "warning");
                // Mock location somewhere in TN
                const mockLat = 11.1271 + (Math.random() - 0.5) * 2;
                const mockLng = 78.6569 + (Math.random() - 0.5) * 2;
                processLocation(mockLat, mockLng);
            },
            { enableHighAccuracy: true, timeout: 5000 }
        );
    } else {
        statusDiv.textContent = "Geolocation not supported.";
        statusDiv.classList.remove('status-scanning');
        btn.innerHTML = '<span>🚫 UNSUPPORTED BROWSER</span>';
    }
}

async function processLocation(lat, lng) {
    if (!allShelters.length) {
        showToast("No active shelters available.", "error");
        return;
    }

    // 1. Sort shelters by distance (Haversine)
    const availableShelters = allShelters.filter(s => s.current_occupancy < s.total_capacity && s.status === 'active');

    if (availableShelters.length === 0) {
        showToast("All safe zones are currently full.", "error");
        return;
    }

    availableShelters.forEach(s => {
        s.distance = calculateDistance(lat, lng, s.latitude, s.longitude);
    });

    availableShelters.sort((a, b) => a.distance - b.distance);
    const nearest = availableShelters[0];

    // 2. Update Map Markers
    if (userMarker) userMap.removeLayer(userMarker);
    if (shelterMarker) userMap.removeLayer(shelterMarker);

    // User icon
    const userHtml = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff3366" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3" fill="#ff3366"></circle></svg>`;
    const userIcon = L.divIcon({
        className: 'custom-leaflet-icon',
        html: `<div class="user-marker-pulse" style="background:var(--bg-card); padding:3px; border-radius:50%; border:2px solid #ff3366;">${userHtml}</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16]
    });
    userMarker = L.marker([lat, lng], { icon: userIcon }).addTo(userMap).bindPopup("<b>⚠️ YOUR LOCATION</b>");

    // Shelter icon
    const shHtml = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00f2fe" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>`;
    const shelterIcon = L.divIcon({
        className: 'custom-leaflet-icon',
        html: `<div style="background:var(--bg-card); padding:5px; border-radius:50%; border:2px solid #00f2fe; box-shadow: 0 0 15px rgba(0, 242, 254, 0.5);">${shHtml}</div>`,
        iconSize: [36, 36], iconAnchor: [18, 18]
    });
    shelterMarker = L.marker([nearest.latitude, nearest.longitude], { icon: shelterIcon }).addTo(userMap).bindPopup(`<b>🛡️ ${nearest.name}</b><br>Nearest Safe Zone`);

    // 3. Clear old routes
    userMap.eachLayer(layer => {
        if (layer.options && layer.options.pane === 'overlayPane' && !layer.options.icon) {
            userMap.removeLayer(layer);
        }
    });

    // 4. Request OSRM Route
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${lng},${lat};${nearest.longitude},${nearest.latitude}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        const data = await res.json();

        let displayDist = nearest.distance.toFixed(1);
        let timeMin = "N/A";

        if (data.code === 'Ok' && data.routes.length > 0) {
            const route = data.routes[0];
            displayDist = (route.distance / 1000).toFixed(1);
            timeMin = Math.round(route.duration / 60);

            const geojson = L.geoJSON(route.geometry, {
                style: { color: '#00f2fe', weight: 6, opacity: 0.9, dashArray: '15, 15', className: 'flowing-route' }
            }).addTo(userMap);

            userMap.fitBounds(geojson.getBounds(), { padding: [50, 50] });
        } else {
            // Fallback map bounds if routing fails
            const bounds = L.latLngBounds([[lat, lng], [nearest.latitude, nearest.longitude]]);
            userMap.fitBounds(bounds, { padding: [50, 50] });
        }

        // 5. Update UI
        document.getElementById('nearestShelterDetails').style.display = 'block';
        document.getElementById('nsName').textContent = nearest.name;
        document.getElementById('nsDist').textContent = displayDist;
        document.getElementById('nsTime').textContent = timeMin;
        document.getElementById('nsVacancy').textContent = (nearest.total_capacity - nearest.current_occupancy);

        showToast("Nearest safe zone identified.", "success");

    } catch (e) {
        console.error(e);
        showToast("Error planning route.", "error");
    }
}

function startNavigation() {
    showToast("Navigation started. Stay safe and follow the highlighted route.", "success");
    // In a real app, this might trigger native maps intent or live tracking
}
