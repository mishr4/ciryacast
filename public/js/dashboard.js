// ── Avatar helper ──
function getAvatarUrl(user) {
  // 1) CiryaSSO avatar
  const ssoAvatar = user.avatar_url || user.profile_picture || user.photo_url || user.picture || '';
  if (ssoAvatar) return ssoAvatar;
  // 2) UI Avatars fallback (no MD5 needed, generates from name/email)
  const name = encodeURIComponent(user.display_name || user.email || '?');
  return `https://ui-avatars.com/api/?name=${name}&size=96&background=7C4DFF&color=fff&rounded=true&bold=true`;
}

// ── Auth Gate ──
(function checkAuth() {
  const user = sessionStorage.getItem('ciryacast_user');
  if (!user) {
    window.location.href = '/login';
    return;
  }
  try {
    const u = JSON.parse(user);
    const nameEl = document.getElementById('sidebar-username');
    const handleEl = document.getElementById('sidebar-handle');
    const avatarEl = document.getElementById('sidebar-avatar');
    if (nameEl) nameEl.textContent = u.display_name || u.cirya_handle || 'User';
    if (handleEl) handleEl.textContent = u.cirya_handle ? '@' + u.cirya_handle : u.email || '';
    if (avatarEl) {
      const pic = getAvatarUrl(u);
      if (pic) {
        avatarEl.innerHTML = `<img src="${pic}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`;
      } else {
        avatarEl.textContent = (u.display_name || '?')[0].toUpperCase();
      }
    }
  } catch {}
})();

function signOut() {
  sessionStorage.removeItem('ciryacast_user');
  if (window.CiryaSSO) CiryaSSO.signOut();
  window.location.href = '/login';
}

// ── State ──
let stations = [];
let currentStationId = null;
let allMedia = []; // cached for search filtering

// Check if current user is a local manager (not admin/SSO)
function getCurrentUser() {
  try { return JSON.parse(sessionStorage.getItem('ciryacast_user')); } catch { return null; }
}
function isLocalManager() {
  const u = getCurrentUser();
  return u && u.auth_type === 'local' && u.role === 'manager';
}
function getAssignedStationIds() {
  const u = getCurrentUser();
  if (!u || !u.assigned_stations) return null; // null = show all (admin)
  return u.assigned_stations.map(s => s.id);
}

// Hide admin-only nav items for managers
(function restrictNav() {
  if (isLocalManager()) {
    document.querySelectorAll('.nav-item[data-view="users"], .nav-item[data-view="djs"]').forEach(el => el.style.display = 'none');
    const newStationBtn = document.getElementById('btn-new-station');
    if (newStationBtn) newStationBtn.style.display = 'none';
  }
})();
let ws = null;

// ── API helper ──
async function api(path, opts = {}) {
  try {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) { console.error(`API ${path} → ${res.status}`); return null; }
    return await res.json();
  } catch (e) { console.error(`API ${path} failed:`, e); return null; }
}

// ── WebSocket ──
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    if (type === 'nowplaying' || type === 'track_change') refreshDashboard();
    if (type === 'listeners') refreshDashboard();
    if (type === 'media_uploaded') { refreshMedia(); refreshDashboard(); }
    if (type === 'station_created' || type === 'station_deleted') { loadStations(); refreshDashboard(); }
    if (type === 'song_request') refreshRequests();
    if (type === 'queue_update') refreshDashboard();
    if (type === 'live_start' || type === 'live_end') { refreshDashboard(); refreshDJs(); }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

// ── Navigation ──
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.getElementById('view-title').textContent = btn.querySelector('span')?.textContent || 'Dashboard';
    if (view === 'media') refreshMedia();
    if (view === 'history') refreshHistory();
    if (view === 'stations') loadStations();
    if (view === 'requests') refreshRequests();
    if (view === 'djs') refreshDJs();
    if (view === 'users') refreshUsers();
    if (view === 'scheduling') loadScheduledShows();
    if (view === 'playlists') loadPlaylists();
    if (view === 'voicetracks') loadVoiceTracks();
    closeMobileSidebar();
  });
});

// ── Mobile Menu ──
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.querySelector('.sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('show'); });
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeMobileSidebar);
function closeMobileSidebar() { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('show'); }

// ════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════
async function refreshDashboard() {
  try {
    const stats = await api('/stats');
    if (stats) {
      document.getElementById('stat-stations').textContent = stats.stations;
      document.getElementById('stat-listeners').textContent = stats.total_listeners;
      document.getElementById('stat-media').textContent = stats.total_media;
      document.getElementById('stat-played').textContent = stats.total_played;
    }
    const data = await api('/stations');
    if (data) {
      const allowed = getAssignedStationIds();
      stations = allowed ? data.filter(s => allowed.includes(s.id)) : data;
    }
    renderDashboardStations();
    populateStationSelect();
  } catch (e) { console.error('Dashboard refresh error:', e); }
}

