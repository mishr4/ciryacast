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
const server = http.createServer(app);

// ── WebSocket for real-time dashboard updates ──
const wss = new WebSocketServer({ server, path: '/ws' });
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
// Use RAILWAY_VOLUME_MOUNT_PATH if available for persistent storage
const fs = require('fs');
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const mediaDir = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, 'media');
const dataDir = VOLUME ? path.join(VOLUME, 'data') : path.join(__dirname, 'data');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

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

// ── Live DJ Source Endpoint ──
// Compatible with Mixxx, BUTT, and other Icecast source clients.
// Connect with: PUT /live/:stationId  (or SOURCE /live/:stationId for legacy)
// Auth: Basic auth → username + stream_key from dj_accounts table
//
// Pauses AutoDJ while live; resumes when DJ disconnects.
// stationId → { req, djAccount }
const liveSources = new Map();

function authenticateDJ(req, stationId) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  let username, password;
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const colon = decoded.indexOf(':');
    username = colon >= 0 ? decoded.slice(0, colon) : decoded;
    password = colon >= 0 ? decoded.slice(colon + 1) : '';
  } else {
    return null;
  }

  // "source" is the default Icecast username — match on stream_key only
  const query = username === 'source'
    ? db.prepare('SELECT * FROM dj_accounts WHERE station_id = ? AND stream_key = ? AND is_active = 1').get(stationId, password)
    : db.prepare('SELECT * FROM dj_accounts WHERE station_id = ? AND username = ? AND stream_key = ? AND is_active = 1').get(stationId, username, password);

  return query || null;
}

// Accept PUT (Icecast) and SOURCE (legacy Shoutcast) for live DJ audio
app.put('/live/:stationId', handleLiveSource);
app.post('/live/:stationId', handleLiveSource);

function handleLiveSource(req, res) {
  const stationId = req.params.stationId;
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station) return res.status(404).send('Station not found');

  const dj = authenticateDJ(req, stationId);
  if (!dj) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CiryaCast Live"');
    return res.status(401).send('Unauthorized — check your stream key');
  }

  // Only one live source per station
  if (liveSources.has(stationId)) {
    return res.status(409).send('Another DJ is already live on this station');
  }

  console.log(`  🎙 LIVE: ${dj.display_name || dj.username} connected to "${station.name}"`);

  // Pause AutoDJ
  const wasRunning = autoDJ.isRunning(stationId);
  if (wasRunning) autoDJ.stop(stationId);

  // Mark station as live
  streamEngine.setLive(stationId, true);
  db.prepare('UPDATE dj_accounts SET last_connected = datetime("now") WHERE id = ?').run(dj.id);

  // Set now-playing to DJ info
  streamEngine.setNowPlaying(stationId, {
    title: 'Live Broadcast',
    artist: dj.display_name || dj.username,
    album: '',
    duration: 0,
    media_id: null,
    artwork_url: '',
    is_live: true,
  });

  broadcast('live_start', { stationId, dj: dj.display_name || dj.username });

  liveSources.set(stationId, { req, dj, wasRunning });

  // Respond with 200 (Icecast expects this to start sending audio)
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });

  // Relay incoming audio to all listeners
  req.on('data', (chunk) => {
    streamEngine.pushAudio(stationId, chunk);
  });

  // DJ disconnects
  req.on('close', () => {
    console.log(`  🎙 OFFLINE: ${dj.display_name || dj.username} disconnected from "${station.name}"`);
    liveSources.delete(stationId);
    streamEngine.setLive(stationId, false);

    broadcast('live_end', { stationId });

    // Resume AutoDJ if it was running before
    if (wasRunning) {
      console.log(`  ▶ AutoDJ resuming: "${station.name}"`);
      autoDJ.start(stationId);
    }

    res.end();
  });

  req.on('error', () => {
    liveSources.delete(stationId);
    streamEngine.setLive(stationId, false);
    if (wasRunning) autoDJ.start(stationId);
    broadcast('live_end', { stationId });
  });
}

// Expose liveSources to API routes
app.set('liveSources', liveSources);

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
  // Redirect to first station's player
  const station = db.prepare('SELECT id FROM stations LIMIT 1').get();
  if (station) return res.redirect(`/player/${station.id}`);
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/player/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
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
