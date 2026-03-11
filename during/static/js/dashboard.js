const ROAD_BLOCK_TYPES = [
  {reason:"Flooded road detected",    image:"flood.jpg"},
  {reason:"Tree fallen on road",      image:"tree.jpg"},
  {reason:"Earthquake damaged road",  image:"earthquake.jpg"},
  {reason:"Heavy traffic congestion", image:"traffic.jpg"},
  {reason:"Road under construction",  image:"construction.jpg"}
];

let map, sosList=[], selectedSOS=null, markers={}, routeLayers=[], blockLayers=[],
    animationInterval=null, ambulanceMarker=null, hospitalMarkers=[],
    nearestHospital=null, refreshInterval=null, routeRefreshPending=false,
    currentRouteRequestId=0;
    
// Keep track of placed roadblocks by coordinate string to avoid duplicates/flicker
let activeBlockKeys = new Set();
let roadBlockCount = 0;
let lastBlockImage = null;

// ── Toast notification system ─────────────────────────────────
function toast(msg, type='info', duration=4000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = `position:fixed;top:70px;right:20px;z-index:9999;
      display:flex;flex-direction:column;gap:8px;pointer-events:none`;
    document.body.appendChild(container);
  }
  const colors = {
    info:    {bg:'rgba(59,130,246,0.15)',  border:'rgba(59,130,246,0.4)',  icon:'ℹ️'},
    success: {bg:'rgba(34,197,94,0.15)',   border:'rgba(34,197,94,0.4)',   icon:'✅'},
    warning: {bg:'rgba(249,115,22,0.15)',  border:'rgba(249,115,22,0.4)',  icon:'⚠️'},
    error:   {bg:'rgba(239,68,68,0.15)',   border:'rgba(239,68,68,0.4)',   icon:'🚨'},
    sos:     {bg:'rgba(239,68,68,0.2)',    border:'rgba(239,68,68,0.6)',   icon:'🆘'},
  };
  const c = colors[type] || colors.info;
  const t = document.createElement('div');
  t.style.cssText = `background:${c.bg};border:1px solid ${c.border};
    backdrop-filter:blur(12px);border-radius:10px;padding:10px 16px;
    font-size:0.82rem;color:#e2e8f0;font-family:'DM Sans',sans-serif;
    display:flex;align-items:center;gap:8px;min-width:260px;max-width:340px;
    box-shadow:0 4px 20px rgba(0,0,0,0.4);pointer-events:auto;
    animation:slideInToast 0.3s ease`;
  t.innerHTML = `<span style="font-size:1rem;flex-shrink:0">${c.icon}</span><span>${msg}</span>`;
  const style = document.createElement('style');
  style.textContent = `@keyframes slideInToast{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}`;
  document.head.appendChild(style);
  container.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(), 300); }, duration);
}

const intelLog = document.getElementById('intelLog');
function addIntel(msg) {
  if (!intelLog) return;
  const time = new Date().toLocaleTimeString();
  const item = document.createElement('div');
  item.className = 'intel-item';
  item.innerHTML = `<span style="color:var(--blue);font-weight:700">[${time}]</span> ${msg}`;
  intelLog.prepend(item);
  if (intelLog.children.length > 20) intelLog.lastChild.remove();
}

// ── Nav risk badge ─────────────────────────────────────────────
async function loadNavRisk() {
  try {
    const d = await fetch('/api/predict').then(r => r.json());
    if (d.risk_level === 'CRITICAL') addIntel('🚨 SEVERE RISK DETECTED: Evacuation protocols advised.');
    const dot = document.getElementById('rpillDot');
    const txt = document.getElementById('rpillText');
    if (dot) dot.style.background = d.color;
    if (txt) { txt.textContent = d.risk_level + ' · ' + d.confidence + '%'; txt.style.color = d.color; }
  } catch(e) {}
}

// ── Map init ──────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {zoomControl:true}).setView([13.08, 80.27], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:'© OpenStreetMap', maxZoom:19
  }).addTo(map);
  map.on('click', async e => {
    if (confirm('🚧 Mark this point as road block?')) {
      const res = await fetch('/api/admin/roadblock', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({lat: e.latlng.lat, lng: e.latlng.lng})
      }).then(r => r.json());
      
      if (res.success) {
        const key = `${e.latlng.lat.toFixed(6)},${e.latlng.lng.toFixed(6)}`;
        activeBlockKeys.add(key);
        addBlockToMap(e.latlng.lat, e.latlng.lng, res.reason, res.image);
        toast(`🚧 <b>Manually Placed:</b> ${res.reason}`, 'warning', 6000);
        if (selectedSOS) setTimeout(() => showRoute(), 400);
      }
    }
  });
}

