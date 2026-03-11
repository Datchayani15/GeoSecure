'use strict';

// ── State ─────────────────────────────────────────────────────
let userLocation = null, locationWatchId = null;
let currentSOSId = null, statusCheckInterval = null;
let lastKnownState = {status:'', hospital:'', reason:''};
let locationSendTimer = null;

// ── Map state ─────────────────────────────────────────────────
let victimMap = null, mapInitialized = false;
let victimMarker = null, hospitalMarker = null, ambulanceMarker = null;
let routePolyline = null;

// ── Tag pills toggle ──────────────────────────────────────────
document.querySelectorAll('.tag-pill').forEach(pill => {
  pill.addEventListener('change', () => {
    pill.classList.toggle('selected', pill.querySelector('input').checked);
  });
});

// ── Nav risk badge ────────────────────────────────────────────
async function loadNavRisk() {
  try {
    const d = await fetch('/api/predict').then(r => r.json());
    const dot = document.getElementById('navDot');
    const txt = document.getElementById('navRiskText');
    if (dot && txt) { dot.style.background = d.color; txt.textContent = d.risk_level; txt.style.color = d.color; }
    showRiskWarning(d.risk_level);
  } catch(e) {}
}

function showRiskWarning(level) {
  const w = document.getElementById('riskWarn');
  if (!w) return;
  if (level === 'CRITICAL') {
    w.className = 'risk-warn critical';
    w.innerHTML = '🚨 <b>CRITICAL FLOOD ALERT ACTIVE</b> — Rescue teams on high alert. Submit SOS immediately if in danger.';
    w.style.display = 'block';
  } else if (level === 'HIGH RISK') {
    w.className = 'risk-warn high';
    w.innerHTML = '⚠️ <b>HIGH RISK CONDITIONS</b> — Heavy rainfall predicted. Stay alert and prepare to evacuate.';
    w.style.display = 'block';
  } else {
    w.style.display = 'none';
  }
}

// ── Location tracking ─────────────────────────────────────────
function startLocationTracking() {
  if (!navigator.geolocation) { setLocBar('❌ Geolocation not supported', false); return; }
  locationWatchId = navigator.geolocation.watchPosition(
    pos => {
      userLocation = {latitude: pos.coords.latitude, longitude: pos.coords.longitude};
      const bar = document.getElementById('locationStatus');
      if (bar) {
        bar.innerHTML = `<span style="color:#22c55e;font-size:1rem">✓</span> Live GPS: ${userLocation.latitude.toFixed(5)}, ${userLocation.longitude.toFixed(5)}`;
        bar.classList.add('active');
      }
      // Update victim pin on map if active
      if (victimMarker && mapInitialized) {
        victimMarker.setLatLng([userLocation.latitude, userLocation.longitude]);
      }
      if (currentSOSId) debouncedLocationSend();
    },
    err => { setLocBar('⚠️ Enable GPS for emergency services', false); },
    {enableHighAccuracy: true, maximumAge: 0, timeout: 8000}
  );
}

function setLocBar(msg, active) {
  const bar = document.getElementById('locationStatus');
  if (!bar) return;
  bar.innerHTML = msg;
  if (active) bar.classList.add('active'); else bar.classList.remove('active');
}

function debouncedLocationSend() {
  if (locationSendTimer) return;
  locationSendTimer = setTimeout(() => {
    sendLocationToServer();
    locationSendTimer = null;
  }, 10000);
}

function sendLocationToServer() {
  if (!userLocation || !currentSOSId) return;
  fetch('/api/user/location', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(userLocation)
  }).catch(() => {});
}