function renderDashboardStations() {
  const el = document.getElementById('dashboard-stations');
  if (!stations || stations.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg></div>
      <h3>No stations yet</h3><p>Create your first station to get started</p>
    </div>`;
    return;
  }

  el.innerHTML = stations.map(s => {
    const np = s.now_playing;
    const running = s.autodj_running;
    const artUrl = np?.artwork_url || '';
    const elapsed = np?.elapsed || 0;
    const duration = np?.duration || 0;
    const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

    return `
      <div class="card now-playing-card" style="margin-bottom:16px">
        <div class="np-info">
          <div class="np-art" ${artUrl ? `style="background:none"` : ''}>
            ${artUrl
              ? `<img src="${esc(artUrl)}" style="width:100%;height:100%;object-fit:cover;border-radius:14px">`
              : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
            }
          </div>
          <div class="np-meta" style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">
              <h3>${esc(s.name)}</h3>
              ${s.live
                ? '<span class="badge" style="background:#ff1744;color:#fff">🎙 LIVE</span>'
                : `<span class="badge ${running ? 'badge-green' : 'badge-red'}">${running ? 'ON AIR' : 'OFFLINE'}</span>`
              }
              ${np?.is_request ? '<span class="badge badge-purple">REQUEST</span>' : ''}
            </div>
            <div style="font-size:12px;color:#666;margin-bottom:6px">
              ${s.owner ? `Owner: <strong>${esc(s.owner.display_name || s.owner.email)}</strong>` : 'No owner'}
              ${s.member_count ? `• ${s.member_count} member${s.member_count !== 1 ? 's' : ''}` : ''}
            </div>
            ${np ? `<p style="font-size:14px;color:#444">${esc(np.artist)} — ${esc(np.title)}</p>` : '<p style="color:#999">Nothing playing</p>'}
            ${np && duration > 0 ? `
              <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
                <span style="font-size:11px;color:#999;font-weight:500;min-width:36px">${formatDuration(elapsed)}</span>
                <div style="flex:1;height:4px;background:#eee;border-radius:2px;overflow:hidden">
                  <div style="width:${progress}%;height:100%;background:linear-gradient(90deg,#7C4DFF,#FF48BC);border-radius:2px;transition:width 1s linear"></div>
                </div>
                <span style="font-size:11px;color:#999;font-weight:500;min-width:36px;text-align:right">${formatDuration(duration)}</span>
              </div>
            ` : ''}
          </div>
          <div class="station-meta">
            <div class="listeners">${s.listeners}</div>
            <div class="listeners-label">listeners</div>
          </div>
        </div>
        <div class="np-controls">
          ${running
            ? `<button class="btn btn-ghost btn-sm" onclick="skipTrack('${s.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
                Skip
              </button>
              <button class="btn btn-danger btn-sm" onclick="stopAutoDJ('${s.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                Stop
              </button>`
            : `<button class="btn btn-green btn-sm" onclick="startAutoDJ('${s.id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Start AutoDJ
              </button>`
          }
          <button class="btn btn-ghost btn-sm" onclick="toggleRecording('${s.id}')" id="rec-btn-${s.id}" title="Record">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>
            <span id="rec-label-${s.id}">Record</span>
          </button>
          <button class="btn btn-ghost btn-sm" onclick="recordVoiceTrack('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>
            Record VT
          </button>
          <button class="btn btn-ghost btn-sm" onclick="goLive('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
            🎤 Live
          </button>
          <button class="btn btn-ghost btn-sm" onclick="editStation('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Settings
          </button>
          <button class="btn btn-ghost btn-sm" onclick="manageMembers('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Members
          </button>
          <button class="btn btn-ghost btn-sm" onclick="copyListenUrl('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy URL
          </button>
          <button class="btn btn-ghost btn-sm" onclick="goToStationMedia('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            Media
          </button>
          <a class="btn btn-ghost btn-sm" href="/player/${s.id}" target="_blank">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
            Player
          </a>
          <a class="btn btn-ghost btn-sm" href="/overlay/${s.id}" target="_blank" title="OBS Full Overlay">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            OBS
          </a>
          <a class="btn btn-ghost btn-sm" href="/stations" target="_blank" title="Public stations page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Public
          </a>
        </div>
      </div>
    `;
  }).join('');
}

// ════════════════════════════════════
// STATIONS
// ════════════════════════════════════
async function loadStations() {
  const data = await api('/stations');
  if (data) stations = data;
  const el = document.getElementById('stations-list');
  if (!stations || stations.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg></div>
      <h3>No stations</h3><p>Create your first station to get started</p>
    </div>`;
    return;
  }
  el.innerHTML = stations.map(s => `
    <div class="station-card" style="cursor:pointer">
      <div class="station-dot ${s.autodj_running ? 'live' : 'offline'}"></div>
      <div class="station-info" onclick="goToStationMedia('${s.id}')">
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.description || s.genre)} — ${s.bitrate}kbps</p>
        <p style="font-size:11px;color:#7C4DFF;margin-top:2px">Click to manage media</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="station-meta">
          <div class="listeners">${s.listeners}</div>
          <div class="listeners-label">listeners</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();editStation('${s.id}')" title="Settings" style="padding:6px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

async function createStation() {
  const name = document.getElementById('input-station-name').value.trim();
  if (!name) return;
  await api('/stations', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: document.getElementById('input-station-desc').value,
      genre: document.getElementById('input-station-genre').value,
      bitrate: parseInt(document.getElementById('input-station-bitrate').value),
    }),
  });
  closeModal('modal-new-station');
  document.getElementById('input-station-name').value = '';
  document.getElementById('input-station-desc').value = '';
  refreshDashboard();
}

function editStation(id) {
  const s = stations.find(st => st.id === id);
  if (!s) return;
  document.getElementById('edit-station-id').value = s.id;
  document.getElementById('edit-station-name').value = s.name;
  document.getElementById('edit-station-desc').value = s.description || '';
  document.getElementById('edit-station-genre').value = s.genre || 'Various';
  document.getElementById('edit-station-bitrate').value = String(s.bitrate || 128);
  document.getElementById('edit-station-logo').value = s.logo_url || '';
  document.getElementById('edit-station-website').value = s.website_url || '';
  document.getElementById('edit-station-location').value = s.location || '';
  showModal('modal-edit-station');
}

async function saveStation() {
  const id = document.getElementById('edit-station-id').value;
  await api(`/stations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: document.getElementById('edit-station-name').value,
      description: document.getElementById('edit-station-desc').value,
      genre: document.getElementById('edit-station-genre').value,
      bitrate: parseInt(document.getElementById('edit-station-bitrate').value),
      logo_url: document.getElementById('edit-station-logo').value || null,
      website_url: document.getElementById('edit-station-website').value || null,
      location: document.getElementById('edit-station-location').value || null,
    }),
  });
  closeModal('modal-edit-station');
  refreshDashboard();
  loadStations();
}

async function deleteStation(id) {
  if (!confirm('Delete this station and all its media? This cannot be undone.')) return;
  await api(`/stations/${id}`, { method: 'DELETE' });
  refreshDashboard();
  loadStations();
}

async function manageMembers(stationId) {
  document.getElementById('members-station-id').value = stationId;
  const s = stations.find(st => st.id === stationId);
  if (s) document.getElementById('members-station-name').textContent = esc(s.name);

  const members = await api(`/stations/${stationId}/members`);
  const el = document.getElementById('members-list');
  if (!members || members.length === 0) {
    el.innerHTML = '<p style="text-align:center;color:#999">No members yet</p>';
  } else {
    el.innerHTML = members.map(m => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid #eee;border-radius:8px;margin-bottom:8px">
        <div>
          <strong>${esc(m.display_name || m.email)}</strong>
          <div style="font-size:12px;color:#666">${esc(m.email)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select onchange="changeMemberRole('${stationId}', '${m.user_id}', this.value)" style="padding:6px;border:1px solid #ddd;border-radius:4px">
            <option value="dj" ${m.role === 'dj' ? 'selected' : ''}>DJ</option>
            <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>Owner</option>
          </select>
          <button class="btn btn-danger btn-sm" onclick="removeMember('${stationId}', '${m.user_id}')">Remove</button>
        </div>
      </div>
    `).join('');
  }
  showModal('modal-manage-members');
}

async function changeMemberRole(stationId, userId, newRole) {
  await api(`/stations/${stationId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role: newRole }),
  });
  manageMembers(stationId);
}

async function removeMember(stationId, userId) {
  if (!confirm('Remove this member?')) return;
  await api(`/stations/${stationId}/members/${userId}`, { method: 'DELETE' });
  manageMembers(stationId);
}