// ── Stats ─────────────────────────────────────────────────────
function updateStats() {
  const t = document.getElementById('statTotal');
  const p = document.getElementById('statPending');
  const a = document.getElementById('statAssigned');
  const r = document.getElementById('statRescued');
  const b = document.getElementById('statBlocks');
  
  if (t) t.textContent = sosList.length;
  if (p) p.textContent = sosList.filter(s => s.status === 'NEW').length;
  if (a) a.textContent = sosList.filter(s => s.status === 'Assigned').length;
  if (r) r.textContent = sosList.filter(s => s.status === 'Rescued').length;
  if (b) b.textContent = roadBlockCount;
}

// ── Load SOS ──────────────────────────────────────────────────
async function loadSOS() {
  try {
    const res = await fetch('/api/admin/sos');
    if (!res.ok) return;
    const newList = await res.json();
    const prevMax = sosList.length > 0 ? Math.max(...sosList.map(s => s.id)) : 0;
    const newMax  = newList.length  > 0 ? Math.max(...newList.map(s => s.id))  : 0;

    // Check if selected SOS victim has moved — only then refresh route
    if (selectedSOS) {
      const upd = newList.find(s => s.id === selectedSOS.id);
      if (upd) {
        const moved = Math.abs(upd.latitude  - selectedSOS.latitude)  > 0.0001 ||
                      Math.abs(upd.longitude - selectedSOS.longitude) > 0.0001;
        if (moved && selectedSOS.status === 'Assigned') {
          selectedSOS = upd;
          toast(`SOS #${upd.id} victim location updated`, 'info', 2500);
          if (!routeRefreshPending) {
            routeRefreshPending = true;
            setTimeout(() => { showRoute(); routeRefreshPending = false; }, 1000);
          }
        } else {
          selectedSOS = upd; // update data silently without re-routing
        }
      }
    }

    if (sosList.length === 0 && newList.length > 0 && map.getZoom() <= 11)
      map.setView([newList[0].latitude, newList[0].longitude], 13);

    sosList = newList;
    renderSOSList();
    updateStats();

    // New SOS arrived — alert admin
    if (newMax > prevMax) {
      const latest = sosList.find(s => s.id === newMax);
      if (latest) {
        toast(`🆘 New SOS from ${latest.name} — Priority: ${latest.priority}`, 'sos', 6000);
        selectSOS(latest.id);
      }
    }
  } catch(e) {}
}

// ── Render sidebar list ───────────────────────────────────────
function renderSOSList() {
  const list = document.getElementById('sosList');
  if (!sosList.length) {
    list.innerHTML = '<div class="empty-state">No active SOS requests</div>';
    return;
  }
  list.innerHTML = sosList.map(s => `
    <div class="sos-item${selectedSOS?.id === s.id ? ' active' : ''}" onclick="selectSOS(${s.id})">
      <div class="sos-item-top">
        <span class="sos-item-name">SOS #${s.id} — ${s.name}</span>
        <span class="badge badge-${s.priority}">${s.priority}</span>
      </div>
      <div class="sos-item-meta">${s.phone || 'No phone'} &middot; ${new Date(s.timestamp.replace(' ', 'T') + 'Z').toLocaleTimeString()}</div>
      <div class="sos-item-bottom">
        <span class="badge badge-${s.status.replace(/\s/g,'')}">${s.status}</span>
        ${s.is_offline ? '<span class="badge badge-offline">📶 Offline</span>' : ''}
        ${s.risk_level_at_sos ? `<span class="badge" style="background:rgba(100,116,139,0.2);color:#94a3b8">${s.risk_level_at_sos}</span>` : ''}
      </div>
    </div>`).join('');

  // Refresh map markers
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
  sosList.forEach(s => {
    const priorityColor = s.priority === 'HIGH' ? '#ef4444' : s.priority === 'MEDIUM' ? '#f97316' : '#22c55e';
    markers[s.id] = L.marker([s.latitude, s.longitude], {icon: L.divIcon({
      html: `<div style="background:${priorityColor};color:white;border-radius:50%;
        width:32px;height:32px;display:flex;align-items:center;justify-content:center;
        font-size:14px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);
        font-weight:700">${s.priority[0]}</div>`,
      className:'', iconSize:[32,32], iconAnchor:[16,16]
    })}).addTo(map)
      .bindPopup(`<b>${s.name}</b><br>Priority: ${s.priority}<br>Status: ${s.status}${s.medical_condition?'<br>Condition: '+s.medical_condition:''}`)
      .on('click', () => selectSOS(s.id));
  });
}

