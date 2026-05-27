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

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// ── API routes ──
app.use('/api', api);

// ── Audio stream endpoint ──
// GET /listen/:stationId/radio.mp3
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

  req.on('close', () => {
    streamEngine.removeListener(station.id, res);
  });
});

// ── Now Playing API (public) ──
app.get('/api/nowplaying', (req, res) => {
  const stations = db.prepare('SELECT * FROM stations').all();
  const result = stations.map(s => {
    const np = streamEngine.getNowPlaying(s.id);
    const listeners = streamEngine.getListenerCount(s.id);
    return {
      station: { id: s.id, name: s.name, description: s.description, genre: s.genre },
      now_playing: np,
      listeners: { current: listeners },
      live: streamEngine.isLive(s.id),
      listen_url: `/listen/${s.id}/radio.mp3`,
    };
  });
  res.json(result);
});

app.get('/api/nowplaying/:stationId', (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const np = streamEngine.getNowPlaying(station.id);
  const listeners = streamEngine.getListenerCount(station.id);
  res.json({
    station: { id: station.id, name: station.name, description: station.description, genre: station.genre },
    now_playing: np,
    listeners: { current: listeners },
    live: streamEngine.isLive(station.id),
    listen_url: `/listen/${station.id}/radio.mp3`,
  });
});

// ── Public player page ──
app.get('/player/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ── SPA fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         CiryaCast v1.0.0                 ║
  ║   Lightweight Radio Station Platform     ║
  ║                                          ║
  ║   Dashboard:  http://localhost:${PORT}      ║
  ║   API:        http://localhost:${PORT}/api  ║
  ╚══════════════════════════════════════════╝
  `);

  // Auto-start AutoDJ for all active stations
  const stations = db.prepare('SELECT * FROM stations WHERE autodj_enabled = 1').all();
  stations.forEach(s => {
    console.log(`  ▶ Starting AutoDJ for "${s.name}"`);
    autoDJ.start(s.id);
  });
});
