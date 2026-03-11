// =============================================
// RECOVERY & SHELTER MANAGEMENT — main JS
// =============================================

let currentPage = 'dashboard';
let chartLine = null, chartBar = null;
let allVictims = [], allShelters = [];

// ===================== PAGE NAV =====================
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const page = document.getElementById(`page-${pageId}`);
    if (page) page.style.display = 'block';

    const btn = document.querySelector(`.nav-btn[data-page="${pageId}"]`);
    if (btn) btn.classList.add('active');

    // Trigger load logic based on page
    if (pageId === 'dashboard') loadStats();
    if (pageId === 'victims') loadVictims();
    if (pageId === 'shelters') loadShelters();
    if (pageId === 'reports') loadDamageReports();
    if (pageId === 'claims') loadAidClaims();
}

// ===================== STATS =====================
async function loadStats() {
    const res = await fetch('/api/recovery/stats');
    const s = await res.json();

    document.getElementById('stat-rescued').textContent = s.rescued;
    document.getElementById('stat-shelters').textContent = s.total_shelters;
    document.getElementById('stat-beds').textContent = s.available_beds;
    document.getElementById('stat-critical').textContent = s.critical;
    document.getElementById('stat-reports').textContent = s.pending_reports;
    document.getElementById('stat-progress').textContent = s.recovery_progress + '%';

    renderProgressChart(s);
    renderShelterChart();
}