// ── Select SOS ────────────────────────────────────────────────
async function selectSOS(id, skipReset=false) {
  selectedSOS = sosList.find(s => s.id === id);
  if (!selectedSOS) return;

  if (!skipReset) {
    map.setView([selectedSOS.latitude, selectedSOS.longitude], 14);
    startDashboardRefresh();
    showNearestHospitals(selectedSOS.latitude, selectedSOS.longitude); // non-blocking
  }

  const s = selectedSOS;
  document.getElementById('sosDetails').innerHTML = `
    <div class="d-rows">
      <div class="d-row"><span class="d-key">Name</span><span class="d-val">${s.name}</span></div>
      <div class="d-row"><span class="d-key">Phone</span>
        <span class="d-val"><a href="tel:${s.phone}" style="color:#60a5fa;text-decoration:none">${s.phone || 'N/A'}</a></span>
      </div>
      <div class="d-row"><span class="d-key">Priority</span>
        <span class="d-val"><span class="badge badge-${s.priority}">${s.priority}</span></span>
      </div>
      <div class="d-row"><span class="d-key">Status</span>
        <span class="d-val"><span class="badge badge-${s.status.replace(/\s/g,'')}">${s.status}</span></span>
      </div>
      <div class="d-row"><span class="d-key">Location</span>
        <span class="d-val">${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}</span>
      </div>
      ${s.medical_condition ? `<div class="d-row"><span class="d-key">Condition</span><span class="d-val">${s.medical_condition}</span></div>` : ''}
      ${s.vulnerability_tags ? `<div class="d-row"><span class="d-key">Tags</span><span class="d-val">${s.vulnerability_tags}</span></div>` : ''}
      ${s.hospital_name ? `<div class="d-row"><span class="d-key">Hospital</span><span class="d-val" id="assignedHosp">${s.hospital_name}</span></div>` : ''}
      ${s.risk_level_at_sos ? `<div class="d-row"><span class="d-key">Risk at SOS</span><span class="d-val">${s.risk_level_at_sos}</span></div>` : ''}
      ${s.reassigned_reason ? `<div class="d-row"><span class="d-key">Route Note</span><span class="d-val" style="color:#93c5fd;font-size:0.78rem">${s.reassigned_reason}</span></div>` : ''}
      ${s.photo_path ? `<div class="d-row" style="flex-direction:column;gap:6px">
        <span class="d-key">Photo</span>
        <img src="/uploads/${s.photo_path}" style="width:100%;border-radius:8px;border:1px solid #1a2744;cursor:pointer"
          onclick="window.open('/uploads/${s.photo_path}','_blank')" title="Click to open full size">
      </div>` : ''}
    </div>
    <div class="detail-actions">
      <button class="dact-btn dact-route"   onclick="showRoute()">🗺️ Show Route</button>
      <button class="dact-btn dact-rescue"  onclick="updateStatus('Assigned')" ${s.status==='Assigned'?'style="opacity:0.5"':''}>🚑 Dispatch</button>
      <button class="dact-btn dact-rescue"  onclick="updateStatus('Rescued')">✅ Rescued</button>
      <button class="dact-btn dact-delete"  onclick="deleteSOS()">🗑️ Delete</button>
    </div>`;

  renderSOSList();
  if (s.status === 'Assigned') setTimeout(() => showRoute(), 100);
}