async function addNewMember(stationId) {
  const email = document.getElementById('add-member-email').value?.trim();
  if (!email) return alert('Email required');

  // First, create user if they don't exist
  const users = await api('/admin/users');
  let user = users?.find(u => u.email === email);
  if (!user) {
    user = await api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, display_name: email.split('@')[0] }),
    });
  }

  if (!user) return alert('Failed to create/find user');

  const role = document.getElementById('add-member-role').value || 'dj';
  await api(`/stations/${stationId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: user.id, role }),
  });
  document.getElementById('add-member-email').value = '';
  manageMembers(stationId);
}

// ════════════════════════════════════
// AUTODJ CONTROLS
// ════════════════════════════════════
async function startAutoDJ(id) {
  await api(`/stations/${id}/autodj/start`, { method: 'POST' });
  refreshDashboard();
}
async function stopAutoDJ(id) {
  await api(`/stations/${id}/autodj/stop`, { method: 'POST' });
  refreshDashboard();
}
async function skipTrack(id) {
  await api(`/stations/${id}/autodj/skip`, { method: 'POST' });
}

// Navigate to Media view with a specific station selected
function goToStationMedia(stationId) {
  currentStationId = stationId;
  // Switch nav active state
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const mediaNav = document.querySelector('.nav-item[data-view="media"]');
  if (mediaNav) mediaNav.classList.add('active');
  // Switch view
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-media').classList.add('active');
  document.getElementById('view-title').textContent = 'Media';
  // Update station select and refresh
  const sel = document.getElementById('media-station-select');
  if (sel) sel.value = stationId;
  refreshMedia();
  closeMobileSidebar();
}

function copyListenUrl(id) {
  const url = `${location.origin}/listen/${id}/radio.mp3`;
  navigator.clipboard.writeText(url);
  const btn = event.target.closest('.btn');
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(() => btn.innerHTML = orig, 1500);
  }
}

// ════════════════════════════════════
// MEDIA
// ════════════════════════════════════
function populateStationSelect() {
  if (!stations || stations.length === 0) return;
  const sel = document.getElementById('media-station-select');
  sel.innerHTML = stations.map(s =>
    `<option value="${s.id}" ${s.id === currentStationId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  if (!currentStationId) currentStationId = stations[0].id;
  sel.onchange = () => { currentStationId = sel.value; refreshMedia(); };
}

async function refreshMedia() {
  if (!currentStationId && stations?.length > 0) currentStationId = stations[0].id;
  if (!currentStationId) return;

  // Show current station name
  const stName = stations.find(s => s.id === currentStationId);
  const nameEl = document.getElementById('media-station-name');
  if (nameEl) nameEl.textContent = stName ? `— ${stName.name}` : '';

  allMedia = await api(`/stations/${currentStationId}/media`) || [];
  renderMediaTable(allMedia);
}

function filterMedia(q) {
  if (!q) return renderMediaTable(allMedia);
  const lower = q.toLowerCase();
  const filtered = allMedia.filter(m =>
    (m.title || '').toLowerCase().includes(lower) ||
    (m.artist || '').toLowerCase().includes(lower) ||
    (m.album || '').toLowerCase().includes(lower) ||
    (m.original_name || '').toLowerCase().includes(lower)
  );
  renderMediaTable(filtered);
}

function renderMediaTable(media) {
  document.getElementById('media-count').textContent = `${media.length} files`;
  if (media.length === 0) {
    document.getElementById('media-table-wrap').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
        <h3>No media yet</h3><p>Upload some audio files to get started</p>
      </div>`;
    return;
  }
  document.getElementById('media-table-wrap').innerHTML = `
    <table class="media-table">
      <thead><tr>
        <th style="width:40px"></th>
        <th>Title</th>
        <th>Artist</th>
        <th>Album</th>
        <th>Duration</th>
        <th>Size</th>
        <th style="width:140px">Actions</th>
      </tr></thead>
      <tbody>
        ${media.map(m => `
          <tr>
            <td style="padding:8px">
              ${m.artwork_url
                ? `<img src="${esc(m.artwork_url)}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;display:block">`
                : `<div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#7C4DFF,#FF48BC);display:flex;align-items:center;justify-content:center">
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" style="width:16px;height:16px"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  </div>`
              }
            </td>
            <td class="title-cell">${esc(m.title || m.original_name)}</td>
            <td class="dim">${esc(m.artist)}</td>
            <td class="dim">${esc(m.album)}</td>
            <td class="dim">${formatDuration(m.duration)}</td>
            <td class="dim">${formatBytes(m.size)}</td>
            <td>
              <div style="display:flex;gap:4px;align-items:center">
                <button class="btn btn-ghost btn-sm" onclick="playNow('${m.id}')" title="Play Now">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button class="btn btn-ghost btn-sm" onclick="addToQueue('${m.id}')" title="Add to Queue">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteMedia('${m.id}')" title="Delete">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function playNow(mediaId) {
  if (!currentStationId) return;
  const res = await api(`/stations/${currentStationId}/play/${mediaId}`, { method: 'POST' });
  if (res?.ok) {
    showToast('Playing now');
    refreshDashboard();
  } else {
    showToast(res?.error || 'Failed — is AutoDJ running?', 'error');
  }
}

async function addToQueue(mediaId) {
  if (!currentStationId) return;
  const res = await api(`/stations/${currentStationId}/queue/${mediaId}`, { method: 'POST' });
  if (res?.ok) {
    showToast('Added to queue');
  } else {
    showToast(res?.error || 'Failed — is AutoDJ running?', 'error');
  }
}

function showToast(msg, type = 'success') {
  let toast = document.getElementById('toast-msg');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast-msg';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 22px;border-radius:12px;font-size:13px;font-weight:600;z-index:9999;transition:opacity 0.3s;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'error' ? '#fce4ec' : '#e8f5e9';
  toast.style.color = type === 'error' ? '#c62828' : '#2e7d32';
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

async function deleteMedia(id) {
  await api(`/media/${id}`, { method: 'DELETE' });
  refreshMedia();
  refreshDashboard();
}

// ════════════════════════════════════
// UPLOAD
// ════════════════════════════════════
const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
let uploading = false;

if (uploadArea && fileInput) {
  uploadArea.addEventListener('click', () => { if (!uploading) fileInput.click(); });
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); if (!uploading) uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('dragover'); if (!uploading) handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => { if (fileInput.files.length > 0 && !uploading) handleFiles(fileInput.files); });
}

function showUploadStatus(msg, type) {
  if (!uploadStatus) return;
  uploadStatus.style.display = 'block';
  const colors = { info: '#7C4DFF', success: '#00C853', error: '#FF2A2A' };
  const bgs = { info: '#f0eaff', success: '#e8f5e9', error: '#fce4ec' };
  uploadStatus.innerHTML = `<div style="padding:14px 18px;border-radius:14px;background:${bgs[type]||bgs.info};color:${colors[type]||colors.info};font-size:14px;font-weight:600;margin-bottom:16px">${msg}</div>`;
}
function hideUploadStatus() { if (uploadStatus) uploadStatus.style.display = 'none'; }

async function handleFiles(files) {
  if (!currentStationId) return alert('Select a station first');
  if (uploading) return;
  const fileArr = Array.from(files);
  const totalFiles = fileArr.length;
  if (totalFiles === 0) return;

  uploading = true;
  uploadArea.style.opacity = '0.5';
  uploadArea.style.pointerEvents = 'none';

  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < fileArr.length; i += BATCH_SIZE) batches.push(fileArr.slice(i, i + BATCH_SIZE));

  let uploaded = 0, failed = 0;
  showUploadStatus(`Uploading 0 / ${totalFiles} files...`, 'info');

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const form = new FormData();
    for (const f of batch) form.append('files', f);
    showUploadStatus(`Uploading ${uploaded} / ${totalFiles} files... (batch ${b+1}/${batches.length})`, 'info');

    try {
      const res = await fetch(`/api/stations/${currentStationId}/media`, { method: 'POST', body: form });
      if (res.ok) { uploaded += (await res.json()).length; }
      else { failed += batch.length; }
    } catch { failed += batch.length; }
  }

  uploading = false;
  uploadArea.style.opacity = '1';
  uploadArea.style.pointerEvents = 'auto';
  fileInput.value = '';

  if (failed === 0) showUploadStatus(`Successfully uploaded ${uploaded} file${uploaded !== 1 ? 's' : ''}!`, 'success');
  else if (uploaded > 0) showUploadStatus(`Uploaded ${uploaded}, ${failed} failed.`, 'error');
  else showUploadStatus(`Upload failed — ${failed} file${failed !== 1 ? 's' : ''} could not be uploaded.`, 'error');

  setTimeout(hideUploadStatus, 8000);
  refreshMedia();
  refreshDashboard();
}

