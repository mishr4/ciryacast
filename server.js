const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const db = require('./src/db');
const api = require('./src/api');
const { StreamEngine } = require('./src/stream');
const { AutoDJ } = require('./src/autodj');

const PORT = process.env.PORT || 8420;
const app = express();

// ── WebSocket for real-time dashboard updates ──
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Core engines ──
const streamEngine = new StreamEngine(broadcast);
const autoDJ = new AutoDJ(db, streamEngine, broadcast);

// Make engines available to routes
app.set('db', db);
app.set('streamEngine', streamEngine);
app.set('autoDJ', autoDJ);
app.set('broadcast', broadcast);

// ── Ensure directories exist ──
const fs = require('fs');
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const mediaDir = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, 'media');
const dataDir = VOLUME ? path.join(VOLUME, 'data') : path.join(__dirname, 'data');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ════════════════════════════════════════════════════
// LIVE DJ SOURCE — handled at raw HTTP level
// before Express middleware so body parsers don't
// consume the audio stream.
//
// Supports: PUT, POST, and SOURCE (legacy Icecast)
// Auth: Basic auth — username "source", password = stream key
// ════════════════════════════════════════════════════
const liveSources = new Map();
app.set('liveSources', liveSources);

function authenticateDJ(req, stationId) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  const username = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const password = colon >= 0 ? decoded.slice(colon + 1) : '';

  // "source" is standard Icecast username — just match stream_key
  if (username === 'source') {
    return db.prepare(
      'SELECT * FROM dj_accounts WHERE station_id = ? AND stream_key = ? AND is_active = 1'
    ).get(stationId, password) || null;
  }
  return db.prepare(
    'SELECT * FROM dj_accounts WHERE station_id = ? AND username = ? AND stream_key = ? AND is_active = 1'
  ).get(stationId, username, password) || null;
}

function handleLiveSource(req, res, stationId) {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station) {
    res.writeHead(404);
    res.end('Station not found');
    return;
  }

  const dj = authenticateDJ(req, stationId);
  if (!dj) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CiryaCast"' });
    res.end('Unauthorized');
    return;
  }

  if (liveSources.has(stationId)) {
    res.writeHead(409);
    res.end('Another DJ is already live');
    return;
  }

  console.log(`  🎙 LIVE: ${dj.display_name || dj.username} → "${station.name}"`);

  // Pause AutoDJ
  const wasRunning = autoDJ.isRunning(stationId);
  if (wasRunning) autoDJ.stop(stationId);

  streamEngine.setLive(stationId, true);
  db.prepare('UPDATE dj_accounts SET last_connected = datetime("now") WHERE id = ?').run(dj.id);

  streamEngine.setNowPlaying(stationId, {
    title: 'Live Broadcast',
    artist: dj.display_name || dj.username,
    album: '', duration: 0, media_id: null, artwork_url: '',
  });

  broadcast('live_start', { stationId, dj: dj.display_name || dj.username });
  liveSources.set(stationId, { req, dj, wasRunning });

  // Icecast expects a simple 200 OK — no content-type needed
  res.writeHead(200, { 'Connection': 'keep-alive' });

  // Relay audio
  req.on('data', (chunk) => {
    streamEngine.pushAudio(stationId, chunk);
  });

  function cleanup() {
    if (!liveSources.has(stationId)) return; // already cleaned up
    console.log(`  🎙 OFF: ${dj.display_name || dj.username} ← "${station.name}"`);
    liveSources.delete(stationId);
    streamEngine.setLive(stationId, false);
    broadcast('live_end', { stationId });
    if (wasRunning) {
      console.log(`  ▶ AutoDJ resuming: "${station.name}"`);
      autoDJ.start(stationId);
    }
    try { res.end(); } catch {}
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
}

// Raw HTTP server that intercepts live source requests BEFORE Express
const server = http.createServer((req, res) => {
  // Match /live/:stationId for PUT, POST, and SOURCE methods
  const liveMatch = req.url?.match(/^\/live\/([a-zA-Z0-9_-]+)/);
  const method = req.method?.toUpperCase();

  if (liveMatch && (method === 'PUT' || method === 'POST' || method === 'SOURCE')) {
    // Handle live source at raw HTTP level — bypass Express entirely
    req.params = { stationId: liveMatch[1] };
    handleLiveSource(req, res, liveMatch[1]);
    return;
  }

  // Everything else goes to Express
  app(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

// ── Middleware ──
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(mediaDir));

// ── API routes ──
app.use('/api', api);

// ── Clean stream URL redirect ──
app.get('/stream/:stationId', (req, res) => {
  res.redirect(`/listen/${req.params.stationId}/radio.mp3`);
});

// ── Audio stream endpoint ──
app.get('/listen/:stationId/radio.mp3', (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.stationId);
  if (!station) return res.status(404).send('Station not found');

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'icy-name': station.name,
    'icy-description': station.description || '',
    'icy-genre': station.genre || 'Various',
    'icy-br': String(station.bitrate || 128),
    'Access-Control-Allow-Origin': '*',
  });

  streamEngine.addListener(station.id, res);
  req.on('close', () => streamEngine.removeListener(station.id, res));
});

// ── Now Playing API (public — no auth) ──
app.get('/api/nowplaying', (req, res) => {
  const stations = db.prepare('SELECT * FROM stations').all();
  const result = stations.map(s => ({
    station: { id: s.id, name: s.name, description: s.description, genre: s.genre },
    now_playing: streamEngine.getNowPlaying(s.id),
    listeners: { current: streamEngine.getListenerCount(s.id) },
    live: streamEngine.isLive(s.id),
    listen_url: `/listen/${s.id}/radio.mp3`,
  }));
  res.json(result);
});

app.get('/api/nowplaying/:stationId', (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const pendingRequests = db.prepare(
    "SELECT id, title, artist, requested_by FROM song_requests WHERE station_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 5"
  ).all(station.id);

  res.json({
    station: { id: station.id, name: station.name, description: station.description, genre: station.genre },
    now_playing: streamEngine.getNowPlaying(station.id),
    listeners: { current: streamEngine.getListenerCount(station.id) },
    live: streamEngine.isLive(station.id),
    listen_url: `/listen/${station.id}/radio.mp3`,
    request_queue: pendingRequests,
  });
});

// ── Public player page (no auth) ──
app.get('/player', (req, res) => {
  const station = db.prepare('SELECT id FROM stations LIMIT 1').get();
  if (station) return res.redirect(`/player/${station.id}`);
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/player/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ── Stream overlay (OBS browser source) ──
app.get('/overlay/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// ── Public stations directory ──
app.get('/stations', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stations.html'));
});

// ── Login page ──
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Dashboard (SPA fallback) ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         CiryaCast v1.0.0                 ║
  ║   The Mishra Corporation                 ║
  ║                                          ║
  ║   Dashboard:  http://localhost:${PORT}       ║
  ║   Login:      http://localhost:${PORT}/login ║
  ║   API:        http://localhost:${PORT}/api   ║
  ╚══════════════════════════════════════════╝
  `);

  const stations = db.prepare('SELECT * FROM stations WHERE autodj_enabled = 1').all();
  stations.forEach(s => {
    console.log(`  ▶ AutoDJ starting: "${s.name}"`);
    autoDJ.start(s.id);
  });
});