// ── Status update ─────────────────────────────────────────────
async function updateStatus(status, targetId=null) {
  const sosId = targetId || (selectedSOS ? selectedSOS.id : null);
  if (!sosId) { toast('Select a victim first', 'warning'); return; }

  await fetch(`/api/admin/sos/${sosId}/status`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({status})
  });

  const sos = sosList.find(s => s.id === sosId);
  if (sos) sos.status = status;

  const statusText = document.getElementById('mapStatusText');
  
  if (status === 'Rescued') {
    stopAnimation(); clearMap();
    if (statusText) statusText.innerHTML = '✅ Victim Rescued & Safe';
    addIntel(`Mission Accomplished: Victim #${sosId} is safe.`);
    toast(`SOS #${sosId} marked as Rescued ✅`, 'success');
  } else if (status === 'Assigned') {
    if (statusText) statusText.innerHTML = '🚑 Ambulance Dispatched';
    addIntel(`Urgent: Ambulance dispatched to location #${sosId}.`);
    toast(`Ambulance dispatched for SOS #${sosId} 🚑`, 'success');
    setTimeout(() => showRoute(), 300);
  }

  await loadSOS();
  if (selectedSOS && selectedSOS.id === sosId) await selectSOS(selectedSOS.id, true);
}

async function deleteSOS() {
  if (!selectedSOS || !confirm('Delete this SOS request?')) return;
  await fetch(`/api/admin/sos/${selectedSOS.id}`, {method:'DELETE'});
  toast(`SOS #${selectedSOS.id} deleted`, 'warning');
  if (markers[selectedSOS.id]) map.removeLayer(markers[selectedSOS.id]);
  delete markers[selectedSOS.id];
  selectedSOS = null;
  document.getElementById('sosDetails').innerHTML = '<p class="empty-txt">Click an SOS request to view details</p>';
  clearMap(); loadSOS();
}

// ── Auto assign — parallel not sequential ─────────────────────
async function autoAssignAll() {
  const pending = sosList.filter(s => s.status === 'NEW');
  if (!pending.length) { toast('No pending SOS requests', 'info'); return; }
  // Fire all in parallel instead of sequential
  await Promise.all(pending.map(sos =>
    fetch(`/api/admin/sos/${sos.id}/status`, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({status: 'Assigned'})
    })
  ));
  toast(`✅ Dispatched ambulances for ${pending.length} SOS requests`, 'success', 5000);
  await loadSOS();
}

// ── Hospitals ─────────────────────────────────────────────────
async function showNearestHospitals(lat, lng) {
  hospitalMarkers.forEach(m => map.removeLayer(m));
  hospitalMarkers = [];
  try {
    const hospitals = await fetch(`/api/hospitals?lat=${lat}&lng=${lng}&limit=3`).then(r => r.json());
    hospitals.forEach((h, i) => {
      const m = L.circleMarker([h.latitude, h.longitude], {
        radius: i===0 ? 9 : 6,
        color: i===0 ? '#22c55e' : '#4ade80',
        fillColor: i===0 ? '#22c55e' : '#4ade80',
        fillOpacity: 0.9, weight: 2
      }).addTo(map).bindPopup(`<b>🏥 ${h.name}</b><br>${h.distance} km away${i===0?' · <b>NEAREST</b>':''}`);
      hospitalMarkers.push(m);
      if (i===0) nearestHospital = {lat: h.latitude, lng: h.longitude, name: h.name};
    });
  } catch(e) {}
}

// ── Road blocks ───────────────────────────────────────────────
async function simulateRoadBlock() {
  try {
    const data = await fetch('/api/simulate-roadblock').then(r => r.json());
    addIntel(`Obstacle Reported: ${data.reason} detected.`);
    const key = `${data.lat.toFixed(6)},${data.lng.toFixed(6)}`;
    activeBlockKeys.add(key);
    addBlockToMap(data.lat, data.lng, data.reason, data.image);
    map.setView([data.lat, data.lng], 14);
    toast(`🚧 <b>Road Blocked:</b> ${data.reason}`, 'warning', 6000);
    if (selectedSOS) setTimeout(() => showRoute(), 800);
  } catch(e) { toast('Failed to simulate roadblock', 'error'); }
}

// Block details logic moved to top

async function loadRoadBlocks() {
  try {
    const data = await fetch('/api/admin/roadblocks').then(r => r.json());
    if (data.road_blocks) {
      data.road_blocks.forEach(rb => {
        const key = `${rb.lat.toFixed(6)},${rb.lng.toFixed(6)}`;
        if (!activeBlockKeys.has(key)) {
          addBlockToMap(rb.lat, rb.lng, rb.reason, rb.image, false);
          activeBlockKeys.add(key);
        }
      });
    }
  } catch(e) { console.error('Failed to load roadblocks:', e); }
}