// ── LIVE MAP ──────────────────────────────────────────────────
function initVictimMap(victimLat, victimLng) {
  if (mapInitialized) return;
  mapInitialized = true;

  victimMap = L.map('victimMap', {
    zoomControl: true,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true
  }).setView([victimLat, victimLng], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(victimMap);

  // Victim marker — pulsing red pin
  victimMarker = L.marker([victimLat, victimLng], {
    icon: L.divIcon({
      html: `<div style="position:relative">
        <div style="width:18px;height:18px;background:#ef4444;border-radius:50%;
          border:3px solid white;box-shadow:0 0 0 4px rgba(239,68,68,0.3);
          animation:vpin-pulse 2s infinite"></div>
        <div style="position:absolute;top:-22px;left:50%;transform:translateX(-50%);
          background:#ef4444;color:white;font-size:0.6rem;font-weight:700;
          padding:2px 6px;border-radius:10px;white-space:nowrap">YOU</div>
      </div>
      <style>@keyframes vpin-pulse{0%,100%{box-shadow:0 0 0 4px rgba(239,68,68,0.3)}
        50%{box-shadow:0 0 0 10px rgba(239,68,68,0.1)}}</style>`,
      className: '', iconSize: [24, 24], iconAnchor: [9, 9]
    })
  }).addTo(victimMap).bindPopup('<b>📍 Your Location</b>');
}

function showHospitalOnMap(hospLat, hospLng, hospName) {
  if (!mapInitialized || !victimMap) return;
  if (hospitalMarker) victimMap.removeLayer(hospitalMarker);
  hospitalMarker = L.marker([hospLat, hospLng], {
    icon: L.divIcon({
      html: `<div style="background:white;border-radius:50%;width:30px;height:30px;
        display:flex;align-items:center;justify-content:center;font-size:15px;
        border:2px solid #22c55e;box-shadow:0 2px 8px rgba(0,0,0,0.3)">🏥</div>`,
      className: '', iconSize: [30, 30], iconAnchor: [15, 15]
    })
  }).addTo(victimMap).bindPopup(`<b>🏥 ${hospName}</b><br>Your ambulance is coming from here`).openPopup();
}

// ── Server-synced ambulance tracking ─────────────────────────
// No independent OSRM call — position comes from server so both maps stay in sync

let syncPollInterval = null;
let routeDrawn = false;

function startSyncPolling(sosId) {
  if (syncPollInterval) clearInterval(syncPollInterval);
  syncPollInterval = setInterval(() => pollAmbulancePosition(sosId), 2000);
  pollAmbulancePosition(sosId); // immediate first call
}

async function pollAmbulancePosition(sosId) {
  try {
    const d = await fetch(`/api/sos/${sosId}/ambulance-position`).then(r => r.json());

    if (!d.ready) {
      // Not dispatched yet — just make sure hospital shows
      if (d.hospital_lat && !routeDrawn) {
        showHospitalOnMap(d.hospital_lat, d.hospital_lon, d.hospital_name);
        document.getElementById('vmapSub').textContent = 'Awaiting dispatch...';
      }
      return;
    }

    // First time we get route coords — draw the route line
    if (!routeDrawn && d.route_coords && d.route_coords.length) {
      routeDrawn = true;
      if (routePolyline) victimMap.removeLayer(routePolyline);
      routePolyline = L.polyline(d.route_coords, {color:'#22c55e', weight:5, opacity:0.85})
        .addTo(victimMap);
      // Extend bounds to include the victim's current live position
      const bounds = routePolyline.getBounds();
      if (victimMarker) bounds.extend(victimMarker.getLatLng());
      victimMap.fitBounds(bounds, {padding:[40,40]});

      // Show ETA bar
      const etaBar = document.getElementById('etaBar');
      if (etaBar) etaBar.style.display = 'flex';
    }

    // Move ambulance to server-computed position
    if (!ambulanceMarker) {
      ambulanceMarker = L.marker([d.amb_lat, d.amb_lng], {
        icon: L.divIcon({
          html: `<div style="background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:white;
            border-radius:50%;width:32px;height:32px;display:flex;align-items:center;
            justify-content:center;font-size:15px;border:3px solid white;
            box-shadow:0 0 0 4px rgba(59,130,246,0.3);animation:ambpulse 1s infinite">🚑</div>
            <style>@keyframes ambpulse{0%,100%{box-shadow:0 0 0 4px rgba(59,130,246,0.3)}
              50%{box-shadow:0 0 0 10px rgba(59,130,246,0.1)}}</style>`,
          className:'', iconSize:[32,32], iconAnchor:[16,16]
        })
      }).addTo(victimMap).bindPopup('<b>🚑 Ambulance</b><br>En route to you');
    } else {
      ambulanceMarker.setLatLng([d.amb_lat, d.amb_lng]);
    }

    // Update ETA display
    updateEtaDisplay(d.eta_seconds);
    const pct = Math.round(d.progress * 100);
    const bar = document.getElementById('etaProgress');
    if (bar) bar.style.width = pct + '%';
    const sub = document.getElementById('vmapSub');
    if (sub) sub.textContent = `${d.hospital_name} · ${Math.ceil(d.eta_seconds/60)} min ETA`;

    // Arrived
    if (d.progress >= 1.0) {
      stopAmbulanceAnim();
      if (ambulanceMarker) victimMap.removeLayer(ambulanceMarker);
      ambulanceMarker = L.marker([d.amb_lat, d.amb_lng], {
        icon: L.divIcon({
          html: `<div style="background:#22c55e;color:white;border-radius:50%;
            width:36px;height:36px;display:flex;align-items:center;justify-content:center;
            font-size:18px;border:3px solid white;
            box-shadow:0 4px 16px rgba(34,197,94,0.5)">✅</div>`,
          className:'', iconSize:[36,36], iconAnchor:[18,18]
        })
      }).addTo(victimMap).bindPopup('<b>✅ Ambulance Arrived!</b>').openPopup();
      document.getElementById('vmapSub').textContent = '🎉 Ambulance has arrived!';
      const etaBar = document.getElementById('etaBar');
      if (etaBar) etaBar.style.display = 'none';
      const etaNum = document.getElementById('etaNum');
      if (etaNum) etaNum.textContent = 'Arrived!';
    }

  } catch(e) {}
}

function updateEtaDisplay(seconds) {
  const el = document.getElementById('etaNum');
  if (!el) return;
  if (seconds <= 0) { el.textContent = 'Arrived!'; return; }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  el.textContent = m > 0 ? `~${m} min` : `${s}s`;
}

function stopAmbulanceAnim() {
  if (syncPollInterval) { clearInterval(syncPollInterval); syncPollInterval = null; }
}

function showVictimMap() {
  const wrap = document.getElementById('victimMapWrap');
  if (wrap) wrap.style.display = 'block';
  // Force Leaflet to recalculate size after display:block
  setTimeout(() => { if (victimMap) victimMap.invalidateSize(); }, 100);
}

// ── Status polling ────────────────────────────────────────────
function startStatusTracking(sosId) {
  currentSOSId = sosId;
  lastKnownState = {status:'', hospital:'', reason:''};
  if (statusCheckInterval) clearInterval(statusCheckInterval);
  statusCheckInterval = setInterval(async () => {
    try {
      const d = await fetch('/api/victim/my-sos').then(r => r.json());
      if (d.found && d.sos && d.sos.id >= currentSOSId) updateStatusUI(d.sos);
    } catch(e) {}
  }, 4000);
}

function stopStatusTracking() {
  if (statusCheckInterval) { clearInterval(statusCheckInterval); statusCheckInterval = null; }
}

function updateStatusUI(sos) {
  const cur = {status: sos.status, hospital: sos.hospital_name, reason: sos.reassigned_reason || ''};
  if (JSON.stringify(cur) === JSON.stringify(lastKnownState)) return;

  const hospitalChanged = lastKnownState.hospital && lastKnownState.hospital !== sos.hospital_name;
  lastKnownState = cur;

  const pri = sos.priority_level || sos.priority;

  if (sos.status === 'Rescued') {
    stopAmbulanceAnim();
    if (etaTimer) { clearInterval(etaTimer); etaTimer = null; }
    showResult(`
      <div class="result-card rescued">
        <div class="rc-header">
          <div class="rc-icon green">✅</div>
          <div><div class="rc-title">Help Has Arrived</div>
          <div class="rc-sub">Rescue team is with you now</div></div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Hospital</span><span class="rc-val">${sos.hospital_name || 'N/A'}</span></div>
          ${sos.reassigned_reason ? `<div class="rc-row"><span class="rc-key">Note</span><span class="rc-val">${sos.reassigned_reason}</span></div>` : ''}
        </div>
        <div style="text-align:center;padding:16px 0;font-size:0.85rem;color:#86efac">
          You are safe. Please follow the rescue team's instructions.
        </div>
      </div>`);
    stopStatusTracking();
    // Update map to show arrived state
    document.getElementById('vmapSub').textContent = '🎉 Ambulance has arrived!';
    const etaBarEl = document.getElementById('etaBar');
    if (etaBarEl) etaBarEl.style.display = 'none';
    const etaNumEl = document.getElementById('etaNum');
    if (etaNumEl) etaNumEl.textContent = 'Arrived!';

  } else if (sos.status === 'Assigned') {
    const isSwitched = hospitalChanged || sos.reassigned_reason;
    showResult(`
      <div class="result-card ${isSwitched ? 'switched' : 'assigned'}">
        <div class="rc-header">
          <div class="rc-icon ${isSwitched ? 'orange' : 'green'}">${isSwitched ? '⚠️' : '🚑'}</div>
          <div>
            <div class="rc-title">${isSwitched ? 'Dispatch Updated' : 'Ambulance En Route'}</div>
            <div class="rc-sub">SOS #${sos.id} · ${isSwitched ? 'Route changed — road block detected' : (sos.reassigned_reason ? 'AI Rerouting optimized' : 'Help is on the way')}</div>
          </div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Hospital</span><span class="rc-val">${sos.hospital_name || 'Locating...'}</span></div>
          <div class="rc-row"><span class="rc-key">Priority</span>
            <span class="rc-val"><span class="priority-badge p-${pri}">${pri}</span></span>
          </div>
          ${sos.medical_condition ? `<div class="rc-row"><span class="rc-key">Condition</span><span class="rc-val">${sos.medical_condition}</span></div>` : ''}
        </div>
        
        ${sos.reassigned_reason ? `
        <div class="intel-box">
          <div class="intel-head">
            <span class="intel-shield">🛡️</span>
            <b>Route Intelligence:</b>
          </div>
          <div class="intel-msg">${sos.reassigned_reason}</div>
          ${sos.block_image ? `
          <div class="intel-img-wrap">
            <img src="/static/images/${sos.block_image}" class="intel-img" alt="Road block" onerror="this.parentElement.style.display='none'">
          </div>` : ''}
        </div>` : ''}

        <div class="live-track" style="margin-top:20px">
          <div class="live-dot"></div> See live map below — ambulance is moving toward you
        </div>
        <button onclick="cancelSOS()" class="btn-cancel">Cancel SOS (false alarm)</button>
      </div>`);

    // Show map and draw/redraw route if hospital changed
    if (sos.hospital_lat && sos.hospital_lon) {
      showVictimMap();
      showHospitalOnMap(sos.hospital_lat, sos.hospital_lon, sos.hospital_name);
      if (hospitalChanged) {
        // Hospital changed — reset route so it redraws
        routeDrawn = false;
        if (routePolyline) { victimMap.removeLayer(routePolyline); routePolyline = null; }
        if (ambulanceMarker) { victimMap.removeLayer(ambulanceMarker); ambulanceMarker = null; }
      }
      // Start/continue polling server for synced ambulance position
      startSyncPolling(sos.id);
    }

  } else if (sos.status === 'NEW') {
    showResult(`
      <div class="result-card sent">
        <div class="rc-header">
          <div class="rc-icon blue">📡</div>
          <div><div class="rc-title">SOS Received</div>
          <div class="rc-sub">SOS #${sos.id} · Awaiting dispatch</div></div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Hospital</span>
            <span class="rc-val">${sos.hospital_name || 'Locating nearest...'}</span>
          </div>
          <div class="rc-row"><span class="rc-key">Priority</span>
            <span class="rc-val"><span class="priority-badge p-${pri}">${pri}</span></span>
          </div>
        </div>
        <div class="live-track" style="margin-top:12px"><div class="live-dot"></div> Rescue team notified — do not move</div>
        <button onclick="cancelSOS()" class="btn-cancel">Cancel SOS (false alarm)</button>
      </div>`);
    // Show map with just victim pin while waiting
    showVictimMap();
    if (sos.hospital_lat && sos.hospital_lon) {
      showHospitalOnMap(sos.hospital_lat, sos.hospital_lon, sos.hospital_name);
    }
  }
}

// ── Show result card ──────────────────────────────────────────
function showResult(html) {
  const ws = document.getElementById('waitingState');
  const sr = document.getElementById('sosResult');
  if (ws) ws.style.display = 'none';
  if (sr) { sr.style.display = 'block'; sr.innerHTML = html; }
}

// ── Cancel SOS ────────────────────────────────────────────────
async function cancelSOS() {
  if (!currentSOSId || !confirm('Are you sure you want to cancel your SOS?')) return;
  try { await fetch(`/api/victim/sos/${currentSOSId}/cancel`, {method:'POST'}); } catch(e) {}
  stopStatusTracking();
  stopAmbulanceAnim(); // also clears syncPollInterval
  routeDrawn = false;
  currentSOSId = null;
  // Reset UI
  document.getElementById('waitingState').style.display = 'block';
  const sr = document.getElementById('sosResult');
  sr.style.display = 'none'; sr.innerHTML = '';
  document.getElementById('victimMapWrap').style.display = 'none';
  document.getElementById('sosButton').disabled = false;
  const label = document.getElementById('sosLabel');
  if (label) label.style.opacity = '1';
}

// ── SOS submission ────────────────────────────────────────────
async function submitSOS(isQuick) {
  if (!userLocation) { alert('⚠️ Location not ready — please wait a moment'); return; }

  const btn     = document.getElementById('sosButton');
  const label   = document.getElementById('sosLabel');
  const spinner = document.getElementById('sosSpinner');
  btn.disabled = true;
  if (label)   label.style.opacity   = '0';
  if (spinner) spinner.style.display = 'block';

  try {
    const fd = new FormData();
    fd.append('latitude',  userLocation.latitude);
    fd.append('longitude', userLocation.longitude);
    const medical = document.getElementById('medical').value;
    if (medical) fd.append('medical_condition', medical);
    const tags = Array.from(document.querySelectorAll('input[name="vulnerability"]:checked'))
      .map(c => c.value).join(', ');
    if (tags) fd.append('vulnerability_tags', tags);
    const photo = document.getElementById('photoInput').files[0];
    if (photo) fd.append('photo', photo);
    fd.append('is_quick', isQuick ? 'true' : 'false');

    const d = await fetch('/api/victim/sos', {method:'POST', body:fd}).then(r => r.json());
    if (!d.success) throw new Error(d.error || 'Failed to send SOS');
    currentSOSId = d.sos_id;

    // Show initial sent card
    showResult(`
      <div class="result-card sent">
        <div class="rc-header">
          <div class="rc-icon blue">✅</div>
          <div><div class="rc-title">SOS Sent Successfully</div>
          <div class="rc-sub">Request #${d.sos_id} — rescue team notified</div></div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Name</span><span class="rc-val">${d.name}</span></div>
          <div class="rc-row"><span class="rc-key">Phone</span><span class="rc-val">${d.phone}</span></div>
          <div class="rc-row"><span class="rc-key">Priority</span>
            <span class="rc-val"><span class="priority-badge p-${d.priority}">${d.priority}</span></span>
          </div>
          <div class="rc-row"><span class="rc-key">Hospital</span>
            <span class="rc-val">${d.hospital?.name || 'Locating...'} ${d.hospital?.distance ? '(' + d.hospital.distance.toFixed(1) + ' km)' : ''}</span>
          </div>
          ${d.current_risk_level ? `<div class="rc-row"><span class="rc-key">Alert Level</span><span class="rc-val">${d.current_risk_level}</span></div>` : ''}
        </div>
        <div class="live-track"><div class="live-dot"></div> Live tracking active — stay where you are</div>
      </div>`);

    // Show map immediately with victim pin
    showVictimMap();
    initVictimMap(userLocation.latitude, userLocation.longitude);

    // Show hospital on map if returned
    if (d.hospital?.lat && d.hospital?.lng) {
      showHospitalOnMap(d.hospital.lat, d.hospital.lng, d.hospital.name);
      document.getElementById('vmapSub').textContent = `Awaiting dispatch — ${d.hospital.name}`;
    }

    startStatusTracking(d.sos_id);
    debouncedLocationSend();

    if (!isQuick) {
      document.getElementById('sosForm').reset();
      document.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('selected'));
      document.getElementById('photoPreview').style.display = 'none';
    }

  } catch(err) {
    showResult(`
      <div class="result-card" style="border-color:rgba(239,68,68,0.3)">
        <div class="rc-header">
          <div class="rc-icon" style="background:rgba(239,68,68,0.15)">❌</div>
          <div><div class="rc-title">Submission Failed</div><div class="rc-sub">${err.message}</div></div>
        </div>
        <p style="font-size:0.85rem;color:var(--muted);margin-top:12px">
          Please try again or call <b style="color:#f87171">1916</b> — Tamil Nadu Disaster Helpline
        </p>
      </div>`);
    btn.disabled = false;
  } finally {
    if (label)   label.style.opacity   = '1';
    if (spinner) spinner.style.display = 'none';
    if (!currentSOSId) btn.disabled = false;
  }
}