// ════════════════════════════════════
// HISTORY
// ════════════════════════════════════
async function refreshHistory() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;

  // Load recordings
  const recordings = await api(`/stations/${sid}/recordings`) || [];
  document.getElementById('recordings-count').textContent = recordings.length;
  const recEl = document.getElementById('recordings-list');
  if (recordings.length === 0) {
    recEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg></div><h3>No recordings</h3><p>Hit Record on a station to capture a show</p></div>`;
  } else {
    recEl.innerHTML = recordings.map(r => `
      <div class="history-item" style="align-items:center">
        <div style="width:8px;height:8px;border-radius:50%;background:#ff1744;flex-shrink:0"></div>
        <div class="history-meta" style="flex:1">
          <h4>Recording ${r.id}</h4>
          <p>${formatBytes(r.size)} &middot; ~${formatDuration(r.duration_estimate)}</p>
        </div>
        <div class="history-time">${timeAgo(r.created_at)}</div>
        <div style="display:flex;gap:4px;margin-left:8px">
          <a class="btn btn-ghost btn-sm" href="/api/stations/${sid}/recordings/${r.id}/download" title="Download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
          <button class="btn btn-danger btn-sm" onclick="deleteRecording('${sid}','${r.id}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  }

  const history = await api(`/stations/${sid}/history?limit=50`) || [];
  const el = document.getElementById('history-list');
  if (history.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><h3>No history yet</h3><p>Tracks will appear here as they play</p></div>`;
    return;
  }
  el.innerHTML = history.map((h, i) => `
    <div class="history-item">
      <div class="history-num">${i + 1}</div>
      <div class="history-meta">
        <h4>${esc(h.title)}</h4>
        <p>${esc(h.artist)} &middot; ${h.listeners} listeners</p>
      </div>
      <div class="history-time">${timeAgo(h.played_at)}</div>
    </div>
  `).join('');
}

// ════════════════════════════════════
// REQUESTS
// ════════════════════════════════════
function populateRequestStationSelect() {
  const sel = document.getElementById('request-station-select');
  if (!sel || !stations) return;
  sel.innerHTML = stations.map(s =>
    `<option value="${s.id}" ${s.id === currentStationId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  sel.onchange = () => { currentStationId = sel.value; refreshRequests(); };
}

async function refreshRequests() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;
  populateRequestStationSelect();

  try {
    const pending = await api(`/stations/${sid}/requests?status=pending`) || [];
    const pendingEl = document.getElementById('requests-pending-list');
    document.getElementById('request-count').textContent = pending.length;

    if (pending.length === 0) {
      pendingEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><h3>No pending requests</h3><p>Song requests from listeners will appear here</p></div>`;
    } else {
      pendingEl.innerHTML = pending.map((r, i) => `
        <div class="history-item" style="align-items:center">
          <div class="history-num">${i + 1}</div>
          ${r.artwork_url ? `<img src="${esc(r.artwork_url)}" style="width:40px;height:40px;border-radius:8px;object-fit:cover">` : ''}
          <div class="history-meta" style="flex:1">
            <h4>${esc(r.title)}</h4>
            <p>${esc(r.artist)}${r.requested_by ? ' &middot; by ' + esc(r.requested_by) : ''}${r.media_id ? ' &middot; <span style="color:#00C853">Matched</span>' : ' &middot; <span style="color:#FF6B00">No match</span>'}</p>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-danger btn-sm" onclick="updateRequest('${r.id}','skipped')" title="Skip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      `).join('');
    }
  } catch (e) { console.error('Failed to load requests:', e); }

  try {
    const played = await api(`/stations/${sid}/requests?status=played`) || [];
    const skipped = await api(`/stations/${sid}/requests?status=skipped`) || [];
    const history = [...played, ...skipped].sort((a, b) => new Date(b.played_at || b.created_at) - new Date(a.played_at || a.created_at)).slice(0, 25);
    const histEl = document.getElementById('requests-history-list');

    if (history.length === 0) {
      histEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><h3>No past requests</h3><p>Played and skipped requests show up here</p></div>`;
    } else {
      histEl.innerHTML = history.map(r => `
        <div class="history-item">
          <span class="badge ${r.status === 'played' ? 'badge-green' : 'badge-red'}" style="min-width:56px;text-align:center">${r.status === 'played' ? 'Played' : 'Skipped'}</span>
          <div class="history-meta" style="flex:1">
            <h4>${esc(r.title)}</h4>
            <p>${esc(r.artist)}${r.requested_by ? ' &middot; by ' + esc(r.requested_by) : ''}</p>
          </div>
          <div class="history-time">${timeAgo(r.played_at || r.created_at)}</div>
        </div>
      `).join('');
    }
  } catch (e) { console.error('Failed to load request history:', e); }
}

async function updateRequest(id, status) {
  await api(`/requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  refreshRequests();
}

async function enrichAllMedia() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;
  const btn = event.target.closest('.btn');
  const orig = btn.innerHTML;
  btn.innerHTML = 'Enriching...';
  btn.disabled = true;
  try {
    const res = await api(`/stations/${sid}/enrich`, { method: 'POST' });
    btn.innerHTML = `Done! ${res?.enriched || 0} enriched`;
    refreshMedia();
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 3000);
  } catch {
    btn.innerHTML = 'Error';
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
  }
}

// ════════════════════════════════════
// MODALS
// ════════════════════════════════════
function showNewStationModal() { showModal('modal-new-station'); }
function showModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    closeMobileSidebar();
  }
});

// ════════════════════════════════════
// UTILITIES
// ════════════════════════════════════
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function formatDuration(sec) {
  if (!sec) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// ════════════════════════════════════
// DJs
// ════════════════════════════════════
function populateDJStationSelect() {
  const sel = document.getElementById('dj-station-select');
  if (!sel || !stations?.length) return;
  sel.innerHTML = stations.map(s =>
    `<option value="${s.id}" ${s.id === currentStationId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  sel.onchange = () => { currentStationId = sel.value; refreshDJs(); };
}

async function refreshDJs() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;
  populateDJStationSelect();

  // Set connection info
  const hostEl = document.getElementById('dj-host');
  const portEl = document.getElementById('dj-port');
  const mountEl = document.getElementById('dj-mount');
  const hostname = location.hostname;
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  if (hostEl) hostEl.textContent = hostname;
  if (portEl) portEl.textContent = port;
  if (mountEl) mountEl.textContent = `/live/${sid}`;

  // Integration URLs
  const origin = location.origin;
  const streamUrl = document.getElementById('int-stream-url');
  const overlayUrl = document.getElementById('int-overlay-url');
  const barUrl = document.getElementById('int-bar-url');
  const playerUrl = document.getElementById('int-player-url');
  const discordCmd = document.getElementById('int-discord-cmd');
  if (streamUrl) streamUrl.textContent = `${origin}/listen/${sid}/radio.mp3`;
  if (overlayUrl) overlayUrl.textContent = `${origin}/overlay/${sid}`;
  if (barUrl) barUrl.textContent = `${origin}/overlay/${sid}?mode=bar`;
  if (playerUrl) playerUrl.textContent = `${origin}/player/${sid}`;
  if (discordCmd) discordCmd.textContent = `/play ${origin}/listen/${sid}/radio.mp3`;

  // Check live status
  const liveData = await api(`/stations/${sid}/live`);
  const liveBadge = document.getElementById('live-status-badge');
  if (liveBadge) {
    if (liveData?.live) {
      liveBadge.style.display = 'inline-flex';
      liveBadge.style.background = '#ff1744';
      liveBadge.style.color = '#fff';
      liveBadge.textContent = `🎙 LIVE — ${liveData.dj}`;
    } else {
      liveBadge.style.display = 'none';
    }
  }

  // Load accounts
  const accounts = await api(`/stations/${sid}/dj-accounts`) || [];
  document.getElementById('dj-count').textContent = accounts.length;
  const el = document.getElementById('dj-accounts-list');

  if (!accounts.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg></div>
      <h3>No DJ accounts</h3><p>Create a DJ account to enable live broadcasting</p>
    </div>`;
    return;
  }

  el.innerHTML = `<table class="media-table">
    <thead><tr>
      <th>DJ</th><th>Username</th><th>Stream Key</th><th>Status</th><th>Last Live</th><th style="width:120px">Actions</th>
    </tr></thead>
    <tbody>${accounts.map(a => `
      <tr>
        <td class="title-cell">${esc(a.display_name || a.username)}</td>
        <td class="dim" style="font-family:monospace;font-size:12px">${esc(a.username)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <code style="font-size:11px;background:#f5f5f5;padding:3px 8px;border-radius:6px;user-select:all">${esc(a.stream_key)}</code>
            <button class="btn btn-ghost btn-sm" onclick="regenDJKey('${a.id}')" title="Regenerate key" style="padding:4px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
          </div>
        </td>
        <td><span class="badge ${a.is_active ? 'badge-green' : 'badge-red'}">${a.is_active ? 'Active' : 'Disabled'}</span></td>
        <td class="dim">${a.last_connected ? timeAgo(a.last_connected) : 'Never'}</td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm" onclick="toggleDJ('${a.id}', ${a.is_active ? 0 : 1})" title="${a.is_active ? 'Disable' : 'Enable'}">
              ${a.is_active ? '⏸' : '▶'}
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteDJ('${a.id}')" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('')}</tbody>
  </table>`;
}

async function createDJAccount() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;
  const username = document.getElementById('input-dj-username').value.trim();
  if (!username) return;
  const displayName = document.getElementById('input-dj-displayname').value.trim();

  const res = await api(`/stations/${sid}/dj-accounts`, {
    method: 'POST',
    body: JSON.stringify({ username, display_name: displayName }),
  });

  if (res?.id) {
    closeModal('modal-new-dj');
    document.getElementById('input-dj-username').value = '';
    document.getElementById('input-dj-displayname').value = '';
    showToast('DJ account created');
    refreshDJs();
  } else {
    showToast(res?.error || 'Failed to create account', 'error');
  }
}

async function regenDJKey(id) {
  if (!confirm('Regenerate stream key? The DJ will need the new key to connect.')) return;
  await api(`/dj-accounts/${id}/regenerate-key`, { method: 'POST' });
  showToast('Stream key regenerated');
  refreshDJs();
}

async function toggleDJ(id, active) {
  await api(`/dj-accounts/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: !!active }) });
  refreshDJs();
}

async function deleteDJ(id) {
  if (!confirm('Delete this DJ account?')) return;
  await api(`/dj-accounts/${id}`, { method: 'DELETE' });
  showToast('DJ account deleted');
  refreshDJs();
}

async function kickLiveDJ() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;
  await api(`/stations/${sid}/live/kick`, { method: 'POST' });
  showToast('DJ kicked');
  refreshDJs();
  refreshDashboard();
}

// ════════════════════════════════════
// RECORDINGS
// ════════════════════════════════════
async function toggleRecording(stationId) {
  const status = await api(`/stations/${stationId}/recording`);
  if (status?.recording) {
    const res = await api(`/stations/${stationId}/recording/stop`, { method: 'POST' });
    if (res?.id) {
      showToast(`Recording saved (${formatDuration(res.duration)}, ${formatBytes(res.size)})`);
      updateRecBtn(stationId, false);
    }
  } else {
    const title = prompt('Recording title:', 'Show Recording');
    if (!title) return;
    const res = await api(`/stations/${stationId}/recording/start`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    if (res?.id) {
      showToast('Recording started');
      updateRecBtn(stationId, true);
    } else {
      showToast(res?.error || 'Failed to start recording', 'error');
    }
  }
}

function updateRecBtn(stationId, isRecording) {
  const btn = document.getElementById(`rec-btn-${stationId}`);
  const label = document.getElementById(`rec-label-${stationId}`);
  if (!btn) return;
  if (isRecording) {
    btn.style.color = '#ff1744';
    btn.style.borderColor = 'rgba(255,23,68,0.3)';
    if (label) label.textContent = 'Stop Rec';
  } else {
    btn.style.color = '';
    btn.style.borderColor = '';
    if (label) label.textContent = 'Record';
  }
}

async function deleteRecording(stationId, recId) {
  if (!confirm('Delete this recording? This cannot be undone.')) return;
  await api(`/stations/${stationId}/recordings/${recId}`, { method: 'DELETE' });
  showToast('Recording deleted');
  refreshHistory();
}

// Check recording state on dashboard refresh
async function checkRecordingStates() {
  for (const s of stations) {
    try {
      const status = await api(`/stations/${s.id}/recording`);
      updateRecBtn(s.id, !!status?.recording);
    } catch {}
  }
}

// ════════════════════════════════════
// SEARCH & ADD SONGS
// ════════════════════════════════════
async function searchAndAdd() {
  const q = document.getElementById('tm-search-input').value.trim();
  if (!q || q.length < 2) return;

  const resultsEl = document.getElementById('tm-search-results');
  resultsEl.innerHTML = '<p style="color:#999;font-size:13px">Searching...</p>';

  const tracks = await api(`/search?q=${encodeURIComponent(q)}`) || [];

  if (!Array.isArray(tracks) || tracks.length === 0) {
    resultsEl.innerHTML = '<p style="color:#999;font-size:13px">No results found</p>';
    return;
  }

  resultsEl.innerHTML = tracks.slice(0, 8).map(t => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
      ${t.album_art ? `<img src="${esc(t.album_art)}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0">` : '<div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#7C4DFF,#FF48BC);flex-shrink:0"></div>'}
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
        <div style="font-size:12px;color:#777">${esc(t.artist)} ${t.album_name ? '&middot; ' + esc(t.album_name) : ''}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="addSongFromSearch(this, ${JSON.stringify({
        title: t.title,
        artist: typeof t.artist === 'string' ? t.artist : String(t.artist),
        album: t.album_name || '',
        artwork_url: t.album_art || '',
        deezer_id: t.deezer_id || '',
        spotify_id: t.spotify_id || '',
        duration: t.duration_sec || 0,
      }).replace(/'/g, '&#39;').replace(/"/g, '&quot;')})" style="white-space:nowrap">
        + Add
      </button>
    </div>
  `).join('');
}

async function addSongFromSearch(btn, track) {
  if (!currentStationId) return showToast('Select a station first', 'error');

  const orig = btn.innerHTML;
  btn.innerHTML = '...';
  btn.disabled = true;

  const res = await api(`/stations/${currentStationId}/add-song`, {
    method: 'POST',
    body: JSON.stringify(track),
  });

  if (res?.ok) {
    btn.innerHTML = res.skipped ? 'Exists' : 'Added!';
    btn.style.background = '#e8f5e9';
    btn.style.color = '#2e7d32';
    if (!res.skipped) {
      showToast(`Added: ${track.artist} — ${track.title}`);
      refreshMedia();
    }
  } else {
    btn.innerHTML = 'Failed';
    btn.style.background = '#fce4ec';
    btn.style.color = '#c62828';
    showToast(res?.error || 'Download failed', 'error');
  }

  setTimeout(() => {
    btn.innerHTML = orig;
    btn.disabled = false;
    btn.style.background = '';
    btn.style.color = '';
  }, 3000);
}

// ════════════════════════════════════
// AZURACAST IMPORT
// ════════════════════════════════════
async function startAzuraCastImport() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return showToast('Select a station first', 'error');

  const azuraUrl = document.getElementById('input-azura-url').value.trim();
  const apiKey = document.getElementById('input-azura-apikey').value.trim();
  const azuraStation = document.getElementById('input-azura-station').value.trim();

  if (!azuraUrl || !apiKey || !azuraStation) {
    return showToast('Fill in all fields', 'error');
  }

  const statusEl = document.getElementById('azura-import-status');
  const btn = document.getElementById('btn-azura-import');
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<div style="padding:12px;border-radius:12px;background:#f0eaff;color:#7C4DFF;font-size:13px;font-weight:600">Importing... this may take a while for large libraries.</div>';
  btn.disabled = true;
  btn.textContent = 'Importing...';

  try {
    const res = await fetch(`/api/stations/${sid}/import/azuracast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        azuracast_url: azuraUrl,
        api_key: apiKey,
        azura_station_id: azuraStation,
      }),
    });
    const data = await res.json();

    if (res.ok) {
      statusEl.innerHTML = `<div style="padding:12px;border-radius:12px;background:#e8f5e9;color:#2e7d32;font-size:13px;font-weight:600">
        Done! ${data.media_imported} imported, ${data.media_skipped} skipped, ${data.media_failed} failed, ${data.playlists_imported} playlists.
      </div>`;
      refreshMedia();
      refreshDashboard();
    } else {
      statusEl.innerHTML = `<div style="padding:12px;border-radius:12px;background:#fce4ec;color:#c62828;font-size:13px;font-weight:600">${data.error || 'Import failed'}</div>`;
    }
  } catch (e) {
    statusEl.innerHTML = `<div style="padding:12px;border-radius:12px;background:#fce4ec;color:#c62828;font-size:13px;font-weight:600">Connection error: ${e.message}</div>`;
  }

  btn.disabled = false;
  btn.textContent = 'Start Import';
}

// ════════════════════════════════════
// USERS
// ════════════════════════════════════
async function refreshUsers() {
  const users = await api('/users') || [];
  document.getElementById('user-count').textContent = users.length;
  const el = document.getElementById('users-list');

  // Populate station checkboxes in invite modal
  const stationsDiv = document.getElementById('input-user-stations');
  if (stationsDiv && stations?.length) {
    stationsDiv.innerHTML = stations.map(s =>
      `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" value="${s.id}" class="user-station-cb"> ${esc(s.name)}
      </label>`
    ).join('');
  }

  if (!users.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>
      <h3>No users</h3><p>Invite a user and assign them a station to manage</p>
    </div>`;
    return;
  }

  el.innerHTML = `<table class="media-table">
    <thead><tr>
      <th>Name</th><th>Email</th><th>Role</th><th>Stations</th><th>Last Login</th><th style="width:100px">Actions</th>
    </tr></thead>
    <tbody>${users.map(u => `
      <tr>
        <td class="title-cell">${esc(u.display_name || u.email)}</td>
        <td class="dim" style="font-size:12px">${esc(u.email)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-purple' : 'badge-green'}">${u.role}</span></td>
        <td class="dim" style="font-size:12px">${esc(u.assigned_stations || 'None')}</td>
        <td class="dim">${u.last_login ? timeAgo(u.last_login) : 'Never'}</td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm" onclick="resetUserPassword('${u.id}', '${esc(u.email)}')" title="Reset password">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')" title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `).join('')}</tbody>
  </table>`;
}

async function createUser() {
  const email = document.getElementById('input-user-email').value.trim();
  const password = document.getElementById('input-user-password').value;
  const displayName = document.getElementById('input-user-name').value.trim();
  if (!email || !password) return showToast('Email and password required', 'error');

  const stationIds = Array.from(document.querySelectorAll('.user-station-cb:checked')).map(cb => cb.value);

  const res = await api('/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: displayName, station_ids: stationIds }),
  });

  if (res?.id) {
    closeModal('modal-new-user');
    document.getElementById('input-user-email').value = '';
    document.getElementById('input-user-password').value = '';
    document.getElementById('input-user-name').value = '';
    showToast(`User created: ${email}`);
    refreshUsers();
  } else {
    showToast(res?.error || 'Failed to create user', 'error');
  }
}

async function resetUserPassword(id, email) {
  const newPass = prompt(`New password for ${email}:`);
  if (!newPass) return;
  const res = await api(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: newPass }) });
  if (res?.id) showToast('Password reset');
  else showToast(res?.error || 'Failed', 'error');
}

async function deleteUser(id) {
  if (!confirm('Delete this user? They will lose access to all stations.')) return;
  await api(`/users/${id}`, { method: 'DELETE' });
  showToast('User deleted');
  refreshUsers();
}

// ════════════════════════════════════
// LIVE MIC (Go Live)
// ════════════════════════════════════
let liveMicStream = null;
let liveMicRecorder = null;
let liveMicWS = null;
let liveMicAnalyser = null;
let isBroadcasting = false;
let liveMicProcessor = null;
let liveMicEncoder = null;
let liveMicSource = null;

function goLive(stationId) {
  const s = stations.find(st => st.id === stationId);
  if (!s) return;
  document.getElementById('live-mic-station-id').value = stationId;
  document.getElementById('live-mic-station-name').textContent = esc(s.name);
  showModal('modal-live-mic');

  // Request microphone access
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then(stream => {
      liveMicStream = stream;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      liveMicAnalyser = audioCtx.createAnalyser();
      liveMicAnalyser.fftSize = 256;
      source.connect(liveMicAnalyser);

      document.getElementById('mic-status').textContent = '✅ Microphone ready';
      document.getElementById('mic-start-btn').style.display = 'block';

      // Show mic meter
      const dataArray = new Uint8Array(liveMicAnalyser.frequencyBinCount);
      const updateMeter = () => {
        liveMicAnalyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b) / dataArray.length / 255;
        document.getElementById('mic-meter').style.width = (avg * 100) + '%';
        if (isBroadcasting) requestAnimationFrame(updateMeter);
      };
      updateMeter();
    })
    .catch(err => {
      document.getElementById('mic-status').textContent = '❌ ' + err.message;
      document.getElementById('mic-start-btn').disabled = true;
    });
}