function addBlockToMap(lat, lng, reason, image, autoOpen=true) {
  // FOOLPROOF FALLBACK: If server data is missing metadata, assign a signature now
  if (!reason || !image) {
    const fallback = ROAD_BLOCK_TYPES[Math.floor(Math.random() * ROAD_BLOCK_TYPES.length)];
    reason = reason || fallback.reason;
    image  = image  || fallback.image;
  }
  
  lastBlockImage = image || null;
  const content = `
    <div style="font-family:'DM Sans',sans-serif;width:200px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:20px">🚧</span>
        <b style="color:#ef4444;font-size:0.95rem">${reason || 'Obstacle Detected'}</b>
      </div>
      ${image ? `<img src="/static/images/${image}" style="width:100%;border-radius:10px;border:2px solid #334155;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:block" alt="${reason}">` : 
                '<div style="background:#1e293b;padding:12px;border-radius:8px;color:#94a3b8;font-size:0.75rem;text-align:center">Road structurally compromised. No visual data available.</div>'}
      <div style="margin-top:8px;font-size:0.7rem;color:#64748b;text-align:right">Ref: BLK-${Math.floor(Math.random()*9000)+1000}</div>
    </div>
  `;

  const m = L.marker([lat, lng], {icon: L.divIcon({
    html: '<div style="font-size:26px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));cursor:pointer">🚧</div>',
    className:'', iconSize:[32,32], iconAnchor:[16,16]
  })}).addTo(map).bindPopup(content, {maxWidth: 220});
  
  const c = L.circle([lat, lng], {radius:250, color:'#ef4444', weight:2, fillColor:'#ef4444', fillOpacity:0.2}).addTo(map);
  
  blockLayers.push(m, c);
  roadBlockCount = activeBlockKeys.size; // Sync with actual key count
  updateStats();
  
  // Auto-open if allowed
  if (autoOpen) setTimeout(() => m.openPopup(), 400);
}

async function simulateBlockOnRoute() {
  const routeLine = routeLayers.find(l => l instanceof L.Polyline && l.options.color === '#22c55e');
  if (!routeLine) { 
    toast('No active green rescue route to block!', 'info');
    return; 
  }
  
  const lats = routeLine.getLatLngs();
  if (lats.length < 10) { 
    toast('Route too short to simulate an effective block', 'info'); 
    return; 
  }
  
  // Pick a random point between 20% and 80% of the route to ensure it's "on the way"
  const startIndex = Math.floor(lats.length * 0.2);
  const endIndex = Math.floor(lats.length * 0.8);
  const randomIndex = Math.floor(Math.random() * (endIndex - startIndex)) + startIndex;
  const mid = lats[randomIndex];
  
  const rb = ROAD_BLOCK_TYPES[Math.floor(Math.random() * ROAD_BLOCK_TYPES.length)];
  
  const res = await fetch('/api/admin/roadblock', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({lat: mid.lat, lng: mid.lng})
  }).then(r => r.json());
  
  if (res.success) {
    const key = `${mid.lat.toFixed(6)},${mid.lng.toFixed(6)}`;
    activeBlockKeys.add(key);
    addBlockToMap(mid.lat, mid.lng, res.reason, res.image);
    addIntel(`CRITICAL: Route blocked by ${res.reason}. Rerouting...`);
    map.setView([mid.lat, mid.lng], 15);
    toast(`🚨 <b>ROUTE BLOCKED:</b> ${res.reason}`, 'error', 7000);
  }
  
  if (selectedSOS) {
    setTimeout(() => {
      toast('🔄 <b>AI REROUTING:</b> Finding clear alternative path...', 'info', 4000);
      showRoute();
    }, 1500);
  }
}

async function clearRoadBlocks() {
  if (!confirm('Remove all road blocks?')) return;
  await fetch('/api/admin/roadblock/clear', {method:'POST'});
  blockLayers.forEach(l => map.removeLayer(l));
  blockLayers = [];
  activeBlockKeys.clear();
  roadBlockCount = 0;
  updateStats();
  toast('All road blocks cleared', 'success');
  if (selectedSOS) showRoute();
}