function quickSOS() { submitSOS(true); }

async function submitDetailedSOS(e) {
  e.preventDefault();
  const btn  = e.target.querySelector('button[type="submit"]');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '⏳ Sending...';
  await submitSOS(false);
  btn.disabled = false; btn.innerHTML = orig;
}

function previewPhoto(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const p = document.getElementById('photoPreview');
    p.src = ev.target.result; p.style.display = 'block';
    document.querySelector('.photo-text').textContent = 'Photo attached ✓';
  };
  r.readAsDataURL(f);
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  startLocationTracking();
  loadNavRisk();
  setInterval(loadNavRisk, 120000);
  if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();

  // ── Resume if SOS already active from a previous session / reload ──
  try {
    const d = await fetch('/api/victim/my-sos').then(r => r.json());
    if (d.found && d.sos && !['Rescued','Cancelled'].includes(d.sos.status)) {
      console.log(`▶ Resuming SOS #${d.sos.id} status=${d.sos.status}`);
      currentSOSId = d.sos.id;
      // Show the map immediately using stored location from SOS
      const lat = d.sos.latitude, lng = d.sos.longitude;
      showVictimMap();
      initVictimMap(lat, lng);
      if (d.sos.hospital_lat) showHospitalOnMap(d.sos.hospital_lat, d.sos.hospital_lon, d.sos.hospital_name);
      // Force updateStatusUI to run by clearing lastKnownState
      lastKnownState = {status:'', hospital:'', reason:''};
      updateStatusUI(d.sos);
      startStatusTracking(d.sos.id);
      // Start sync polling immediately if already dispatched
      if (d.sos.status === 'Assigned') startSyncPolling(d.sos.id);
    }
  } catch(e) {}
});

window.addEventListener('beforeunload', () => {
  if (locationWatchId) navigator.geolocation.clearWatch(locationWatchId);
  stopStatusTracking();
  stopAmbulanceAnim();
  if (locationSendTimer) clearTimeout(locationSendTimer);
});