function renderProgressChart(stats) {
    const ctx = document.getElementById('chart-progress');
    if (!ctx) return;
    if (chartLine) chartLine.destroy();

    const labels = ['D-6', 'D-5', 'D-4', 'D-3', 'D-2', 'Yesterday', 'Today'];
    const base = stats.rescued;
    const data = [
        Math.max(0, base - 42), Math.max(0, base - 33),
        Math.max(0, base - 24), Math.max(0, base - 16),
        Math.max(0, base - 9), Math.max(0, base - 3), base
    ];

    chartLine = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Rescued',
                data,
                borderColor: '#00e676',
                backgroundColor: 'rgba(0,230,118,0.08)',
                borderWidth: 2,
                pointBackgroundColor: '#00e676',
                pointRadius: 4,
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#4a5a6e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
                y: { ticks: { color: '#4a5a6e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

async function renderShelterChart() {
    const ctx = document.getElementById('chart-shelter');
    if (!ctx) return;
    if (chartBar) chartBar.destroy();

    const res = await fetch('/api/recovery/shelters');
    const shelters = await res.json();

    const labels = shelters.map(s => s.name.split(' ').slice(0, 2).join(' '));
    const pct = shelters.map(s => Math.round(s.current_occupancy / s.total_capacity * 100));
    const colors = pct.map(p => p >= 90 ? '#ff3b3b' : p >= 70 ? '#ffaa00' : '#00e676');

    chartBar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Occupancy %',
                data: pct,
                backgroundColor: colors.map(c => c + '33'),
                borderColor: colors,
                borderWidth: 1.5,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#4a5a6e', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
                y: { max: 100, ticks: { color: '#4a5a6e', font: { size: 9 }, callback: v => v + '%' }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

// ===================== ACTIVITY =====================
async function loadActivity() {
    const res = await fetch('/api/recovery/activity');
    const items = await res.json();
    const feed = document.getElementById('activity-feed');

    if (!items.length) {
        feed.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No activity yet</p></div>';
        return;
    }

    feed.innerHTML = items.map(a => {
        const typeMap = {
            'VICTIM_STATUS': 'rescued', 'AUTO_ALLOCATE': 'shelter', 'SHELTER_UPDATE': 'shelter',
            'DAMAGE_REPORT': 'report', 'REPORT_ACTION': 'report',
            'AID_CLAIM': 'claim', 'CLAIM_ACTION': 'claim',
            'VICTIM_ADDED': 'shelter', 'VICTIM_ASSIGNED': 'shelter'
        };
        const dotType = typeMap[a.action] || 'system';
        const time = new Date(a.created_at).toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
        return `<div class="activity-item">
            <div class="activity-dot ${dotType}"></div>
            <div class="activity-text">${a.details}</div>
            <div class="activity-time">${time}</div>
        </div>`;
    }).join('');
}

// ===================== SHELTER TABLE =====================
async function loadShelterTable() {
    const res = await fetch('/api/recovery/shelters');
    allShelters = await res.json();
    const tbody = document.getElementById('shelter-tbody');

    tbody.innerHTML = allShelters.map(s => {
        const pct = Math.round(s.current_occupancy / s.total_capacity * 100);
        const fillClass = pct >= 90 ? 'high' : pct >= 70 ? 'medium' : 'low';
        const statusBadge = s.status === 'critical'
            ? `<span class="badge badge-critical">CRITICAL</span>`
            : `<span class="badge badge-active">ACTIVE</span>`;

        return `<tr>
            <td><strong>${s.name}</strong><br><span style="font-size:11px;color:var(--text-muted)">${s.address}</span></td>
            <td>
                <div class="cap-bar-wrap">
                    <div class="cap-bar"><div class="cap-fill ${fillClass}" style="width:${pct}%"></div></div>
                    <span class="cap-pct">${pct}%</span>
                </div>
                <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${s.current_occupancy}/${s.total_capacity}</span>
            </td>
            <td>${statusBadge}</td>
            <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary)">${s.contact || '—'}</td>
        </tr>`;
    }).join('');
}

// ===================== VICTIMS =====================
async function loadVictims(filter = '') {
    let url = '/api/recovery/victims';
    if (filter) url += `?status=${filter}`;
    const res = await fetch(url);
    allVictims = await res.json();
    renderVictimCards(allVictims);
}

function renderVictimCards(victims) {
    const grid = document.getElementById('victims-grid');
    if (!victims.length) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-icon">👤</div><p>No victims found</p></div>';
        return;
    }

    grid.innerHTML = victims.map(v => {
        const priorityClass = { HIGH: 'badge-high', MEDIUM: 'badge-medium', NORMAL: 'badge-normal' }[v.priority] || 'badge-normal';
        const statusClass = { rescued: 'badge-rescued', sheltered: 'badge-sheltered', missing: 'badge-missing' }[v.status] || 'badge-normal';
        const tags = (v.vulnerability_tags || '').split(',').filter(Boolean);

        return `<div class="victim-card" onclick="openVictimModal(${v.id})">
            <div class="victim-card-top">
                <div>
                    <div class="victim-name">${v.name}</div>
                    <div class="victim-meta">#${v.id} · ${v.age ? v.age + 'y' : 'Age N/A'} · ${v.gender || 'N/A'}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                    <span class="badge ${priorityClass}">${v.priority}</span>
                    <span class="badge ${statusClass}">${v.status}</span>
                </div>
            </div>
            ${v.medical_condition ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">💊 ${v.medical_condition}</div>` : ''}
            ${v.shelter_name ? `<div style="font-size:12px;color:var(--accent-primary);font-family:var(--font-mono)">🏠 ${v.shelter_name}</div>` : ''}
            <div class="victim-tags">
                ${tags.map(t => `<span class="badge badge-normal">${t.trim()}</span>`).join('')}
            </div>
        </div>`;
    }).join('');
}

function searchVictims() {
    const q = document.getElementById('victim-search').value.toLowerCase();
    const filtered = allVictims.filter(v =>
        v.name.toLowerCase().includes(q) ||
        (v.medical_condition || '').toLowerCase().includes(q) ||
        (v.vulnerability_tags || '').toLowerCase().includes(q)
    );
    renderVictimCards(filtered);
}

async function openVictimModal(id) {
    const res = await fetch(`/api/recovery/victims/${id}`);
    const v = await res.json();

    const shelterOptions = allShelters
        .filter(s => s.current_occupancy < s.total_capacity)
        .map(s => `<option value="${s.id}" ${v.shelter_id == s.id ? 'selected' : ''}>${s.name} (${s.total_capacity - s.current_occupancy} free)</option>`)
        .join('');

    const statusSteps = [
        { label: 'Reported', done: true },
        { label: 'Located', done: v.status !== 'missing' },
        { label: 'Sheltered', done: v.status === 'sheltered' || v.status === 'rescued' },
        { label: 'Rescued', done: v.status === 'rescued' }
    ];

    document.getElementById('modal-body').innerHTML = `
        <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
                <div style="font-family:var(--font-display);font-size:24px;font-weight:700;margin-bottom:4px">${v.name}</div>
                <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">#${v.id} · ${v.age || 'N/A'} yrs · ${v.gender || 'N/A'}</div>
                ${v.phone ? `<div style="margin-top:8px;font-size:13px">📱 ${v.phone}</div>` : ''}
                ${v.medical_condition ? `<div style="margin-top:6px;font-size:13px;color:var(--accent-warning)">💊 ${v.medical_condition}</div>` : ''}
            </div>
            <div>
                <span class="badge ${v.priority === 'HIGH' ? 'badge-high' : v.priority === 'MEDIUM' ? 'badge-medium' : 'badge-normal'}" style="font-size:14px;padding:6px 14px">${v.priority}</span>
            </div>
        </div>
        
        <div style="margin-bottom:20px">
            <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:1.5px;color:var(--text-muted);text-transform:uppercase;margin-bottom:10px">Status Timeline</div>
            <div class="status-timeline">
                ${statusSteps.map((s, i) => `
                <div class="timeline-item">
                    <div class="timeline-dot ${s.done ? (i === statusSteps.filter(x => x.done).length - 1 ? 'current' : 'done') : 'pending'}"></div>
                    <div style="font-size:13px;color:${s.done ? 'var(--text-primary)' : 'var(--text-muted)'}">${s.label}</div>
                </div>`).join('')}
            </div>
        </div>

        ${v.shelter_name ? `<div style="padding:10px;background:rgba(0,212,255,0.07);border-radius:8px;margin-bottom:14px;font-size:13px">🏠 Currently at: <strong>${v.shelter_name}</strong></div>` : ''}
        
        <div style="margin-bottom:16px">
            <div class="form-label" style="margin-bottom:8px">Assign / Reassign Shelter</div>
            <select class="form-select" id="modal-shelter-select" style="width:100%">
                <option value="">— Select Shelter —</option>
                ${shelterOptions}
            </select>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-success" onclick="markSafe(${v.id})">✅ Mark Safe / Rescued</button>
            <button class="btn btn-primary" onclick="assignToShelter(${v.id})">🏠 Assign Shelter</button>
            <button class="btn btn-danger btn-sm" onclick="closeModal()">✕ Close</button>
        </div>
    `;

    document.getElementById('modal-overlay').classList.add('open');
}

async function markSafe(id) {
    await fetch(`/api/recovery/victims/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rescued' })
    });
    showToast('✅ Victim marked as rescued', 'success');
    closeModal();
    loadVictims();
}

async function assignToShelter(id) {
    const sid = document.getElementById('modal-shelter-select').value;
    if (!sid) { showToast('⚠️ Select a shelter first', 'warning'); return; }
    await fetch(`/api/recovery/victims/${id}/assign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shelter_id: sid })
    });
    showToast('🏠 Victim assigned to shelter', 'success');
    closeModal();
    loadVictims();
    loadShelterTable();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
}

// ===================== SHELTERS =====================
async function loadShelters() {
    const res = await fetch('/api/recovery/shelters');
    allShelters = await res.json();
    renderShelterCards(allShelters);
}

function renderShelterCards(shelters) {
    const grid = document.getElementById('shelters-grid');
    grid.innerHTML = shelters.map(s => {
        const pct = Math.round(s.current_occupancy / s.total_capacity * 100);
        const fillClass = pct >= 90 ? 'high' : pct >= 70 ? 'medium' : 'low';
        const pctColor = pct >= 90 ? 'var(--accent-danger)' : pct >= 70 ? 'var(--accent-warning)' : 'var(--accent-success)';
        const statusClass = s.status === 'critical' ? 'status-critical' : pct >= 100 ? 'status-full' : 'status-active';

        return `<div class="shelter-card ${statusClass}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                    <div class="shelter-card-name">${s.name}</div>
                    <div class="shelter-card-addr">📍 ${s.address}</div>
                </div>
                <div class="shelter-pct" style="color:${pctColor}">${pct}%</div>
            </div>
            <div class="shelter-occ">
                <span>${s.current_occupancy} / ${s.total_capacity} beds</span>
                <span>${s.total_capacity - s.current_occupancy} available</span>
            </div>
            <div class="cap-bar" style="height:8px">
                <div class="cap-fill ${fillClass}" style="width:${pct}%"></div>
            </div>
            <div class="shelter-resources">
                <span class="resource-tag ${s.has_medical ? '' : 'unavailable'}">🏥 Medical</span>
                <span class="resource-tag ${s.has_food ? '' : 'unavailable'}">🍛 Food</span>
                <span class="resource-tag ${s.has_water ? '' : 'unavailable'}">💧 Water</span>
                <span class="resource-tag ${s.has_power ? '' : 'unavailable'}">⚡ Power</span>
            </div>
            ${s.contact ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">📞 ${s.contact}</div>` : ''}
        </div>`;
    }).join('');
}
// ===================== DAMAGE REPORTS =====================
async function loadDamageReports() {
    const res = await fetch('/api/recovery/damage-reports');
    const reports = await res.json();
    const list = document.getElementById('reports-list');

    if (!reports.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No damage reports yet</p></div>';
        return;
    }

    const sevColor = { critical: 'var(--accent-danger)', high: '#ff6b6b', medium: 'var(--accent-warning)', low: 'var(--accent-success)' };

    list.innerHTML = reports.map(r => `
    <div class="report-item" id="report-${r.id}">
            <div class="report-header">
                <div class="report-title">🔴 ${r.location} — ${r.damage_type}</div>
                <div style="display:flex;align-items:center;gap:8px">
                    <span class="badge ${r.status === 'verified' ? 'badge-rescued' : r.status === 'rejected' ? 'badge-high' : 'badge-medium'}">${r.status}</span>
                    <button onclick="deleteReport(${r.id})" title="Delete report" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:0.75rem;font-family:inherit">🗑️</button>
                </div>
            </div>
            <div style="font-size:1.05rem;color:var(--text-secondary);margin-bottom:10px;line-height:1.5">${r.description || 'No description'}</div>
            <div style="font-size:0.9rem;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:12px">
                <div style="margin-bottom:4px">📍 <strong>${r.location}</strong></div>
                <div style="color:${sevColor[r.severity]};font-weight:700;margin-bottom:4px">⚠️ SEVERITY: ${r.severity?.toUpperCase()}</div>
                👤 Reported by: ${r.reporter_name || 'Anonymous'} <br>
                <span style="opacity:0.6;font-size:0.85rem">📅 ${new Date(r.created_at).toLocaleString('en-IN', {timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true})}</span>
            </div>
            ${r.status === 'pending' ? `
            <div class="report-actions">
                <button class="btn btn-success btn-sm" onclick="actionReport(${r.id}, 'verified')">✅ Verify</button>
                <button class="btn btn-danger btn-sm" onclick="actionReport(${r.id}, 'rejected')">❌ Reject</button>
            </div>` : ''
        }
        </div>
    `).join('');
}

async function submitDamageReport(e) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);

    const res = await fetch('/api/recovery/damage-reports', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.success) {
        showToast('📋 Damage report submitted', 'success');
        form.reset();
        document.querySelectorAll('.severity-opt').forEach(o => o.classList.remove('selected'));
        loadDamageReports();
    }
}

async function actionReport(id, status) {
    await fetch(`/api/recovery/damage-reports/${id}/action`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, actor: 'admin' })
    });
    showToast(`Report ${status}`, status === 'verified' ? 'success' : 'error');
    loadDamageReports();
}

// ===================== AID CLAIMS =====================
async function loadAidClaims() {
    const res = await fetch('/api/recovery/aid-claims');
    const claims = await res.json();
    const list = document.getElementById('claims-list');

    if (!claims.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">💰</div><p>No aid claims yet</p></div>';
        return;
    }

    const total = claims.reduce((sum, c) => sum + (c.amount || 0), 0);
    const approved = claims.filter(c => c.status === 'approved').reduce((sum, c) => sum + (c.amount || 0), 0);

    document.getElementById('claims-summary').innerHTML = `
        <div style="display:flex;gap:32px;padding:20px;background:var(--bg-panel);border-radius:14px;margin-bottom:24px;border:1px solid var(--border-subtle)">
            <div><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">TOTAL FILED</div><div style="font-family:var(--font-display);font-size:2rem;font-weight:800;color:var(--accent-primary)">₹${total.toLocaleString()}</div></div>
            <div><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">APPROVED</div><div style="font-family:var(--font-display);font-size:2rem;font-weight:800;color:var(--accent-success)">₹${approved.toLocaleString()}</div></div>
            <div><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">PENDING</div><div style="font-family:var(--font-display);font-size:2rem;font-weight:800;color:var(--accent-warning)">${claims.filter(c => c.status === 'pending').length}</div></div>
        </div>
    `;

    list.innerHTML = claims.map(c => `
        <div class="claim-item" id="claim-${c.id}">
            <div class="claim-header">
                <div class="claim-title">₹${(c.amount || 0).toLocaleString()} — ${c.category}</div>
                <div style="display:flex;align-items:center;gap:8px">
                    <span class="badge ${c.status === 'approved' ? 'badge-rescued' : c.status === 'rejected' ? 'badge-high' : 'badge-medium'}">${c.status}</span>
                    <button onclick="deleteClaim(${c.id})" title="Delete claim" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:0.75rem;font-family:inherit">🗑️</button>
                </div>
            </div>
            <div style="font-size:1.05rem;color:var(--text-secondary);margin-bottom:10px;line-height:1.5">${c.description || 'No description'}</div>
            <div style="font-size:0.9rem;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:12px">
                👤 ${c.claimant_name || '(name not recorded)'} ${c.victim_name ? `· Victim: ${c.victim_name}` : ''} <br>
                <span style="opacity:0.6;font-size:0.85rem">📅 ${new Date(c.created_at).toLocaleString('en-IN', {timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true})}</span>
            </div>
            ${c.status === 'pending' ? `
            <div class="claim-actions">
                <button class="btn btn-success btn-sm" onclick="actionClaim(${c.id}, 'approved')">✅ Approve</button>
                <button class="btn btn-danger btn-sm" onclick="actionClaim(${c.id}, 'rejected')">❌ Reject</button>
            </div>` : ''}
        </div>
    `).join('');
}

async function submitAidClaim(e) {
    e.preventDefault();
    const form = e.target;
    const data = {
        claimant_name: form.claimant_name.value,
        category: form.category.value,
        amount: parseFloat(form.amount.value),
        description: form.description.value,
        victim_id: form.victim_id?.value || null
    };
    const res = await fetch('/api/recovery/aid-claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const result = await res.json();
    if (result.success) {
        showToast('💰 Aid claim submitted', 'success');
        form.reset();
        loadAidClaims();
    }
}

async function actionClaim(id, status) {
    await fetch(`/api/recovery/aid-claims/${id}/action`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, actor: 'admin' })
    });
    showToast(`Claim ${status}`, status === 'approved' ? 'success' : 'error');
    loadAidClaims();
}

async function deleteClaim(id) {
    if (!confirm(`Delete aid claim #${id}? This cannot be undone.`)) return;
    const res = await fetch(`/api/recovery/aid-claims/${id}`, { method: 'DELETE' });
    const d   = await res.json();
    if (d.success) {
        showToast(`Claim #${id} deleted`, 'error');
        document.getElementById(`claim-${id}`)?.remove();
        loadAidClaims();
    } else {
        showToast('Delete failed', 'error');
    }
}

async function deleteReport(id) {
    if (!confirm(`Delete damage report #${id}? This cannot be undone.`)) return;
    const res = await fetch(`/api/recovery/damage-reports/${id}`, { method: 'DELETE' });
    const d   = await res.json();
    if (d.success) {
        showToast(`Report #${id} deleted`, 'error');
        document.getElementById(`report-${id}`)?.remove();
        loadDamageReports();
    } else {
        showToast('Delete failed', 'error');
    }
}

// ===================== SEVERITY PICKER =====================
document.querySelectorAll('.severity-opt').forEach(opt => {
    opt.addEventListener('click', () => {
        document.querySelectorAll('.severity-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        const hidden = document.getElementById('severity-value');
        if (hidden) hidden.value = opt.dataset.val;
    });
});

// ===================== TOAST =====================
function showToast(msg, type = 'success') {
    let tc = document.getElementById('toast-container');
    if (!tc) {
        tc = document.createElement('div');
        tc.id = 'toast-container';
        tc.className = 'toast-container';
        document.body.appendChild(tc);
    }
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<div class="toast-icon">${type === 'success' ? '✓' : '!'}</div><div class="toast-msg">${msg}</div>`;
    tc.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', async () => {
    // Load shelters first (needed for route selects)
    const res = await fetch('/api/recovery/shelters');
    allShelters = await res.json();

    // Init nav tabs
    document.querySelectorAll('.nav-btn').forEach(tab => {
        tab.addEventListener('click', () => showPage(tab.dataset.page));
    });

    // Show dashboard by default
    showPage('dashboard');

    // Auto-refresh stats every 10s
    setInterval(() => {
        if (currentPage === 'dashboard') { loadStats(); loadActivity(); }
    }, 10000);

    // Add Victim quick form
    const addBtn = document.getElementById('btn-add-victim');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            document.getElementById('add-victim-modal').classList.add('open');
        });
    }
});

async function submitAddVictim(e) {
    e.preventDefault();
    const form = e.target;
    const tags = Array.from(form.querySelectorAll('input[name="vtag"]:checked')).map(c => c.value).join(', ');
    const data = {
        name: form.vname.value,
        age: form.vage.value,
        gender: form.vgender.value,
        phone: form.vphone.value,
        medical_condition: form.vmedical.value,
        vulnerability_tags: tags,
        priority: form.vpriority.value,
        priority_color: form.vpriority.value === 'HIGH' ? 'red' : form.vpriority.value === 'MEDIUM' ? 'yellow' : 'green',
        status: 'missing'
    };
    const res = await fetch('/api/recovery/victims', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await res.json();
    if (result.success) {
        showToast('👤 Victim registered', 'success');
        form.reset();
        document.getElementById('add-victim-modal').classList.remove('open');
        loadVictims();
    }
}