// ── Route helpers ─────────────────────────────────────────────
function isRouteBlocked(coords, blocks) {
  if (!blocks.length) return false;
  // Increase from 80m to 150m. The visual red circle for a block is radius: 250
  return blocks.some(b => coords.some(c => map.distance([c[0],c[1]], [b.lat, b.lng]) < 150));
}

function clearMap() {
  stopAnimation();
  routeLayers.forEach(l => map.removeLayer(l)); routeLayers = [];
  hospitalMarkers.forEach(h => map.removeLayer(h)); hospitalMarkers = [];
}

function stopAnimation() {
  if (animationInterval)  { clearInterval(animationInterval);  animationInterval  = null; }
  if (syncPollInterval)   { clearInterval(syncPollInterval);   syncPollInterval   = null; }
  if (ambulanceMarker)    { map.removeLayer(ambulanceMarker);  ambulanceMarker    = null; }
}

// ── Show route ────────────────────────────────────────────────
async function showRoute() {
  if (!selectedSOS) return;
  const requestId = ++currentRouteRequestId;
  try {
    clearMap();

    // Victim marker
    routeLayers.push(L.marker([selectedSOS.latitude, selectedSOS.longitude], {icon: L.divIcon({
      html: `<div style="background:linear-gradient(135deg,#b91c1c,#ef4444);color:white;
        border-radius:50%;width:44px;height:44px;display:flex;align-items:center;
        justify-content:center;font-size:20px;border:3px solid white;
        box-shadow:0 4px 16px rgba(239,68,68,0.5)">🆘</div>`,
      className:'', iconSize:[44,44]
    })}).addTo(map).bindPopup(`<b>VICTIM: ${selectedSOS.name}</b>`));

    const routeData = await fetch('/api/admin/route', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({end:{lat: selectedSOS.latitude, lng: selectedSOS.longitude}})
    }).then(r => r.json());
    const roadBlocks = routeData.road_blocks || [];

    let hospitals = [];
    try {
      hospitals = await fetch(`/api/hospitals?lat=${selectedSOS.latitude}&lng=${selectedSOS.longitude}&limit=15&radius=15000`)
        .then(r => r.json());
    } catch(e) {}
    if (!hospitals.length && selectedSOS.hospital_lat) {
      hospitals = [{name: selectedSOS.hospital_name, latitude: selectedSOS.hospital_lat,
                    longitude: selectedSOS.hospital_lon, distance: 0}];
    }
    if (!hospitals.length) { toast('No hospitals found nearby', 'error'); return; }

    let bestRoute=null, bestHosp=null, reason='Optimal clear route found';
    let realDuration = 0;
    let blockImage = null;  // image filename of the roadblock that caused rerouting
    const primary = hospitals[0];

    for (let i=0; i<hospitals.length; i++) {
      const h = hospitals[i];
      const url = `https://router.project-osrm.org/route/v1/driving/${h.longitude},${h.latitude};${selectedSOS.longitude},${selectedSOS.latitude}?overview=full&geometries=geojson&alternatives=true`;
      try {
        const res = await fetch(url).then(r => r.json());
        if (!res.routes) continue;
        for (const route of res.routes) {
          const coords = route.geometry.coordinates.map(c => [c[1],c[0]]);
          if (!isRouteBlocked(coords, roadBlocks)) {
            bestRoute = route; bestHosp = h;
            if (i > 0) {
              blockImage = lastBlockImage;  // use the actual image from the placed roadblock
              reason = `⚠️ Route to ${primary.name} blocked — rerouted to ${h.name}.`;
            } else {
              reason = `✅ Fastest direct route from ${h.name}.`;
            }
            break;
          }
        }
        if (bestRoute) break;
      } catch(e) {}
    }

    let animCoords=null, animDur=15000;

    if (bestRoute) {
      if (bestHosp.name !== selectedSOS.hospital_name || !selectedSOS.reassigned_reason) {
        await fetch(`/api/admin/sos/${selectedSOS.id}/hospital`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({hospital_name: bestHosp.name, hospital_lat: bestHosp.latitude,
                                hospital_lon: bestHosp.longitude, reassigned_reason: reason,
                                block_image: blockImage})
        });
        Object.assign(selectedSOS, {hospital_name: bestHosp.name, hospital_lat: bestHosp.latitude,
          hospital_lon: bestHosp.longitude, reassigned_reason: reason, block_image: blockImage});
      }

      const coords = bestRoute.geometry.coordinates.map(c => [c[1],c[0]]);
      const dist   = (bestRoute.distance / 1000).toFixed(2);
      const eta    = Math.round(bestRoute.duration / 60);

      if (requestId !== currentRouteRequestId) return; // Discard stale request

      // Hospital marker (now managed primarily by showNearestHospitals, but add here to be safe if that didn't run)
      if(hospitalMarkers.length === 0) {
        routeLayers.push(L.marker([bestHosp.latitude, bestHosp.longitude], {icon: L.divIcon({
          html: `<div style="background:white;border-radius:50%;width:32px;height:32px;
            display:flex;align-items:center;justify-content:center;font-size:16px;
            border:2px solid #22c55e;box-shadow:0 2px 8px rgba(0,0,0,0.3)">🏥</div>`,
          className:'', iconSize:[32,32]
        })}).addTo(map).bindPopup(`<b>${bestHosp.name}</b><br>${dist} km · ETA ~${eta} min<br><i>${reason}</i>`));
      }

      // Route line
      routeLayers.push(L.polyline(coords, {color:'#22c55e', weight:7, opacity:0.9})
        .addTo(map).bindPopup(`<b>Dispatch Route</b><br>${bestHosp.name} → ${dist} km · ETA ~${eta} min`));

      // Update UI
      const hospEl = document.getElementById('assignedHosp');
      if (hospEl) hospEl.textContent = `${bestHosp.name} (~${eta} min)`;

      toast(`Route found: ${bestHosp.name} · ${dist}km · ~${eta} min ETA`, 'success', 5000);
      animCoords   = coords;
      // Speed factor 10× — ambulance traverses the real route 10x faster for demo purposes
      realDuration = Math.max(30, bestRoute.duration / 10);

    } else {
      const detour = await probeDetour(hospitals[0], selectedSOS, roadBlocks);
      if (detour) {
        const coords = detour.geometry.coordinates.map(c => [c[1],c[0]]);
        routeLayers.push(L.polyline(coords, {color:'#f59e0b', weight:7, opacity:0.8, dashArray:'12,8'})
          .addTo(map).bindPopup('<b>⚠️ DETOUR ROUTE</b><br>All direct paths blocked'));
        toast('All direct routes blocked — using detour', 'warning', 6000);
        animCoords = coords; animDur = 20000; realDuration = 1200; // ~20 min estimate
      } else {
        toast('🛑 ALL ROUTES BLOCKED — Manual dispatch required!', 'error', 10000);
      }
    }

    if (animCoords) {
      // Build bounds from route + victim marker so both are always visible
      const routeBounds = L.latLngBounds(animCoords);
      routeBounds.extend([selectedSOS.latitude, selectedSOS.longitude]);
      map.fitBounds(routeBounds, {padding:[50,50]});
      // Save REAL route duration to server (not the visual animation speed)
      // Both admin and victim read back from server using real elapsed time
      await fetch(`/api/sos/${selectedSOS.id}/route`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({coords: animCoords, duration: realDuration})
      }).catch(() => {});
      // Admin map animation also driven by server polling
      startSyncedAmbulance(selectedSOS.id, animCoords);
    }

  } catch(err) {
    console.error('showRoute error:', err);
    toast('Route calculation failed — check connection', 'error');
  }
}

