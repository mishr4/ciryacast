// ── Avatar helper ──
function avatarFallback(user) {
  const name = encodeURIComponent(user.display_name || user.email || '?');
  return `https://ui-avatars.com/api/?name=${name}&size=96&background=7C4DFF&color=fff&rounded=true&bold=true`;
}
function getAvatarUrl(user) {
  // 1) direct pfp from the MavionSSO identity payload
  const direct = user.avatar_url || user.profile_picture || user.photo_url || user.picture || '';
  if (direct) return direct;
  // 2) MavionSSO avatar API (302s to their pfp) — by id, then handle
  if (user.id) return `https://sso.tmc.gg/api/avatar?id=${encodeURIComponent(user.id)}`;
  if (user.cirya_handle) return `https://sso.tmc.gg/api/avatar?handle=${encodeURIComponent(user.cirya_handle)}`;
  // 3) generated initials (the API's own fallback points at a dead URL)
  return avatarFallback(user);
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
        avatarEl.innerHTML = `<img src="${pic}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px" onerror="this.onerror=null;this.src='${avatarFallback(u)}'">`;
      } else {
        avatarEl.textContent = (u.display_name || '?')[0].toUpperCase();
      }
    }
  } catch {}
})();

function signOut() {
  // Clears the local TMCast session only — the MavionSSO session lives on
  // sso.tmc.gg, so signing out here doesn't log you out of other Mavion apps.
  sessionStorage.removeItem('ciryacast_user');
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
// Staff API key (only needed when the server has ADMIN_API_KEY set). Stored
// per-browser; prompted once if a protected call comes back NEED_API_KEY.
function getApiKey() { try { return localStorage.getItem('ciryacast_api_key') || ''; } catch { return ''; } }
function authHeaders(extra) {
  const k = getApiKey();
  return Object.assign({}, extra || {}, k ? { 'x-api-key': k } : {});
}
function promptForApiKey() {
  const k = prompt('This action needs the TMCast staff API key (set in Railway as ADMIN_API_KEY):', getApiKey());
  if (k != null) { try { localStorage.setItem('ciryacast_api_key', k.trim()); } catch {} return k.trim(); }
  return '';
}

async function api(path, opts = {}, _retried = false) {
  try {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: authHeaders({ 'Content-Type': 'application/json', ...opts.headers }),
    });
    if (res.status === 401 && !_retried) {
      // Server wants the staff key — ask for it once, then retry
      let body = null; try { body = await res.clone().json(); } catch {}
      if (body && body.code === 'NEED_API_KEY') {
        const k = promptForApiKey();
        if (k) return api(path, opts, true);
      }
    }
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
    if (type === 'force_reload') {
      // Re-check access first: banned users hit the ban screen and stay there,
      // everyone else gets a fresh reload.
      validateAccess().then(ok => { if (ok) location.reload(); });
      return;
    }
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
    if (view === 'scheduling') { populateSchedulingStations(); loadScheduledShows(); }
    if (view === 'playlists') { populatePlaylistStations(); loadPlaylists(); }
    if (view === 'voicetracks') { populateVTStations(); loadVoiceTracks(); }
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
    const artUrl = np?.artwork_url || s.logo_url || '';
    const elapsed = np?.elapsed || 0;
    const duration = np?.duration || 0;
    const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

    return `
      <div class="card now-playing-card" style="margin-bottom:16px">
        <div class="np-hero${artUrl ? '' : ' np-hero-fallback'}"${artUrl ? ` style="background-image:url('${esc(artUrl).replace(/'/g, '%27')}')"` : ''}>
          <div class="np-shade"></div>

          <div class="np-topleft">
            ${s.logo_url ? `<img class="np-logo" src="${esc(s.logo_url)}" alt="">` : ''}
            ${s.live
              ? '<span class="badge" style="background:#ff1744;color:#fff">🎙 LIVE</span>'
              : `<span class="badge ${running ? 'badge-green' : 'badge-red'}">${running ? 'ON AIR' : 'OFFLINE'}</span>`
            }
            ${np?.is_request ? '<span class="badge badge-purple">REQUEST</span>' : ''}
          </div>

          <div class="np-topright">
            <div class="np-listeners">${s.listeners}</div>
            <div class="np-listeners-label">listening</div>
          </div>

          <div class="np-bottom">
            <div class="np-meta">
              <h3>${esc(s.name)}</h3>
              <div class="np-owner">
                ${s.owner ? `Owner: ${esc(s.owner.display_name || s.owner.email)}` : 'No owner'}
                ${s.member_count ? ` • ${s.member_count} member${s.member_count !== 1 ? 's' : ''}` : ''}
              </div>
              ${np ? `<p><strong>${esc(np.artist)}</strong> — ${esc(np.title)}</p>` : '<p class="np-idle">Nothing playing</p>'}
              ${np && duration > 0 ? `
                <div class="np-progress-row">
                  <span>${formatDuration(elapsed)}</span>
                  <div class="np-progress"><div style="width:${progress}%"></div></div>
                  <span>${formatDuration(duration)}</span>
                </div>
              ` : ''}
            </div>
            <button class="np-play-btn" onclick="playStationAudio('${s.id}')" id="listen-btn-${s.id}" title="Monitor audio">
              <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
              <svg class="icon-stop" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
            </button>
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
            Record VT
          </button>
          <button class="btn btn-ghost btn-sm" onclick="goLive('${s.id}')">
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

  restoreMonitorButtonState();
}

// Re-apply the active state to the Listen button after a dashboard re-render
// (the 5s refresh wipes the DOM, but the shared <audio> element keeps playing)
function restoreMonitorButtonState() {
  const audio = document.getElementById('station-monitor-audio');
  if (!audio || audio.paused || !audio.src) return;
  const m = audio.src.match(/\/listen\/([^/]+)\//);
  if (m) document.getElementById(`listen-btn-${m[1]}`)?.classList.add('active');
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

async function editStation(id) {
  const s = stations.find(st => st.id === id);
  if (!s) return;
  document.getElementById('edit-station-id').value = s.id;
  document.getElementById('edit-station-name').value = s.name;
  const slugInput = document.getElementById('edit-station-slug');
  slugInput.value = s.slug || '';
  document.getElementById('slug-preview').textContent = s.slug || s.id;
  slugInput.oninput = () => {
    const v = slugInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    document.getElementById('slug-preview').textContent = v || s.slug || s.id;
  };
  document.getElementById('edit-station-desc').value = s.description || '';
  document.getElementById('edit-station-genre').value = s.genre || 'Various';
  document.getElementById('edit-station-bitrate').value = String(s.bitrate || 128);
  document.getElementById('edit-station-logo').value = s.logo_url || '';
  document.getElementById('edit-station-website').value = s.website_url || '';
  document.getElementById('edit-station-location').value = s.location || '';
  document.getElementById('edit-station-logo-file').value = '';
  document.getElementById('edit-station-owner').value = s.owner_id || '';

  // Load available users for owner selector
  try {
    const allUsers = await api('/admin/users') || [];
    const ownerSelect = document.getElementById('edit-station-owner');
    ownerSelect.innerHTML = '<option value="">No owner assigned</option>';
    allUsers.forEach(user => {
      const option = document.createElement('option');
      option.value = user.id;
      option.textContent = `${user.display_name || user.email}${getCurrentUser()?.id === user.id ? ' (You)' : ''}`;
      ownerSelect.appendChild(option);
    });
    ownerSelect.value = s.owner_id || '';
  } catch (err) {
    console.error('Failed to load users:', err);
  }

  // Update logo preview
  const preview = document.getElementById('logo-preview');
  if (s.logo_url) {
    preview.innerHTML = `<img src="${esc(s.logo_url)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.nextElementSibling?.style?.display && (this.nextElementSibling.style.display='flex')">`;
  } else {
    preview.innerHTML = '<div style="font-size:24px;color:#666">📻</div>';
  }

  showModal('modal-edit-station');
}

function updateLogoPreview() {
  const url = document.getElementById('edit-station-logo').value;
  const preview = document.getElementById('logo-preview');
  if (!url) {
    preview.innerHTML = '<div style="font-size:24px;color:#666">📻</div>';
    return;
  }
  const img = new Image();
  img.onload = () => {
    preview.innerHTML = `<img src="${esc(url)}" style="width:100%;height:100%;object-fit:cover">`;
  };
  img.onerror = () => {
    preview.innerHTML = '<div style="font-size:24px;color:#999">⚠️</div>';
  };
  img.src = url;
}

async function uploadStationLogo() {
  const fileInput = document.getElementById('edit-station-logo-file');
  const file = fileInput.files[0];
  if (!file) {
    toast('Please select an image file first');
    return;
  }

  const stationId = document.getElementById('edit-station-id').value;
  if (!stationId) {
    toast('No station selected');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('logo', file);

    const response = await fetch(`/api/stations/${stationId}/logo`, {
      method: 'POST',
      headers: authHeaders(),
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Upload failed');
    }

    const result = await response.json();
    // Update the logo URL field
    document.getElementById('edit-station-logo').value = result.logo_url;

    // Update preview
    const preview = document.getElementById('logo-preview');
    preview.innerHTML = `<img src="${result.logo_url}?t=${Date.now()}" style="width:100%;height:100%;object-fit:cover">`;

    toast('Logo uploaded successfully!');
    fileInput.value = '';
  } catch (err) {
    toast(`Upload failed: ${err.message}`);
    console.error('Logo upload error:', err);
  }
}

async function saveStation() {
  const id = document.getElementById('edit-station-id').value;
  await api(`/stations/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: document.getElementById('edit-station-name').value,
      slug: document.getElementById('edit-station-slug').value.trim() || null,
      description: document.getElementById('edit-station-desc').value,
      genre: document.getElementById('edit-station-genre').value,
      bitrate: parseInt(document.getElementById('edit-station-bitrate').value),
      logo_url: document.getElementById('edit-station-logo').value || null,
      website_url: document.getElementById('edit-station-website').value || null,
      location: document.getElementById('edit-station-location').value || null,
      owner_id: document.getElementById('edit-station-owner').value || null,
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
                : `<div style="width:36px;height:36px;border-radius:8px;background:#ecebf2;display:flex;align-items:center;justify-content:center">
                    <svg viewBox="0 0 24 24" fill="none" stroke="#9b97b3" stroke-width="2" style="width:16px;height:16px"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
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
                <button class="btn btn-ghost btn-sm" onclick="speedUpMedia('${m.id}')" title="Make a sped-up version">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
                </button>
                <button class="btn btn-ghost btn-sm" onclick="editMediaMeta('${m.id}')" title="Edit metadata">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
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
// Alias — some callers use toast() (logo upload, audio monitor, etc.)
function toast(msg, type) { return showToast(msg, type); }

async function deleteMedia(id) {
  if (!confirm('Delete this track?')) return;
  await api(`/media/${id}`, { method: 'DELETE' });
  refreshMedia();
  refreshDashboard();
}

// ── Speed-up tool (make a "sped up" version of a track) ──
let speedupSelected = 1.25;
function speedUpMedia(id) {
  const m = (allMedia || []).find(x => x.id === id);
  if (!m) return;
  document.getElementById('speedup-media-id').value = id;
  document.getElementById('speedup-track-name').textContent = m.title || m.original_name || 'this track';
  document.getElementById('speedup-keep-pitch').checked = false;
  speedupSelected = 1.25;
  document.querySelectorAll('#speedup-speeds .spd').forEach(b => {
    const on = parseFloat(b.dataset.spd) === speedupSelected;
    b.className = 'btn btn-sm spd ' + (on ? 'btn-primary' : 'btn-ghost');
    b.onclick = () => {
      speedupSelected = parseFloat(b.dataset.spd);
      document.querySelectorAll('#speedup-speeds .spd').forEach(x =>
        x.className = 'btn btn-sm spd ' + (x === b ? 'btn-primary' : 'btn-ghost'));
    };
  });
  showModal('modal-speedup');
}

async function createSpeedUp() {
  const id = document.getElementById('speedup-media-id').value;
  const keepPitch = document.getElementById('speedup-keep-pitch').checked;
  const btn = document.getElementById('speedup-create-btn');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Processing…';
  const res = await api(`/stations/${currentStationId}/media/${id}/speedup`, {
    method: 'POST',
    body: JSON.stringify({ speed: speedupSelected, keepPitch }),
  });
  btn.disabled = false; btn.textContent = orig;
  if (res?.ok) {
    closeModal('modal-speedup');
    showToast(`⏩ Created "${res.title}"`);
    refreshMedia();
  } else {
    showToast(res?.error || 'Speed-up failed', 'error');
  }
}

// ── Manual metadata edit ──
function editMediaMeta(id) {
  const m = (allMedia || []).find(x => x.id === id);
  if (!m) return;
  document.getElementById('edit-media-id').value = m.id;
  document.getElementById('edit-media-title').value = m.title || '';
  document.getElementById('edit-media-artist').value = m.artist === 'Unknown' ? '' : (m.artist || '');
  document.getElementById('edit-media-album').value = m.album || '';
  const prev = document.getElementById('edit-media-art');
  prev.src = m.artwork_url || '';
  prev.style.display = m.artwork_url ? 'block' : 'none';
  showModal('modal-edit-media');
}

async function saveMediaMeta() {
  const id = document.getElementById('edit-media-id').value;
  const title = document.getElementById('edit-media-title').value.trim();
  const artist = document.getElementById('edit-media-artist').value.trim();
  const album = document.getElementById('edit-media-album').value.trim();
  if (!title) return showToast('Title is required', 'error');
  await api(`/media/${id}/meta`, {
    method: 'PATCH',
    body: JSON.stringify({ title, artist: artist || 'Unknown', album }),
  });
  closeModal('modal-edit-media');
  showToast('Metadata updated');
  refreshMedia();
}

// Re-fetch artwork/album for just this one track from Deezer
async function refetchMediaArt() {
  const id = document.getElementById('edit-media-id').value;
  const btn = document.getElementById('edit-media-refetch');
  const orig = btn.textContent;
  btn.textContent = 'Searching…'; btn.disabled = true;
  const res = await api(`/media/${id}/enrich`, { method: 'POST' });
  if (res?.media) {
    document.getElementById('edit-media-title').value = res.media.title || '';
    document.getElementById('edit-media-artist').value = res.media.artist === 'Unknown' ? '' : (res.media.artist || '');
    document.getElementById('edit-media-album').value = res.media.album || '';
    const prev = document.getElementById('edit-media-art');
    prev.src = res.media.artwork_url || '';
    prev.style.display = res.media.artwork_url ? 'block' : 'none';
    showToast(res.enriched ? 'Found a match on Deezer' : 'No confident match — edit by hand');
    refreshMedia();
  }
  btn.textContent = orig; btn.disabled = false;
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
      const res = await fetch(`/api/stations/${currentStationId}/media`, { method: 'POST', headers: authHeaders(), body: form });
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
    const station = await api(`/stations/${sid}`) || {};
    const np = station.now_playing;
    const pendingEl = document.getElementById('requests-pending-list');
    document.getElementById('request-count').textContent = pending.length;

    let content = '';

    // Show now playing section
    if (np && np.title && np.title !== 'Unknown') {
      content += `
        <div style="padding:16px;border-radius:12px;background:#f3f1fa;border:1px solid rgba(124,77,255,0.15);margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:12px">
            ${np.artwork_url ? `<img src="${esc(np.artwork_url)}" style="width:48px;height:48px;border-radius:8px;object-fit:cover">` : '<div style="width:48px;height:48px;border-radius:8px;background:#ecebf2;display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" fill="#9b97b3" style="width:24px"><path d="M12 3v9.28c-1.5 0-3-1.5-3-3s1.5-3 3-3c.88 0 1.65.36 2.2.92.9-.9 1.55-1.68 1.55-1.68L12 3z"/></svg></div>'}
            <div style="flex:1">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;color:#7C4DFF;margin-bottom:2px">Now Playing</div>
              <div style="font-weight:600;font-size:14px">${esc(np.title)}</div>
              <div style="font-size:12px;color:#666">${esc(np.artist)}</div>
            </div>
          </div>
        </div>
      `;
    }

    if (pending.length === 0) {
      if (!np || !np.title || np.title === 'Unknown') {
        content += `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><h3>No pending requests</h3><p>Song requests from listeners will appear here</p></div>`;
      }
    } else {
      content += pending.map((r, i) => `
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

    pendingEl.innerHTML = content;
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

// Audio monitoring for staff
function playStationAudio(stationId) {
  const audio = document.getElementById('station-monitor-audio');
  if (!audio) return;
  const btn = document.getElementById(`listen-btn-${stationId}`);

  if (audio.src && audio.src.includes(stationId) && !audio.paused) {
    // Stop if already playing this station
    audio.pause();
    audio.removeAttribute('src');
    if (btn) btn.classList.remove('active');
  } else {
    // Switching stations — clear active state everywhere first
    document.querySelectorAll('[id^="listen-btn-"]').forEach(el => el.classList.remove('active'));
    audio.src = `/listen/${stationId}/radio.mp3?t=${Date.now()}`;
    audio.play().catch(err => toast(`Failed to play: ${err.message}`));
    if (btn) btn.classList.add('active');
  }
}

// Clear button state when audio ends or is paused
(function initMonitorAudio() {
  const audio = document.getElementById('station-monitor-audio');
  if (!audio) return;
  const clearActive = () =>
    document.querySelectorAll('[id^="listen-btn-"]').forEach(el => el.classList.remove('active'));
  audio.addEventListener('ended', clearActive);
  audio.addEventListener('pause', clearActive);
})();

async function enrichAllMedia() {
  const sid = currentStationId || stations?.[0]?.id;
  if (!sid) return;
  const btn = event.target.closest('.btn');
  const orig = btn.innerHTML;
  btn.innerHTML = 'Enriching...';
  btn.disabled = true;
  try {
    const res = await api(`/stations/${sid}/enrich`, { method: 'POST' });
    btn.innerHTML = `Done! ${res?.cleaned || 0} cleaned, ${res?.enriched || 0} art`;
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

  // Set connection info from the server (Railway TCP proxy host/port —
  // DJ software can NOT connect through the normal HTTPS domain)
  const hostEl = document.getElementById('dj-host');
  const portEl = document.getElementById('dj-port');
  const mountEl = document.getElementById('dj-mount');
  const warnEl = document.getElementById('dj-conn-warning');
  try {
    const info = await api(`/stations/${sid}/connection-info`);
    if (hostEl) hostEl.textContent = info.host;
    if (portEl) portEl.textContent = info.port;
    if (mountEl) mountEl.textContent = info.mount;
    if (warnEl) warnEl.style.display = info.configured ? 'none' : 'block';
    window._djConnInfo = info;
  } catch {
    if (hostEl) hostEl.textContent = location.hostname;
    if (portEl) portEl.textContent = '8005';
    if (mountEl) mountEl.textContent = `/live/${sid}`;
  }

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
      <th>DJ</th><th>Username</th><th>Stream Key</th><th>Status</th><th>Last Live</th><th style="width:150px">Actions</th>
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
            <button class="btn btn-ghost btn-sm" onclick="copyMixxxConfig('${a.id}')" title="Copy full Mixxx settings for this DJ">📋</button>
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

  window._djAccounts = accounts;
}

// Click-to-copy a single connection field
function copyConnField(el) {
  navigator.clipboard.writeText(el.textContent.trim());
  showToast(`Copied: ${el.textContent.trim()}`);
}

// Copy a ready-to-paste Mixxx config block for one DJ account
function copyMixxxConfig(accountId) {
  const a = (window._djAccounts || []).find(x => x.id === accountId);
  const info = window._djConnInfo;
  if (!a || !info) { showToast('Connection info not loaded yet', 'error'); return; }

  const block = [
    `Mixxx → Preferences → Live Broadcasting`,
    `Type:     Icecast 2`,
    `Host:     ${info.host}`,
    `Port:     ${info.port}`,
    `Mount:    ${info.mount}`,
    `Login:    source`,
    `Password: ${a.stream_key}`,
    `Format:   MP3, 128 kbps, Stereo`,
  ].join('\n');

  navigator.clipboard.writeText(block);
  showToast(`📋 Mixxx settings for ${a.display_name || a.username} copied!`);
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
      headers: authHeaders({ 'Content-Type': 'application/json' }),
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

  loadBannedList();

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
let liveMicCtx = null;        // AudioContext (kept so we can wire up monitoring)
let liveMonitorGain = null;   // gain node → speakers, for "hear yourself"
let liveMicOpen = false;      // mic granted + meter should keep animating
let liveMicMime = '';         // chosen MediaRecorder mimeType

// webm/opus etc. → the container name ffmpeg needs on the server side
function micFormatHint(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('aac')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}
function pickMicMime() {
  if (!window.MediaRecorder) return '';
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return c.find(m => MediaRecorder.isTypeSupported(m)) || '';
}
let liveMicProcessor = null;
let liveMicEncoder = null;
let liveMicSource = null;

function goLive(stationId) {
  const s = stations.find(st => st.id === stationId);
  if (!s) return;
  document.getElementById('live-mic-station-id').value = stationId;
  document.getElementById('live-mic-station-name').textContent = esc(s.name);
  const monchk = document.getElementById('mic-monitor-chk');
  if (monchk) monchk.checked = false;
  document.getElementById('mic-start-btn').disabled = false;
  document.getElementById('mic-start-btn').style.display = 'none';
  document.getElementById('mic-btn').style.display = 'none';
  document.getElementById('mic-status').textContent = 'Requesting microphone access…';
  showModal('modal-live-mic');

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(stream => {
      liveMicStream = stream;
      liveMicOpen = true;
      liveMicMime = pickMicMime();
      liveMicCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = liveMicCtx.createMediaStreamSource(stream);
      liveMicAnalyser = liveMicCtx.createAnalyser();
      liveMicAnalyser.fftSize = 256;
      source.connect(liveMicAnalyser);

      // Monitor path: source → gain → speakers. Silent until you tick "Monitor".
      liveMonitorGain = liveMicCtx.createGain();
      liveMonitorGain.gain.value = 0;
      source.connect(liveMonitorGain);
      liveMonitorGain.connect(liveMicCtx.destination);

      document.getElementById('mic-status').textContent = liveMicMime
        ? '✅ Mic ready — tick Monitor to hear yourself, then Start'
        : '⚠ Mic ready, but this browser can’t record — try Chrome or Edge';
      document.getElementById('mic-start-btn').style.display = 'block';

      // Input meter runs the WHOLE time the mic is open (the old code only ran it
      // while broadcasting, so it always looked dead — a big part of "doesn't work").
      const data = new Uint8Array(liveMicAnalyser.frequencyBinCount);
      const tick = () => {
        if (!liveMicOpen || !liveMicAnalyser) return;
        liveMicAnalyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length / 255;
        const el = document.getElementById('mic-meter');
        if (el) el.style.width = Math.min(100, avg * 140) + '%';
        requestAnimationFrame(tick);
      };
      tick();
    })
    .catch(err => {
      document.getElementById('mic-status').textContent = '❌ ' + (err.name || 'Error') + ': ' + err.message;
      document.getElementById('mic-start-btn').disabled = true;
    });
}

// "Hear yourself" toggle — routes the mic to your speakers/headphones so you can
// check your sound BEFORE going live (use headphones or it'll feed back).
function toggleMicMonitor(on) {
  if (!liveMonitorGain || !liveMicCtx) return;
  if (liveMicCtx.state === 'suspended') liveMicCtx.resume();
  liveMonitorGain.gain.value = on ? 1 : 0;
  if (on) showToast('🎧 Monitoring on — use headphones to avoid feedback');
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

  if (!liveMicMime) {
    document.getElementById('mic-status').textContent = '❌ This browser can’t record audio — use Chrome or Edge';
    return;
  }

  // Connect WebSocket for audio streaming. Tell the server the container so it
  // can hand ffmpeg the right -f flag (avoids the silent "no audio" failure).
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?type=livemic&station=${stationId}&user=${user.id}&name=${encodeURIComponent(user.display_name || user.email)}&format=${micFormatHint(liveMicMime)}`;
  liveMicWS = new WebSocket(wsUrl);
  liveMicWS.binaryType = 'arraybuffer';

  liveMicWS.onopen = async () => {
    document.getElementById('mic-status').textContent = '🔴 ON AIR';
    document.getElementById('mic-start-btn').style.display = 'none';
    document.getElementById('mic-btn').style.display = 'block';
    isBroadcasting = true;

    try {
      liveMicRecorder = new MediaRecorder(liveMicStream, { mimeType: liveMicMime, audioBitsPerSecond: 128000 });
      liveMicRecorder.ondataavailable = (e) => {
        if (liveMicWS && liveMicWS.readyState === WebSocket.OPEN && e.data.size > 0) {
          liveMicWS.send(e.data);
        }
      };
      liveMicRecorder.onerror = (e) => { console.error('Recorder error:', e); stopBroadcast(); };
      liveMicRecorder.start(250); // 250ms chunks for low latency
      showToast('🎤 You’re on air!');
    } catch (e) {
      console.error('Recorder setup error:', e);
      document.getElementById('mic-status').textContent = '❌ Recorder failed: ' + e.message;
      stopBroadcast();
    }
  };

  liveMicWS.onerror = (e) => {
    console.error('WebSocket error:', e);
    if (!isBroadcasting) document.getElementById('mic-status').textContent = '❌ Connection failed';
  };

  // The server closes with a code + reason when it refuses or fails — show it,
  // instead of leaving the broadcaster staring at a dead "ON AIR" label.
  liveMicWS.onclose = (ev) => {
    const wasBroadcasting = isBroadcasting;
    isBroadcasting = false;
    if (liveMicRecorder && liveMicRecorder.state !== 'inactive') { try { liveMicRecorder.stop(); } catch {} }
    document.getElementById('mic-btn').style.display = 'none';
    document.getElementById('mic-start-btn').style.display = 'block';
    if (ev.reason) {
      document.getElementById('mic-status').textContent = '⚠ ' + ev.reason;
      showToast('⚠ ' + ev.reason);
    } else if (wasBroadcasting) {
      document.getElementById('mic-status').textContent = '📻 Broadcast ended';
    }
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
  liveMicOpen = false;                 // stops the meter animation loop
  if (liveMonitorGain) { try { liveMonitorGain.gain.value = 0; } catch {} }

  // Stop all microphone tracks
  if (liveMicStream) {
    liveMicStream.getTracks().forEach(t => t.stop());
    liveMicStream = null;
  }
  if (liveMicCtx) { try { liveMicCtx.close(); } catch {} liveMicCtx = null; }
  liveMonitorGain = null;
  liveMicAnalyser = null;

  closeModal('modal-live-mic');
}

// ════════════════════════════════════
// VOICE TRACK RECORDING (native MediaRecorder — no external encoder needed;
// the server converts whatever format the browser produces to MP3)
// ════════════════════════════════════
let vtStream = null;
let vtRecorder = null;
let vtAnalyserNode = null;
let vtIsRecording = false;
let vtChunks = [];
let vtBlob = null;
let vtPreviewUrl = null;   // object URL for the "hear it beforehand" player

function vtPickMimeType() {
  if (!window.MediaRecorder) return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

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
  vtChunks = [];
  vtBlob = null;

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
    alert('Microphone not ready - please close and reopen this dialog, then allow mic access');
    return;
  }

  if (!window.MediaRecorder) {
    alert('Recording is not supported in this browser. Try Chrome, Edge, or Firefox.');
    return;
  }

  const mime = vtPickMimeType();
  console.log('VT: Recording with MediaRecorder, mime:', mime || '(browser default)');

  vtChunks = [];
  vtBlob = null;
  try {
    vtRecorder = new MediaRecorder(vtStream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  } catch (e) {
    console.error('VT: MediaRecorder failed:', e);
    alert('Could not start recorder: ' + e.message);
    return;
  }

  vtRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) vtChunks.push(e.data);
  };

  vtRecorder.onstop = () => {
    vtBlob = new Blob(vtChunks, { type: vtRecorder.mimeType || 'audio/webm' });
    console.log(`VT: Recording stopped — ${(vtBlob.size / 1024).toFixed(0)} KB (${vtBlob.type})`);
    document.getElementById('vt-status').textContent = `✅ Recorded ${(vtBlob.size / 1024).toFixed(0)} KB — have a listen below`;
    // Preview so you can HEAR it before saving or airing
    if (vtPreviewUrl) { try { URL.revokeObjectURL(vtPreviewUrl); } catch {} }
    vtPreviewUrl = URL.createObjectURL(vtBlob);
    const pv = document.getElementById('vt-preview');
    pv.src = vtPreviewUrl; pv.style.display = 'block';
    document.getElementById('vt-rerecord-btn').style.display = 'inline-block';
    document.getElementById('vt-save-btn').style.display = 'block';
    document.getElementById('vt-broadcast-btn').style.display = 'block';
  };

  vtRecorder.onerror = (e) => {
    console.error('VT: Recorder error:', e.error);
    document.getElementById('vt-status').textContent = '❌ Recorder error: ' + (e.error?.message || 'unknown');
  };

  vtRecorder.start(250); // collect data every 250ms

  vtIsRecording = true;
  document.getElementById('vt-status').textContent = '🔴 RECORDING...';
  document.getElementById('vt-start-btn').style.display = 'none';
  document.getElementById('vt-stop-btn').style.display = 'block';
  document.getElementById('vt-save-btn').style.display = 'none';
  document.getElementById('vt-broadcast-btn').style.display = 'none';
  document.getElementById('vt-rerecord-btn').style.display = 'none';
  document.getElementById('vt-preview').style.display = 'none';
  showToast('🎙️ Recording voice track...');
}

function stopVTRecording() {
  vtIsRecording = false;
  if (vtRecorder && vtRecorder.state !== 'inactive') {
    vtRecorder.stop(); // onstop fires and reveals the Save button
  }
  document.getElementById('vt-status').textContent = 'Finishing...';
  document.getElementById('vt-start-btn').style.display = 'none';
  document.getElementById('vt-stop-btn').style.display = 'none';
}

async function saveVoiceTrack() {
  const stationId = document.getElementById('vt-station-id').value;
  const presenter = document.getElementById('vt-presenter').value?.trim() || 'Presenter';
  const title = document.getElementById('vt-title').value?.trim();

  if (!title) {
    alert('Please enter a track title');
    return;
  }
  if (!vtBlob || vtBlob.size === 0) {
    alert('Nothing recorded yet — record something first');
    return;
  }

  document.getElementById('vt-save-btn').disabled = true;
  document.getElementById('vt-status').textContent = 'Uploading & converting...';

  try {
    const response = await fetch(`/api/stations/${stationId}/voicetracks/record?title=${encodeURIComponent(title)}&presenter=${encodeURIComponent(presenter)}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': vtBlob.type || 'audio/webm' }),
      body: vtBlob,
    });

    const result = await response.json();
    if (response.ok) {
      showToast('🎙️ Voice track saved!');
      closeVTModal();
      if (typeof loadVoiceTracks === 'function') loadVoiceTracks();
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

// Air the just-recorded clip to listeners right now. Reuses the live-mic
// pipeline (server converts to MP3, takes the station live, auto-records), but
// since this is a COMPLETE clip we pace the bytes out at ~real-time so the feed
// doesn't dump in one burst and desync everyone.
async function broadcastVoiceTrack() {
  if (!vtBlob || vtBlob.size === 0) { alert('Record something first'); return; }
  const stationId = document.getElementById('vt-station-id').value;
  const presenter = document.getElementById('vt-presenter').value?.trim() || 'Presenter';
  const user = JSON.parse(sessionStorage.getItem('ciryacast_user') || '{}');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?type=livemic&station=${stationId}&user=${user.id || ''}&name=${encodeURIComponent(presenter)}&format=${micFormatHint(vtBlob.type)}`;
  const btn = document.getElementById('vt-broadcast-btn');
  btn.disabled = true;
  document.getElementById('vt-status').textContent = '📡 Airing recording…';

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = async () => {
    const buf = new Uint8Array(await vtBlob.arrayBuffer());
    const CH = 8 * 1024;       // ~0.5s of 128kbps audio
    let o = 0;
    const pump = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (o >= buf.byteLength) { setTimeout(() => { try { ws.close(); } catch {} }, 1500); return; }
      ws.send(buf.subarray(o, o + CH));
      o += CH;
      setTimeout(pump, 500);   // pace to ~real-time
    };
    pump();
  };
  ws.onclose = (ev) => {
    btn.disabled = false;
    if (ev.reason) { document.getElementById('vt-status').textContent = '⚠ ' + ev.reason; showToast('⚠ ' + ev.reason); }
    else { document.getElementById('vt-status').textContent = '✅ Aired to listeners'; showToast('📡 Recording aired'); }
  };
  ws.onerror = () => { btn.disabled = false; showToast('⚠ Broadcast connection failed'); };
}

function closeVTModal() {
  vtIsRecording = false;
  if (vtRecorder && vtRecorder.state !== 'inactive') {
    try { vtRecorder.stop(); } catch {}
  }
  vtRecorder = null;
  if (vtStream) {
    vtStream.getTracks().forEach(t => t.stop());
    vtStream = null;
  }
  if (vtPreviewUrl) { try { URL.revokeObjectURL(vtPreviewUrl); } catch {} vtPreviewUrl = null; }
  const pv = document.getElementById('vt-preview');
  if (pv) { pv.pause?.(); pv.removeAttribute('src'); pv.style.display = 'none'; }
  ['vt-broadcast-btn', 'vt-rerecord-btn', 'vt-save-btn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  vtChunks = [];
  vtBlob = null;
  closeModal('modal-record-vt');
}

// ════════════════════════════════════
// STATION SELECTORS FOR VIEWS
// ════════════════════════════════════
function populateSchedulingStations() {
  const sel = document.getElementById('sch-station-select');
  if (!stations || !stations.length) return;
  sel.innerHTML = '<option value="">Choose a station...</option>' +
    stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
}

function populatePlaylistStations() {
  const sel = document.getElementById('pl-station-select');
  if (!stations || !stations.length) return;
  sel.innerHTML = '<option value="">Choose a station...</option>' +
    stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
}

function populateVTStations() {
  const sel = document.getElementById('vt-station-select');
  if (!stations || !stations.length) return;
  sel.innerHTML = '<option value="">Choose a station...</option>' +
    stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
}

function onSchedulingStationChange() {
  const stationId = document.getElementById('sch-station-select').value;
  document.getElementById('sch-show-btn').disabled = !stationId;
  if (stationId) loadScheduledShows();
}

function onPlaylistStationChange() {
  const stationId = document.getElementById('pl-station-select').value;
  document.getElementById('pl-playlist-btn').disabled = !stationId;
  if (stationId) loadPlaylists();
}

function onVTStationChange() {
  const stationId = document.getElementById('vt-station-select').value;
  document.getElementById('vt-record-btn').disabled = !stationId;
  if (stationId) loadVoiceTracks();
}

// ════════════════════════════════════
// SCHEDULED SHOWS
// ════════════════════════════════════
async function loadScheduledShows() {
  const stationId = document.getElementById('sch-station-select')?.value;
  if (!stationId) return;

  const shows = await api(`/stations/${stationId}/shows`);
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

async function showScheduleModal() {
  const stationId = document.getElementById('sch-station-select')?.value;
  if (!stationId) {
    alert('Please select a station first');
    return;
  }
  document.getElementById('sch-station-id').value = stationId;
  document.getElementById('sch-title').value = '';
  document.getElementById('sch-desc').value = '';
  document.getElementById('sch-type').value = 'weekly';
  document.getElementById('sch-time').value = '18:00';
  document.getElementById('sch-duration').value = '180';
  document.querySelectorAll('#modal-new-schedule input[type="checkbox"]').forEach(cb => cb.checked = false);
  // Check weekdays by default
  document.querySelectorAll('#modal-new-schedule input[type="checkbox"]').forEach(cb => {
    if (['1', '2', '3', '4', '5'].includes(cb.value)) cb.checked = true;
  });
  // Populate the playlist picker — the show plays this playlist during its window
  const sel = document.getElementById('sch-playlist');
  const pls = await api(`/stations/${stationId}/playlists`) || [];
  sel.innerHTML = pls.length
    ? pls.map(p => `<option value="${p.id}">${esc(p.name)}${p.is_default ? ' (default)' : ''} — ${p.item_count || 0} tracks</option>`).join('')
    : '<option value="">No playlists yet — create one in the Playlists tab first</option>';
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
  const playlistId = document.getElementById('sch-playlist').value;

  if (!title) {
    alert('Show title required');
    return;
  }
  if (!playlistId) {
    alert('Pick a playlist for this show — create one in the Playlists tab first.');
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
      title, description: desc, playlist_id: playlistId, schedule_type: type, start_time: time,
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
let _playlists = [];
let _mplLibrary = [];
let _mplItemIds = [];
const SPECIAL_PL_TYPES = ['jingles', 'ads', 'sweepers', 'stingers', 'intros', 'outros', 'top_of_hour', 'bottom_of_hour', 'between_every_song'];

async function loadPlaylists() {
  const stationId = document.getElementById('pl-station-select')?.value;
  if (!stationId) return;

  const playlists = await api(`/stations/${stationId}/playlists`) || [];
  _playlists = playlists;
  const list = document.getElementById('playlists-list');

  if (!playlists.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h12M6 4v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4M9 9h6M9 13h6"/></svg></div><h3>No playlists yet</h3><p>Create a music playlist (e.g. "Latino", "Pop") and set its weight — or a jingles/ads playlist.</p></div>';
    return;
  }

  list.innerHTML = playlists.map(p => {
    const isSpecial = SPECIAL_PL_TYPES.includes(p.type);
    const meta = isSpecial
      ? `Type: <span style="color:#7C4DFF;font-weight:600">${p.type}</span>${p.schedule_rule ? ` • ${p.schedule_rule}` : ''}${p.play_every_n ? ` • every ${p.play_every_n}` : ''}`
      : `🎵 Music • weight <strong>${p.weight ?? 1}</strong>`;
    return `
    <div style="padding:14px 16px;border:1px solid #eee;border-radius:8px;margin-bottom:8px;${p.is_enabled ? '' : 'opacity:.55'}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <strong>${esc(p.name)}</strong>
          ${p.is_default ? '<span style="font-size:10px;background:#ece9ff;color:#7C4DFF;padding:1px 7px;border-radius:99px;margin-left:6px">default</span>' : ''}
          ${p.is_enabled ? '' : '<span style="font-size:11px;color:#c62828;margin-left:6px">disabled</span>'}
          <div style="font-size:12px;color:#666;margin-top:4px">${meta} • ${p.item_count || 0} track${p.item_count === 1 ? '' : 's'}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="managePlaylist('${p.id}')">Manage</button>
          ${p.is_default ? '' : `<button class="btn btn-danger btn-sm" onclick="deletePlaylist('${p.id}')">Delete</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Manage a playlist: settings (weight/mode/enabled) + add/remove tracks ──
async function managePlaylist(id) {
  const sid = document.getElementById('pl-station-select')?.value;
  const pl = _playlists.find(p => p.id === id) || {};
  document.getElementById('mpl-id').value = id;
  document.getElementById('mpl-name').textContent = pl.name || 'Playlist';
  document.getElementById('mpl-weight').value = pl.weight ?? 3;
  document.getElementById('mpl-mode').value = pl.play_mode || 'shuffle';
  document.getElementById('mpl-enabled').checked = pl.is_enabled === undefined ? true : !!pl.is_enabled;
  document.getElementById('mpl-search').value = '';
  showModal('modal-manage-playlist');
  _mplLibrary = (sid ? await api(`/stations/${sid}/media`) : []) || [];
  loadMplTracks();
}

async function loadMplTracks() {
  const id = document.getElementById('mpl-id').value;
  const items = await api(`/playlists/${id}/items`) || [];
  _mplItemIds = items.map(i => i.id);
  document.getElementById('mpl-count').textContent = items.length;
  document.getElementById('mpl-tracks').innerHTML = items.length
    ? items.map(t => `<div style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid #f4f4f4">
        <div style="flex:1;min-width:0"><div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title || 'Untitled')}</div><div style="font-size:11px;color:#999">${esc(t.artist || '')}</div></div>
        <button class="btn btn-ghost btn-sm" title="Remove" onclick="removePlaylistItem('${t.id}')">✕</button></div>`).join('')
    : '<div style="color:#999;font-size:13px;padding:16px;text-align:center">No tracks yet — add from the library →</div>';
  renderMplLibrary();
}

function renderMplLibrary() {
  const q = (document.getElementById('mpl-search').value || '').toLowerCase();
  const lib = (_mplLibrary || []).filter(m => !_mplItemIds.includes(m.id) &&
    (!q || `${m.title || ''} ${m.artist || ''} ${m.album || ''}`.toLowerCase().includes(q)));
  document.getElementById('mpl-library').innerHTML = lib.length
    ? lib.slice(0, 400).map(m => `<div style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid #f4f4f4">
        <div style="flex:1;min-width:0"><div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.title || m.original_name || 'Untitled')}</div><div style="font-size:11px;color:#999">${esc(m.artist || '')}</div></div>
        <button class="btn btn-green btn-sm" onclick="addTrackToPlaylist('${m.id}')">+ Add</button></div>`).join('')
    : '<div style="color:#999;font-size:13px;padding:16px;text-align:center">Nothing to add</div>';
}

async function addTrackToPlaylist(mediaId) {
  const id = document.getElementById('mpl-id').value;
  await api(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify({ media_ids: [mediaId] }) });
  loadMplTracks();
}

async function removePlaylistItem(mediaId) {
  const id = document.getElementById('mpl-id').value;
  await api(`/playlists/${id}/items/${mediaId}`, { method: 'DELETE' });
  loadMplTracks();
}

async function savePlaylistSettings() {
  const id = document.getElementById('mpl-id').value;
  await api(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify({
    weight: parseInt(document.getElementById('mpl-weight').value) || 1,
    play_mode: document.getElementById('mpl-mode').value,
    is_enabled: document.getElementById('mpl-enabled').checked,
  }) });
  showToast('✅ Saved');
  loadPlaylists();
}

function showPlaylistModal() {
  const stationId = document.getElementById('pl-station-select')?.value;
  if (!stationId) {
    alert('Please select a station first');
    return;
  }
  document.getElementById('pl-station-id').value = stationId;
  document.getElementById('pl-name').value = '';
  document.getElementById('pl-type').value = 'music';
  document.getElementById('pl-weight').value = '3';
  document.getElementById('pl-rule').value = '';
  document.getElementById('pl-every-n').value = '3';
  updatePlaylistTypeUI();
  updatePlaylistRuleUI();
  showModal('modal-new-playlist');
}

// Weight matters for music playlists; the schedule-rule is for jingle/ad types.
function updatePlaylistTypeUI() {
  const isMusic = document.getElementById('pl-type').value === 'music';
  document.getElementById('pl-weight-group').style.display = isMusic ? 'block' : 'none';
  document.getElementById('pl-rule-group').style.display = isMusic ? 'none' : 'block';
  updatePlaylistRuleUI();
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
  const weight = parseInt(document.getElementById('pl-weight').value) || 3;

  if (!name) {
    alert('Playlist name required');
    return;
  }

  const result = await api(`/stations/${stationId}/playlists`, {
    method: 'POST',
    body: JSON.stringify({
      name, type, weight,
      schedule_rule: type === 'music' ? '' : rule,
      play_every_n: everyN, play_mode: mode
    })
  });

  if (result) {
    showToast(type === 'music' ? '✅ Playlist created — open Manage to add tracks' : '✅ Playlist created');
    closeModal('modal-new-playlist');
    loadPlaylists();
    if (result.id && type === 'music') managePlaylist(result.id);
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
  const stationId = document.getElementById('vt-station-select')?.value;
  if (!stationId) return;

  const tracks = await api(`/stations/${stationId}/voicetracks`);
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
  const stationId = document.getElementById('vt-station-select')?.value;
  if (!stationId) {
    alert('Please select a station first');
    return;
  }
  recordVoiceTrack(stationId);
}

async function deleteVoiceTrack(stationId, filename) {
  if (!confirm('Delete this voice track?')) return;
  await api(`/stations/${stationId}/voicetracks/${filename}`, { method: 'DELETE' });
  loadVoiceTracks();
}

// ════════════════════════════════════
// ACCESS CONTROL — ban gate
// ════════════════════════════════════
function showBanScreen(message) {
  try { sessionStorage.clear(); } catch {}
  try { if (typeof ws !== 'undefined' && ws) ws.close(); } catch {}
  document.title = 'Access Denied';
  document.body.innerHTML = `
    <div style="position:fixed;inset:0;background:#0a0a12;display:flex;align-items:center;justify-content:center;padding:24px;z-index:99999;font-family:'Instrument Sans',system-ui,sans-serif">
      <div style="text-align:center;max-width:460px">
        <div style="width:84px;height:84px;margin:0 auto 24px;border-radius:50%;background:rgba(255,42,42,0.12);display:flex;align-items:center;justify-content:center">
          <svg viewBox="0 0 24 24" fill="none" stroke="#FF2A2A" stroke-width="2" style="width:42px;height:42px"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        </div>
        <h1 style="color:#fff;font-family:'Lexend',sans-serif;font-size:26px;font-weight:700;margin:0 0 12px">Access Denied</h1>
        <p style="color:rgba(255,255,255,0.7);font-size:15px;line-height:1.6;margin:0 0 8px">${message || 'You have been banned from TMCast and Mavion services.'}</p>
        <p style="color:rgba(255,255,255,0.35);font-size:13px;margin-top:20px">If you believe this is a mistake, contact a TMCast administrator.</p>
      </div>
    </div>`;
}

async function validateAccess() {
  const u = getCurrentUser();
  try {
    const res = await fetch('/api/auth/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u?.email || '' }),
    });
    const data = await res.json();
    if (data.banned) { showBanScreen(data.message); return false; }
  } catch (e) { console.error('Access validation failed:', e); }
  return true;
}

async function banUser() {
  const input = document.getElementById('ban-email-input');
  const email = input.value.trim().toLowerCase();
  if (!email) { showToast('Enter an email to ban', 'error'); return; }
  if (!confirm(`Ban ${email} from TMCast? Everyone currently signed in will be reloaded.`)) return;

  const me = getCurrentUser();
  const res = await api('/admin/ban', {
    method: 'POST',
    body: JSON.stringify({ email, by: me?.email || 'admin' }),
  });
  if (res?.ok) {
    input.value = '';
    const ips = res.known_ips?.length ? res.known_ips.join(', ') : 'none captured yet';
    showToast(`Banned ${email}`);
    const box = document.getElementById('ban-ip-result');
    box.style.display = 'block';
    box.innerHTML = `<strong>${esc(email)}</strong> banned & all sessions reloaded.<br>Known IP(s) for an IP-ban: <code style="user-select:all">${esc(ips)}</code>`;
    loadBannedList();
  } else {
    showToast(res?.error || 'Ban failed', 'error');
  }
}

async function lookupIPs() {
  const email = document.getElementById('ban-email-input').value.trim().toLowerCase();
  if (!email) { showToast('Enter an email to look up', 'error'); return; }
  const res = await api(`/admin/access-log?email=${encodeURIComponent(email)}`);
  const box = document.getElementById('ban-ip-result');
  box.style.display = 'block';
  if (!res || !res.entries?.length) {
    box.innerHTML = `No access logged yet for <strong>${esc(email)}</strong>. The IP is captured the next time they load the dashboard (e.g. after a ban + reload).`;
    return;
  }
  box.innerHTML = `
    <div style="margin-bottom:8px"><strong>${esc(email)}</strong> — unique IPs (copy into Cloudflare):</div>
    <code style="user-select:all;display:block;margin-bottom:10px">${esc(res.unique_ips.join(', ') || 'none')}</code>
    <div style="max-height:160px;overflow:auto;font-size:11px;color:#666">
      ${res.entries.map(e => `<div>${esc(e.ip || '?')} · ${esc((e.at || '').replace('T',' '))} · ${esc((e.user_agent || '').slice(0,40))}</div>`).join('')}
    </div>`;
}

async function loadBannedList() {
  const rows = await api('/admin/banned') || [];
  const el = document.getElementById('banned-list');
  const count = document.getElementById('ban-count');
  if (count) count.textContent = rows.length;
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<p style="text-align:center;color:#999;font-size:13px;padding:12px 0">No banned users</p>`;
    return;
  }
  el.innerHTML = rows.map(b => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid rgba(0,0,0,0.06);border-radius:10px;margin-bottom:8px">
      <div>
        <strong style="font-size:13px">${esc(b.email)}</strong>
        <div style="font-size:11px;color:#999">${b.banned_by ? 'by ' + esc(b.banned_by) : ''}${b.reason ? ' · ' + esc(b.reason) : ''}</div>
      </div>
      ${b.banned_by === 'railway'
        ? '<span class="badge" style="background:#eee;color:#666">env-locked</span>'
        : `<button class="btn btn-ghost btn-sm" onclick="unbanUser('${esc(b.email)}')">Unban</button>`}
    </div>`).join('');
}

async function unbanUser(email) {
  if (!confirm(`Lift the ban on ${email}?`)) return;
  const res = await api('/admin/unban', { method: 'POST', body: JSON.stringify({ email }) });
  if (res?.env_locked) showToast(`${email} is locked by BANNED_EMAILS — remove it in Railway`, 'error');
  else showToast(`Unbanned ${email}`);
  loadBannedList();
}

// ════════════════════════════════════
// INIT
// ════════════════════════════════════
try { connectWS(); } catch (e) { console.error('WS init error:', e); }
validateAccess().then(ok => {
  if (!ok) return; // banned — ban screen is showing, stop booting
  refreshDashboard().then(() => checkRecordingStates()).catch(e => console.error('Init error:', e));
});

// Auto-refresh now-playing every 2s for progress bar
setInterval(() => {
  const dashView = document.getElementById('view-dashboard');
  if (dashView?.classList.contains('active')) refreshDashboard();
}, 5000);
