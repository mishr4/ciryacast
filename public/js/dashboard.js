// ── Auth Gate ──
(function checkAuth() {
  const user = sessionStorage.getItem('ciryacast_user');
  if (!user) {
    window.location.href = '/login';
    return;
  }

  // Show user info in sidebar
  try {
    const u = JSON.parse(user);
    const nameEl = document.getElementById('sidebar-username');
    const handleEl = document.getElementById('sidebar-handle');
    const avatarEl = document.getElementById('sidebar-avatar');

    if (nameEl) nameEl.textContent = u.display_name || u.cirya_handle || 'User';
    if (handleEl) handleEl.textContent = u.cirya_handle ? '@' + u.cirya_handle : u.email || '';
    if (avatarEl) {
      if (u.avatar_url) {
        avatarEl.innerHTML = `<img src="${u.avatar_url}" alt="">`;
      } else {
        avatarEl.textContent = (u.display_name || '?')[0].toUpperCase();
      }
    }
  } catch {}
})();

function signOut() {
  sessionStorage.removeItem('ciryacast_user');
  if (window.CiryaSSO) {
    CiryaSSO.signOut();
  }
  window.location.href = '/login';
}

// ── State ──
let stations = [];
let currentStationId = null;
let ws = null;

// ── WebSocket ──
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    if (type === 'nowplaying' || type === 'track_change') refreshDashboard();
    if (type === 'listeners') updateListenerCount(data.stationId, data.count);
    if (type === 'media_uploaded') { refreshMedia(); refreshDashboard(); }
    if (type === 'station_created' || type === 'station_deleted') { loadStations(); refreshDashboard(); }
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

    // Close mobile sidebar
    closeMobileSidebar();
  });
});

// ── Mobile Menu ──
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebar = document.querySelector('.sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('show');
  });
}

if (sidebarOverlay) {
  sidebarOverlay.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('show');
}

// ── API helpers ──
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  return res.json();
}

// ── Dashboard ──
async function refreshDashboard() {
  const stats = await api('/stats');
  document.getElementById('stat-stations').textContent = stats.stations;
  document.getElementById('stat-listeners').textContent = stats.total_listeners;
  document.getElementById('stat-media').textContent = stats.total_media;
  document.getElementById('stat-played').textContent = stats.total_played;

  stations = await api('/stations');
  renderDashboardStations();
  populateStationSelect();
}