async function probeDetour(hospital, sos, roadBlocks) {
  const d = 0.02;
  for (const [dLat, dLng] of [[d,0],[-d,0],[0,d],[0,-d]]) {
    const url = `https://router.project-osrm.org/route/v1/driving/${hospital.longitude},${hospital.latitude};${hospital.longitude+dLng},${hospital.latitude+dLat};${sos.longitude},${sos.latitude}?overview=full&geometries=geojson`;
    try {
      const res = await fetch(url).then(r => r.json());
      if (res.routes?.length) {
        const coords = res.routes[0].geometry.coordinates.map(c => [c[1],c[0]]);
        if (!isRouteBlocked(coords, roadBlocks)) return res.routes[0];
      }
    } catch(e) {}
  }
  return null;
}

// ── Synced ambulance animation (driven by server clock) ──────
let syncPollInterval = null;

function startSyncedAmbulance(sosId, coords) {
  stopAnimation();
  if (!coords.length) return;

  // Progress bar in detail panel
  const detailPanel = document.querySelector('.detail-panel');
  let progressBar   = document.getElementById('ambulanceProgress');
  if (!progressBar && detailPanel) {
    const prog = document.createElement('div');
    prog.innerHTML = `<div style="margin-top:8px">
      <div style="font-size:0.75rem;color:#64748b;margin-bottom:4px">🚑 Ambulance en route</div>
      <div style="background:#1a2744;border-radius:4px;height:6px;overflow:hidden">
        <div id="ambulanceProgress" style="height:100%;background:#3b82f6;width:0%;
          transition:width 0.5s;border-radius:4px"></div>
      </div></div>`;
    detailPanel.appendChild(prog);
    progressBar = document.getElementById('ambulanceProgress');
  }

  // Place ambulance marker at start
  if (ambulanceMarker) map.removeLayer(ambulanceMarker);
  ambulanceMarker = L.marker(coords[0], {icon: makeAmbIcon()}).addTo(map);

  // Poll server every 2s — SAME endpoint victim uses — guaranteed sync
  if (syncPollInterval) clearInterval(syncPollInterval);
  syncPollInterval = setInterval(async () => {
    try {
      const d = await fetch(`/api/sos/${sosId}/ambulance-position`).then(r => r.json());
      if (!d.ready) return;

      // Move marker to server-computed position
      ambulanceMarker.setLatLng([d.amb_lat, d.amb_lng]);

      const pct = Math.round(d.progress * 100);
      const bar = document.getElementById('ambulanceProgress');
      if (bar) bar.style.width = pct + '%';

      // Update ETA in hospital field
      const hospEl = document.getElementById('assignedHosp');
      if (hospEl && d.eta_seconds > 0) {
        const m = Math.ceil(d.eta_seconds / 60);
        hospEl.textContent = `${d.hospital_name} (~${m} min)`;
      }

      if (d.progress >= 1.0) {
        clearInterval(syncPollInterval); syncPollInterval = null;
        if (bar) bar.style.width = '100%';
        if (ambulanceMarker) map.removeLayer(ambulanceMarker);
        
        // Clear route line and other temporary markers
        clearMap();

        ambulanceMarker = L.marker([d.amb_lat, d.amb_lng], {icon: makeArrivedIcon()}).addTo(map)
          .bindPopup('<b>✅ Ambulance Arrived!</b>').openPopup();
        const hospEl = document.getElementById('assignedHosp');
        if (hospEl) hospEl.textContent = `${d.hospital_name} · ✅ Arrived`;
        const progLabel = bar?.previousElementSibling;
        if (progLabel) progLabel.textContent = '✅ Ambulance arrived at victim location';
        toast('🎉 Ambulance has reached the destination!', 'success', 8000);
      }
    } catch(e) {}
  }, 2000);
}

