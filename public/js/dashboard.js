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
  });
});

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
      <div class="empty-icon">&#128225;</div>
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
          <div class="np-art">&#127925;</div>
          <div class="np-meta" style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
              <h3>${esc(s.name)}</h3>
              <span class="badge ${running ? 'badge-green' : 'badge-red'}">${running ? 'ON AIR' : 'OFFLINE'}</span>
            </div>
            ${np ? `<p>${esc(np.artist)} — ${esc(np.title)}</p>` : '<p style="color:var(--text-dim)">Nothing playing</p>'}
          </div>
          <div class="station-meta">
            <div class="listeners">${s.listeners}</div>
            <div>listeners</div>
          </div>
        </div>
        <div class="np-controls">
          ${running
            ? `<button class="btn btn-ghost btn-sm" onclick="skipTrack('${s.id}')">&#9197; Skip</button>
               <button class="btn btn-danger btn-sm" onclick="stopAutoDJ('${s.id}')">&#9209; Stop</button>`
            : `<button class="btn btn-primary btn-sm" onclick="startAutoDJ('${s.id}')">&#9654; Start AutoDJ</button>`
          }
          <button class="btn btn-ghost btn-sm" onclick="copyListenUrl('${s.id}')">&#128279; Copy URL</button>
          <a class="btn btn-ghost btn-sm" href="/player/${s.id}" target="_blank">&#127760; Player Page</a>
        </div>
      </div>
    `;
  }).join('');
}

function updateListenerCount(stationId, count) {
  // Just refresh dashboard — it's fast enough
  refreshDashboard();
}

// ── Stations ──
async function loadStations() {
  stations = await api('/stations');
  const el = document.getElementById('stations-list');

  if (stations.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">&#128225;</div>
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
        <div>listeners</div>
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
  // Quick visual feedback
  const btn = event.target;
  const orig = btn.innerHTML;
  btn.innerHTML = '&#10003; Copied!';
  setTimeout(() => btn.innerHTML = orig, 1500);
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
        <div class="empty-icon">&#127925;</div>
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
            <td><button class="btn btn-danger btn-sm" onclick="deleteMedia('${m.id}')">&#128465;</button></td>
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

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

async function handleFiles(files) {
  if (!currentStationId) return alert('Select a station first');

  const form = new FormData();
  for (const f of files) form.append('files', f);

  uploadArea.innerHTML = '<p>Uploading...</p>';

  try {
    const res = await fetch(`/api/stations/${currentStationId}/media`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    uploadArea.innerHTML = `<div class="upload-icon">&#128266;</div>
      <p><strong>Drop audio files here</strong> or click to browse</p>
      <p style="font-size:12px;margin-top:4px">MP3, OGG, FLAC, WAV, M4A — up to 100MB each</p>`;
    refreshMedia();
    refreshDashboard();
  } catch {
    uploadArea.innerHTML = '<p style="color:var(--accent-red)">Upload failed</p>';
  }
}

// ── History ──
async function refreshHistory() {
  // Get first station's history (or selected)
  const sid = currentStationId || (stations[0]?.id);
  if (!sid) return;

  const history = await api(`/stations/${sid}/history?limit=50`);
  const el = document.getElementById('history-list');

  if (history.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">&#128340;</div>
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

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('show');
  });
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