async function toggleMic() {
  if (isBroadcasting) {
    stopBroadcast();
  } else {
    startBroadcast();
  }
}

async function startBroadcast() {
  if (!liveMicStream) {
    alert('Microphone not ready');
    return;
  }

  const stationId = document.getElementById('live-mic-station-id').value;
  const user = JSON.parse(sessionStorage.getItem('ciryacast_user') || '{}');

  // Connect WebSocket for audio streaming
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?type=livemic&station=${stationId}&user=${user.id}&name=${encodeURIComponent(user.display_name || user.email)}`;
  liveMicWS = new WebSocket(wsUrl);
  liveMicWS.binaryType = 'arraybuffer';

  liveMicWS.onopen = async () => {
    document.getElementById('mic-status').textContent = '🔴 BROADCASTING';
    document.getElementById('mic-start-btn').style.display = 'none';
    document.getElementById('mic-btn').style.display = 'block';
    isBroadcasting = true;

    try {
      // Use MediaRecorder with best available codec (opus/webm or aac/mp4)
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

      liveMicRecorder = new MediaRecorder(liveMicStream, { mimeType, audioBitsPerSecond: 128000 });

      liveMicRecorder.ondataavailable = (e) => {
        if (liveMicWS && liveMicWS.readyState === WebSocket.OPEN && e.data.size > 0) {
          liveMicWS.send(e.data);
        }
      };

      liveMicRecorder.onerror = (e) => {
        console.error('Recorder error:', e);
        stopBroadcast();
      };

      // Send audio chunks every 250ms for low latency
      liveMicRecorder.start(250);

      showToast('🎤 Broadcasting live!');
    } catch (e) {
      console.error('Recorder setup error:', e);
      document.getElementById('mic-status').textContent = '❌ Recorder failed: ' + e.message;
      stopBroadcast();
    }
  };

  liveMicWS.onerror = (e) => {
    console.error('WebSocket error:', e);
    document.getElementById('mic-status').textContent = '❌ Connection failed';
    isBroadcasting = false;
  };
}

function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp float to [-1, 1]
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    // Convert to int16 range [-32768, 32767]
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16Array;
}

function stopBroadcast() {
  isBroadcasting = false;

  // Stop MediaRecorder
  if (liveMicRecorder && liveMicRecorder.state !== 'inactive') {
    liveMicRecorder.stop();
    liveMicRecorder = null;
  }

  // Close WebSocket
  if (liveMicWS) {
    liveMicWS.close();
    liveMicWS = null;
  }

  document.getElementById('mic-status').textContent = '✅ Microphone ready';
  document.getElementById('mic-btn').style.display = 'none';
  document.getElementById('mic-start-btn').style.display = 'block';
  showToast('📻 Live broadcast stopped');
}

function closeLiveMic() {
  if (isBroadcasting) stopBroadcast();

  // Stop all microphone tracks
  if (liveMicStream) {
    liveMicStream.getTracks().forEach(t => t.stop());
    liveMicStream = null;
  }

  // Clear encoder
  liveMicEncoder = null;
  liveMicAnalyser = null;

  closeModal('modal-live-mic');
}

// ════════════════════════════════════
// VOICE TRACK RECORDING
// ════════════════════════════════════
let vtStream = null;
let vtProcessor = null;
let vtEncoder = null;
let vtAnalyser = null;
let vtAnalyserNode = null;
let vtIsRecording = false;
let vtMp3Chunks = [];

function recordVoiceTrack(stationId) {
  if (!stationId) {
    alert('No station selected. Please select a station first.');
    return;
  }

  console.log('VT: Opening record modal for station', stationId);

  document.getElementById('vt-station-id').value = stationId;
  document.getElementById('vt-presenter').value = '';
  document.getElementById('vt-title').value = '';
  document.getElementById('vt-start-btn').style.display = 'block';
  document.getElementById('vt-stop-btn').style.display = 'none';
  document.getElementById('vt-save-btn').style.display = 'none';
  document.getElementById('vt-status').textContent = 'Requesting microphone access...';
  vtIsRecording = false;
  vtMp3Chunks = [];

  showModal('modal-record-vt');

  // Request microphone with better error handling
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then(stream => {
      console.log('VT: Microphone access granted');
      vtStream = stream;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      vtAnalyserNode = audioCtx.createAnalyser();
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(vtAnalyserNode);

      document.getElementById('vt-status').textContent = '✅ Ready to record';
      document.getElementById('vt-start-btn').style.display = 'block';
      document.getElementById('vt-start-btn').disabled = false;

      // Show meter
      const dataArray = new Uint8Array(vtAnalyserNode.frequencyBinCount);
      const updateMeter = () => {
        vtAnalyserNode.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b) / dataArray.length / 255;
        document.getElementById('vt-meter').style.width = (avg * 100) + '%';
        if (vtIsRecording) requestAnimationFrame(updateMeter);
      };
      updateMeter();
    })
    .catch(err => {
      console.error('VT: Microphone error:', err);
      document.getElementById('vt-status').textContent = '❌ ' + (err.name || 'Error') + ': ' + err.message;
      document.getElementById('vt-start-btn').disabled = true;
      showToast('❌ Microphone access denied: ' + err.message);
    });
}

function toggleVTRecord() {
  console.log('VT: toggleVTRecord called, currently recording:', vtIsRecording);
  if (vtIsRecording) {
    stopVTRecording();
  } else {
    startVTRecording();
  }
}

function startVTRecording() {
  console.log('VT: startVTRecording called');
  if (!vtStream) {
    console.error('VT: No microphone stream available');
    alert('Microphone not ready - please click button again and allow access');
    return;
  }

  if (!window.lamejs) {
    console.error('VT: lamejs library not loaded');
    alert('MP3 encoder library failed to load. Please refresh page.');
    return;
  }

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const sampleRate = audioCtx.sampleRate;

  // Initialize encoder
  vtEncoder = new lamejs.Mp3Encoder(1, sampleRate, 128);
  vtMp3Chunks = [];

  const source = audioCtx.createMediaStreamSource(vtStream);
  vtProcessor = audioCtx.createScriptProcessor(4096, 1, 1);

  vtProcessor.onaudioprocess = (e) => {
    if (!vtIsRecording) return;

    const inputData = e.inputBuffer.getChannelData(0);
    const int16Data = float32ToInt16(inputData);

    if (vtEncoder) {
      const mp3Chunk = vtEncoder.encodeBuffer(int16Data);
      if (mp3Chunk.length > 0) {
        vtMp3Chunks.push(new Uint8Array(mp3Chunk));
      }
    }
  };

  source.connect(vtProcessor);
  vtProcessor.connect(audioCtx.destination);

  vtIsRecording = true;
  document.getElementById('vt-status').textContent = '🔴 RECORDING...';
  document.getElementById('vt-start-btn').style.display = 'none';
  document.getElementById('vt-stop-btn').style.display = 'block';
  document.getElementById('vt-save-btn').style.display = 'none';
  showToast('🎙️ Recording voice track...');
}

function stopVTRecording() {
  vtIsRecording = false;

  // Flush encoder
  if (vtEncoder) {
    const finalMp3 = vtEncoder.flush();
    if (finalMp3.length > 0) {
      vtMp3Chunks.push(new Uint8Array(finalMp3));
    }
  }

  // Clean up audio nodes
  if (vtProcessor) {
    vtProcessor.disconnect();
    vtProcessor = null;
  }
  vtEncoder = null;

  document.getElementById('vt-status').textContent = '✅ Recording saved';
  document.getElementById('vt-start-btn').style.display = 'none';
  document.getElementById('vt-stop-btn').style.display = 'none';
  document.getElementById('vt-save-btn').style.display = 'block';
  showToast('✅ Voice track recorded');
}

async function saveVoiceTrack() {
  const stationId = document.getElementById('vt-station-id').value;
  const presenter = document.getElementById('vt-presenter').value?.trim() || 'Presenter';
  const title = document.getElementById('vt-title').value?.trim();

  if (!title) {
    alert('Please enter a track title');
    return;
  }

  // Combine chunks into single buffer
  const totalLength = vtMp3Chunks.reduce((a, b) => a + b.length, 0);
  const mp3Data = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of vtMp3Chunks) {
    mp3Data.set(chunk, offset);
    offset += chunk.length;
  }

  // Upload
  document.getElementById('vt-save-btn').disabled = true;
  document.getElementById('vt-status').textContent = 'Uploading...';

  try {
    const response = await fetch(`/api/stations/${stationId}/voicetracks/record?title=${encodeURIComponent(title)}&presenter=${encodeURIComponent(presenter)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: mp3Data.buffer,
    });

    const result = await response.json();
    if (response.ok) {
      showToast('🎙️ Voice track saved!');
      closeVTModal();
    } else {
      alert('Error: ' + result.error);
      document.getElementById('vt-status').textContent = '❌ Upload failed';
    }
  } catch (e) {
    alert('Upload error: ' + e.message);
    document.getElementById('vt-status').textContent = '❌ Upload error';
  } finally {
    document.getElementById('vt-save-btn').disabled = false;
  }
}