function makeAmbIcon() {
  return L.divIcon({
    html: `<div style="background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:white;
      border-radius:50%;width:34px;height:34px;display:flex;align-items:center;
      justify-content:center;font-size:16px;border:3px solid white;
      box-shadow:0 4px 12px rgba(59,130,246,0.6);animation:amb-pulse 1s infinite">🚑</div>
      <style>@keyframes amb-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}</style>`,
    className:'', iconSize:[34,34]
  });
}

function makeArrivedIcon() {
  return L.divIcon({
    html: `<div style="background:#22c55e;color:white;border-radius:50%;width:40px;height:40px;
      display:flex;align-items:center;justify-content:center;font-size:20px;
      border:3px solid white;box-shadow:0 4px 16px rgba(34,197,94,0.7)">✅</div>`,
    className:'', iconSize:[40,40]
  });
}

// ── Auto refresh — only data, NOT route ───────────────────────
function startDashboardRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  // Refresh SOS list data every 5s — but NOT route (too expensive)
  refreshInterval = setInterval(loadSOS, 5000);
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadSOS();
  loadNavRisk();
  loadRoadBlocks();
  setInterval(loadSOS, 5000);
  setInterval(loadNavRisk, 60000);
  setInterval(loadRoadBlocks, 10000); // sync roadblocks every 10s
});