function renderDashboardStations() {
  const el = document.getElementById('dashboard-stations');
  if (stations.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
      </div>
      <h3>No stations yet</h3>
      <p>Create your first station to get started</p>
    </div>`;
    return;
  }

  el.innerHTML = stations.map(s => {
    const np = s.now_playing;
    const running = s.autodj_running;

    return `
      <div class="card now-playing-card" style="margin-bottom:16px">
        <div class="np-info">
          <div class="np-art">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </div>
          <div class="np-meta" style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;flex-wrap:wrap">
              <h3>${esc(s.name)}</h3>
              <span class="badge ${running ? 'badge-green' : 'badge-red'}">${running ? 'ON AIR' : 'OFFLINE'}</span>
            </div>
            ${np ? `<p>${esc(np.artist)} — ${esc(np.title)}</p>` : '<p>Nothing playing</p>'}
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
          <button class="btn btn-ghost btn-sm" onclick="copyListenUrl('${s.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy URL
          </button>
          <a class="btn btn-ghost btn-sm" href="/player/${s.id}" target="_blank">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
            Player
          </a>
        </div>
      </div>
    `;
  }).join('');
}

function updateListenerCount(stationId, count) {
  refreshDashboard();
}

// ── Stations ──
async function loadStations() {
  stations = await api('/stations');
  const el = document.getElementById('stations-list');

  if (stations.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
      </div>
      <h3>No stations</h3>
      <p>Create your first station to get started</p>
    </div>`;
    return;
  }

  el.innerHTML = stations.map(s => `
    <div class="station-card">
      <div class="station-dot ${s.autodj_running ? 'live' : 'offline'}"></div>
      <div class="station-info">
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.description || s.genre)} — ${s.bitrate}kbps</p>
      </div>
      <div class="station-meta">
        <div class="listeners">${s.listeners}</div>
        <div class="listeners-label">listeners</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteStation('${s.id}')">Delete</button>
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

async function deleteStation(id) {
  if (!confirm('Delete this station and all its media?')) return;
  await api(`/stations/${id}`, { method: 'DELETE' });
  refreshDashboard();
  loadStations();
}

// ── AutoDJ Controls ──
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

// ── Media ──
function populateStationSelect() {
  const sel = document.getElementById('media-station-select');
  sel.innerHTML = stations.map(s =>
    `<option value="${s.id}" ${s.id === currentStationId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  if (stations.length > 0 && !currentStationId) currentStationId = stations[0].id;
  sel.onchange = () => { currentStationId = sel.value; refreshMedia(); };
}

async function refreshMedia() {
  if (!currentStationId && stations.length > 0) currentStationId = stations[0].id;
  if (!currentStationId) return;

  const media = await api(`/stations/${currentStationId}/media`);
  document.getElementById('media-count').textContent = `${media.length} files`;

  if (media.length === 0) {
    document.getElementById('media-table-wrap').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        </div>
        <h3>No media yet</h3>
        <p>Upload some audio files to get started</p>
      </div>`;
    return;
  }

  document.getElementById('media-table-wrap').innerHTML = `
    <table class="media-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Artist</th>
          <th>Album</th>
          <th>Duration</th>
          <th>Size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${media.map(m => `
          <tr>
            <td class="title-cell">${esc(m.title || m.original_name)}</td>
            <td class="dim">${esc(m.artist)}</td>
            <td class="dim">${esc(m.album)}</td>
            <td class="dim">${formatDuration(m.duration)}</td>
            <td class="dim">${formatBytes(m.size)}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteMedia('${m.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function deleteMedia(id) {
  await api(`/media/${id}`, { method: 'DELETE' });
  refreshMedia();
  refreshDashboard();
}

// ── Upload ──
const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
let uploading = false;

if (uploadArea && fileInput) {
  uploadArea.addEventListener('click', () => { if (!uploading) fileInput.click(); });
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); if (!uploading) uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (!uploading) handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0 && !uploading) {
      handleFiles(fileInput.files);
    }
  });
}

function showUploadStatus(msg, type) {
  if (!uploadStatus) return;
  uploadStatus.style.display = 'block';
  const colors = { info: '#7C4DFF', success: '#00C853', error: '#FF2A2A' };
  const bgs = { info: '#f0eaff', success: '#e8f5e9', error: '#fce4ec' };
  uploadStatus.innerHTML = `<div style="padding:14px 18px;border-radius:14px;background:${bgs[type] || bgs.info};color:${colors[type] || colors.info};font-size:14px;font-weight:600;margin-bottom:16px">${msg}</div>`;
}

function hideUploadStatus() {
  if (uploadStatus) uploadStatus.style.display = 'none';
}

async function handleFiles(files) {
  if (!currentStationId) return alert('Select a station first');
  if (uploading) return;

  const fileArr = Array.from(files);
  const totalFiles = fileArr.length;
  if (totalFiles === 0) return;

  uploading = true;
  uploadArea.style.opacity = '0.5';
  uploadArea.style.pointerEvents = 'none';

  // Upload one file at a time to avoid timeouts on Railway
  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < fileArr.length; i += BATCH_SIZE) {
    batches.push(fileArr.slice(i, i + BATCH_SIZE));
  }

  let uploaded = 0;
  let failed = 0;

  showUploadStatus(`Uploading 0 / ${totalFiles} files...`, 'info');

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const form = new FormData();
    for (const f of batch) form.append('files', f);

    showUploadStatus(`Uploading ${uploaded} / ${totalFiles} files... (batch ${b + 1}/${batches.length})`, 'info');

    try {
      const res = await fetch(`/api/stations/${currentStationId}/media`, {
        method: 'POST',
        body: form,
      });

      if (res.ok) {
        const data = await res.json();
        uploaded += data.length;
      } else {
        failed += batch.length;
        let errMsg = 'Unknown error';
        try { errMsg = (await res.json()).error || errMsg; } catch { try { errMsg = await res.text(); } catch {} }
        console.error(`Upload batch ${b + 1} failed (${res.status}):`, errMsg);
      }
    } catch (e) {
      failed += batch.length;
      console.error(`Upload batch ${b + 1} network error:`, e);
    }
  }

  // Done
  uploading = false;
  uploadArea.style.opacity = '1';
  uploadArea.style.pointerEvents = 'auto';
  fileInput.value = ''; // reset file input so same files can be re-selected

  if (failed === 0) {
    showUploadStatus(`Successfully uploaded ${uploaded} file${uploaded !== 1 ? 's' : ''}!`, 'success');
  } else if (uploaded > 0) {
    showUploadStatus(`Uploaded ${uploaded} file${uploaded !== 1 ? 's' : ''}, ${failed} failed. Try uploading failed files again.`, 'error');
  } else {
    showUploadStatus(`Upload failed — ${failed} file${failed !== 1 ? 's' : ''} could not be uploaded. Check file format and try smaller batches.`, 'error');
  }

  setTimeout(hideUploadStatus, 8000);

  refreshMedia();
  refreshDashboard();
}

// ── History ──
async function refreshHistory() {
  const sid = currentStationId || (stations[0]?.id);
  if (!sid) return;

  const history = await api(`/stations/${sid}/history?limit=50`);
  const el = document.getElementById('history-list');

  if (history.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <h3>No history yet</h3>
      <p>Tracks will appear here as they play</p>
    </div>`;
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

// ── Modals ──
function showNewStationModal() {
  document.getElementById('modal-new-station').classList.add('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('show');
  });
});

// Escape key closes modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show'));
    closeMobileSidebar();
  }
});

// ── Utilities ──
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

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
  const d = new Date(dateStr + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// ── Init ──
connectWS();
refreshDashboard();