function closeVTModal() {
  vtIsRecording = false;
  if (vtStream) {
    vtStream.getTracks().forEach(t => t.stop());
    vtStream = null;
  }
  if (vtProcessor) {
    vtProcessor.disconnect();
    vtProcessor = null;
  }
  vtEncoder = null;
  vtMp3Chunks = [];
  closeModal('modal-record-vt');
}

// ════════════════════════════════════
// SCHEDULED SHOWS
// ════════════════════════════════════
async function loadScheduledShows() {
  const currentStation = getSelectedStation();
  if (!currentStation) return;

  const shows = await api(`/stations/${currentStation.id}/shows`);
  const list = document.getElementById('shows-list');

  if (!shows || shows.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div><h3>No scheduled shows</h3><p>Create a show to automate playback at specific times</p></div>';
    return;
  }

  list.innerHTML = shows.map(s => `
    <div style="padding:16px;border:1px solid #eee;border-radius:8px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <strong>${esc(s.title)}</strong>
          <div style="font-size:12px;color:#666;margin-top:2px">${s.schedule_type.toUpperCase()} at ${s.start_time}</div>
          ${s.playlist_name ? `<div style="font-size:11px;color:#999">Playlist: ${esc(s.playlist_name)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-danger btn-sm" onclick="deleteScheduledShow('${s.id}')">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

function showScheduleModal() {
  const currentStation = getSelectedStation();
  if (!currentStation) {
    alert('Please select a station first');
    return;
  }
  document.getElementById('sch-station-id').value = currentStation.id;
  document.getElementById('sch-title').value = '';
  document.getElementById('sch-desc').value = '';
  document.getElementById('sch-type').value = 'weekly';
  document.getElementById('sch-time').value = '09:00';
  document.getElementById('sch-duration').value = '60';
  document.querySelectorAll('#modal-new-schedule input[type="checkbox"]').forEach(cb => cb.checked = false);
  // Check weekdays by default
  document.querySelectorAll('#modal-new-schedule input[type="checkbox"]').forEach(cb => {
    if (['1', '2', '3', '4', '5'].includes(cb.value)) cb.checked = true;
  });
  updateScheduleTypeUI();
  showModal('modal-new-schedule');
}

function updateScheduleTypeUI() {
  const type = document.getElementById('sch-type').value;
  document.getElementById('sch-days-ui').style.display = type === 'weekly' ? 'block' : 'none';
  document.getElementById('sch-date-ui').style.display = type === 'once' ? 'block' : 'none';
}

async function createScheduledShow() {
  const stationId = document.getElementById('sch-station-id').value;
  const title = document.getElementById('sch-title').value?.trim();
  const desc = document.getElementById('sch-desc').value?.trim();
  const type = document.getElementById('sch-type').value;
  const time = document.getElementById('sch-time').value;
  const duration = parseInt(document.getElementById('sch-duration').value) || 60;

  if (!title) {
    alert('Show title required');
    return;
  }

  let daysOfWeek = '';
  let targetDate = '';

  if (type === 'weekly') {
    const checked = Array.from(document.querySelectorAll('#modal-new-schedule input[type="checkbox"]:checked')).map(cb => cb.value);
    if (!checked.length) {
      alert('Select at least one day');
      return;
    }
    daysOfWeek = checked.join(',');
  } else if (type === 'once') {
    targetDate = document.getElementById('sch-target-date').value;
    if (!targetDate) {
      alert('Select a date');
      return;
    }
  }

  const result = await api(`/stations/${stationId}/shows`, {
    method: 'POST',
    body: JSON.stringify({
      title, description: desc, schedule_type: type, start_time: time,
      days_of_week: daysOfWeek, target_date: targetDate, duration_minutes: duration
    })
  });

  if (result) {
    showToast('✅ Show scheduled');
    closeModal('modal-new-schedule');
    loadScheduledShows();
  }
}

async function deleteScheduledShow(showId) {
  if (!confirm('Delete this scheduled show?')) return;
  await api(`/shows/${showId}`, { method: 'DELETE' });
  loadScheduledShows();
}

// ════════════════════════════════════
// PLAYLISTS (Jingles, Ads, Sweepers)
// ════════════════════════════════════
async function loadPlaylists() {
  const currentStation = getSelectedStation();
  if (!currentStation) return;

  const playlists = await api(`/stations/${currentStation.id}/playlists`);
  const list = document.getElementById('playlists-list');

  // Filter to only non-default playlists
  const rotationPlaylists = playlists ? playlists.filter(p => !p.is_default) : [];

  if (!rotationPlaylists.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h12M6 4v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4M9 9h6M9 13h6"/></svg></div><h3>No rotation playlists</h3><p>Create playlists for jingles, ads, and sweepers</p></div>';
    return;
  }

  list.innerHTML = rotationPlaylists.map(p => `
    <div style="padding:16px;border:1px solid #eee;border-radius:8px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="flex:1">
          <strong>${esc(p.name)}</strong>
          <div style="font-size:12px;color:#666;margin-top:4px">
            Type: <span style="color:#7C4DFF;font-weight:600">${p.type || 'music'}</span>
            ${p.schedule_rule ? `• Rule: ${p.schedule_rule}` : ''}
            ${p.play_every_n ? `• Every ${p.play_every_n} songs` : ''}
            ${p.item_count ? `• ${p.item_count} item${p.item_count !== 1 ? 's' : ''}` : ''}
          </div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deletePlaylist('${p.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function showPlaylistModal() {
  const currentStation = getSelectedStation();
  if (!currentStation) {
    alert('Please select a station first');
    return;
  }
  document.getElementById('pl-station-id').value = currentStation.id;
  document.getElementById('pl-name').value = '';
  document.getElementById('pl-type').value = 'jingles';
  document.getElementById('pl-rule').value = '';
  document.getElementById('pl-every-n').value = '3';
  updatePlaylistRuleUI();
  showModal('modal-new-playlist');
}

function updatePlaylistRuleUI() {
  const rule = document.getElementById('pl-rule').value;
  document.getElementById('pl-rule-extra').style.display = rule === 'every_N_songs' ? 'block' : 'none';
}

async function createPlaylist() {
  const stationId = document.getElementById('pl-station-id').value;
  const name = document.getElementById('pl-name').value?.trim();
  const type = document.getElementById('pl-type').value;
  const rule = document.getElementById('pl-rule').value;
  const everyN = parseInt(document.getElementById('pl-every-n').value) || 3;
  const mode = document.getElementById('pl-mode').value;

  if (!name) {
    alert('Playlist name required');
    return;
  }

  const result = await api(`/stations/${stationId}/playlists`, {
    method: 'POST',
    body: JSON.stringify({
      name, type, schedule_rule: rule, play_every_n: everyN, play_mode: mode
    })
  });

  if (result) {
    showToast('✅ Playlist created');
    closeModal('modal-new-playlist');
    loadPlaylists();
  }
}

async function deletePlaylist(playlistId) {
  if (!confirm('Delete this playlist?')) return;
  await api(`/playlists/${playlistId}`, { method: 'DELETE' });
  loadPlaylists();
}

// ════════════════════════════════════
// VOICE TRACKS
// ════════════════════════════════════
async function loadVoiceTracks() {
  const currentStation = getSelectedStation();
  if (!currentStation) return;

  const tracks = await api(`/stations/${currentStation.id}/voicetracks`);
  const list = document.getElementById('voicetracks-list');

  if (!tracks || tracks.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div><h3>No voice tracks</h3><p>Record or upload voice tracks for auto-injection</p></div>';
    return;
  }

  list.innerHTML = tracks.map(t => `
    <div style="padding:16px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <strong>${esc(t.presenter)} - ${esc(t.title)}</strong>
        <div style="font-size:12px;color:#666;margin-top:4px">${(t.size / 1024 / 1024).toFixed(1)}MB • ${new Date(t.uploaded_at).toLocaleDateString()}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteVoiceTrack('${currentStation.id}', '${esc(t.filename)}')">Delete</button>
    </div>
  `).join('');
}

function showRecordVTModal() {
  const currentStation = getSelectedStation();
  if (!currentStation) return;
  recordVoiceTrack(currentStation.id);
}

async function deleteVoiceTrack(stationId, filename) {
  if (!confirm('Delete this voice track?')) return;
  await api(`/stations/${stationId}/voicetracks/${filename}`, { method: 'DELETE' });
  loadVoiceTracks();
}

// ════════════════════════════════════
// INIT
// ════════════════════════════════════
try { connectWS(); } catch (e) { console.error('WS init error:', e); }
refreshDashboard().then(() => checkRecordingStates()).catch(e => console.error('Init error:', e));

// Auto-refresh now-playing every 2s for progress bar
setInterval(() => {
  const dashView = document.getElementById('view-dashboard');
  if (dashView?.classList.contains('active')) refreshDashboard();
}, 5000);
