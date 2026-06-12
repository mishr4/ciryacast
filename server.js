const path = require('path');
const http = require('http');
const net = require('net');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const db = require('./src/db');
const api = require('./src/api');
const { StreamEngine } = require('./src/stream');
const { AutoDJ } = require('./src/autodj');

// HTTP port. When a Railway TCP proxy exists, Railway injects PORT as the
// proxy's APPLICATION port (e.g. 8005) — but the HTTP edge domains forward
// to 8080. If PORT collides with the TCP application port, it's wrong for
// HTTP: fall back to HTTP_PORT (default 8080) so the site stays up.
let PORT = process.env.PORT || 8420;
if (process.env.RAILWAY_TCP_APPLICATION_PORT &&
    String(PORT) === String(process.env.RAILWAY_TCP_APPLICATION_PORT)) {
  PORT = Number(process.env.HTTP_PORT) || 8080;
  console.log(`  ⚠ PORT env equals the TCP proxy application port — using :${PORT} for HTTP instead`);
}
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

function authenticateDJByHeader(authHeader, stationId) {
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

function authenticateDJ(req, stationId) {
  return authenticateDJByHeader(req.headers.authorization, stationId);
}

// Take a station live for an authenticated DJ. Returns a cleanup function.
// `conn` must have .destroy() — an http req or a raw socket — so the
// dashboard "kick DJ" action works for both source paths.
function startLiveSession(stationId, station, dj, conn) {
  console.log(`  🎙 LIVE: ${dj.display_name || dj.username} → "${station.name}"`);

  const wasRunning = autoDJ.isRunning(stationId);
  if (wasRunning) autoDJ.stop(stationId);

  streamEngine.setLive(stationId, true);
  db.prepare("UPDATE dj_accounts SET last_connected = datetime('now') WHERE id = ?").run(dj.id);

  streamEngine.setNowPlaying(stationId, {
    title: 'Live Broadcast',
    artist: dj.display_name || dj.username,
    album: '', duration: 0, media_id: null, artwork_url: '',
  });

  broadcast('live_start', { stationId, dj: dj.display_name || dj.username });
  liveSources.set(stationId, { req: conn, dj, wasRunning });

  return function cleanup() {
    if (!liveSources.has(stationId)) return; // already cleaned up
    console.log(`  🎙 OFF: ${dj.display_name || dj.username} ← "${station.name}"`);
    liveSources.delete(stationId);
    streamEngine.setLive(stationId, false);
    broadcast('live_end', { stationId });
    if (wasRunning) {
      console.log(`  ▶ AutoDJ resuming: "${station.name}"`);
      autoDJ.start(stationId);
    }
  };
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

  if (liveSources.has(stationId) || streamEngine.isLive(stationId)) {
    res.writeHead(409);
    res.end('Another DJ is already live');
    return;
  }

  const cleanup = startLiveSession(stationId, station, dj, req);

  // Icecast clients wait for the 200 before streaming — flush it now
  res.writeHead(200, { 'Connection': 'keep-alive' });
  res.flushHeaders();

  // Relay audio
  req.on('data', (chunk) => {
    streamEngine.pushAudio(stationId, chunk);
  });

  const endSession = () => {
    cleanup();
    try { res.end(); } catch {}
  };
  req.on('close', endSession);
  req.on('error', endSession);
}

// Raw HTTP handler that intercepts live source requests BEFORE Express
function rootHandler(req, res) {
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
}

const server = http.createServer(rootHandler);
// Source connections stream their request body for hours — Node's default
// requestTimeout (300s) would kill every live DJ after 5 minutes.
server.requestTimeout = 0;
server.headersTimeout = 60000;

// Second plain-HTTP listener for Icecast source clients (Mixxx, BUTT, etc).
// Railway's HTTPS edge can't accept raw Icecast connections on 443 — point a
// Railway TCP Proxy at this port and use that host:port in your DJ software.
// RAILWAY_TCP_APPLICATION_PORT is set by Railway to whatever port the TCP
// proxy targets, so the listener always matches the proxy config.
const ICECAST_PORT = process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.ICECAST_PORT || 8005;
// ════════════════════════════════════════════════════
// RAW ICECAST SOURCE SERVER (Mixxx, BUTT, libshout...)
//
// Real Icecast source clients are not valid HTTP: they send SOURCE/PUT
// with NO Content-Length and stream the body forever, and they wait for
// an immediate "HTTP/1.0 200 OK" before sending audio. Node's HTTP parser
// treats a length-less request as bodyless and "completes" it instantly,
// which made Mixxx connect, flash ON AIR, then drop to reconnecting.
// So this port speaks raw TCP and implements the protocol directly.
// ════════════════════════════════════════════════════
function handleIcecastSocket(socket) {
  socket.setNoDelay(true);
  socket.setTimeout(0);

  let headerBuf = Buffer.alloc(0);
  let headersDone = false;
  let session = null; // { stationId, cleanup }

  socket.on('data', (chunk) => {
    if (headersDone) {
      if (session) streamEngine.pushAudio(session.stationId, chunk);
      return;
    }

    headerBuf = Buffer.concat([headerBuf, chunk]);
    if (headerBuf.length > 32 * 1024) { socket.destroy(); return; } // header flood guard
    const idx = headerBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;

    headersDone = true;
    const head = headerBuf.subarray(0, idx).toString('utf8');
    const earlyAudio = headerBuf.subarray(idx + 4);
    headerBuf = Buffer.alloc(0);
    handleRequest(head, earlyAudio);
  });

  function handleRequest(head, earlyAudio) {
    const lines = head.split('\r\n');
    const [method = '', rawPath = ''] = lines[0].split(' ');
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(':');
      if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
    }

    // Mixxx/libshout sends metadata updates as separate GET requests
    if (method.toUpperCase() === 'GET' && rawPath.startsWith('/admin/metadata')) {
      return handleMetadataUpdate(rawPath, headers);
    }

    const m = rawPath.match(/^\/live\/([a-zA-Z0-9_-]+)/);
    if (!m || !['SOURCE', 'PUT', 'POST'].includes(method.toUpperCase())) {
      socket.end('HTTP/1.0 404 Not Found\r\nConnection: Close\r\n\r\n');
      return;
    }

    const stationId = m[1];
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) {
      socket.end('HTTP/1.0 404 Not Found\r\nConnection: Close\r\n\r\n');
      return;
    }

    const dj = authenticateDJByHeader(headers.authorization, stationId);
    if (!dj) {
      socket.end('HTTP/1.0 401 Unauthorized\r\nWWW-Authenticate: Basic realm="CiryaCast"\r\nConnection: Close\r\n\r\n');
      return;
    }

    if (liveSources.has(stationId) || streamEngine.isLive(stationId)) {
      socket.end('HTTP/1.0 409 Conflict\r\nConnection: Close\r\n\r\n');
      return;
    }

    // Accept — libshout waits for this before it starts streaming
    if ((headers.expect || '').toLowerCase().includes('100-continue')) {
      socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    }
    socket.write('HTTP/1.0 200 OK\r\nServer: CiryaCast/1.0\r\nAllow: GET, SOURCE\r\nCache-Control: no-cache\r\n\r\n');

    const cleanup = startLiveSession(stationId, station, dj, socket);
    session = { stationId, cleanup };

    if (earlyAudio.length) streamEngine.pushAudio(stationId, earlyAudio);
  }

  function handleMetadataUpdate(rawPath, headers) {
    try {
      const url = new URL(rawPath, 'http://localhost');
      const mount = url.searchParams.get('mount') || '';
      const song = (url.searchParams.get('song') || '').trim();
      const m = mount.match(/^\/live\/([a-zA-Z0-9_-]+)/);
      const stationId = m && m[1];
      const dj = stationId && authenticateDJByHeader(headers.authorization, stationId);

      if (dj && song && streamEngine.isLive(stationId)) {
        // "Artist - Title" convention; fall back to the whole string as title
        const dash = song.indexOf(' - ');
        streamEngine.setNowPlaying(stationId, {
          title: dash > 0 ? song.slice(dash + 3) : song,
          artist: dash > 0 ? song.slice(0, dash) : (dj.display_name || dj.username),
          album: '', duration: 0, media_id: null, artwork_url: '',
        });
        console.log(`  🎙 Live metadata: ${song}`);
      }
      socket.end('HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\nConnection: Close\r\n\r\n<?xml version="1.0"?><iceresponse><message>Metadata update successful</message><return>1</return></iceresponse>');
    } catch {
      socket.end('HTTP/1.0 400 Bad Request\r\nConnection: Close\r\n\r\n');
    }
  }

  const endSession = () => {
    if (session) { session.cleanup(); session = null; }
  };
  socket.on('close', endSession);
  socket.on('error', endSession);
}

const sourceServer = net.createServer(handleIcecastSocket);
sourceServer.on('error', (e) => {
  // Don't take the whole app down if the source port is busy — the main
  // HTTP server (and its /live handler) still works
  console.log(`  ⚠ Icecast source port :${ICECAST_PORT} unavailable: ${e.message}`);
});

function startSourceServer() {
  if (Number(ICECAST_PORT) === Number(PORT)) {
    console.log(`  🎚 PORT and ICECAST_PORT are both ${PORT} — /live source connections are served on the main port (no separate listener)`);
    return;
  }
  sourceServer.listen(ICECAST_PORT, () => {
    console.log(`  🎚 Icecast source port listening on :${ICECAST_PORT} (expose via Railway TCP Proxy)`);
  });
}

const pubHost = process.env.ICECAST_PUBLIC_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN;
const pubPort = process.env.ICECAST_PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT;
console.log(pubHost
  ? `  🎚 Public DJ address: ${pubHost}:${pubPort}`
  : '  🎚 No public TCP proxy vars found (RAILWAY_TCP_PROXY_DOMAIN unset — redeploy after creating the proxy, or set ICECAST_PUBLIC_HOST/PORT)');

const wss = new WebSocketServer({ server, path: '/ws' });

// ── Middleware ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Pages, JS, CSS, and API must revalidate every load (cheap 304s) so
  // deploys take effect immediately — stale dashboard.js hid all the buttons.
  // Media and audio streams stay cacheable/streamed as-is.
  if (!req.path.startsWith('/media') && !req.path.startsWith('/listen')) {
    res.header('Cache-Control', 'no-cache');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(mediaDir));

// ── API routes ──
app.use('/api', api);

// ── DJ connection info (for Mixxx / BUTT / external streaming software) ──
// Reads Railway's TCP proxy env vars so the dashboard can show the exact
// host:port DJs must use. RAILWAY_TCP_PROXY_DOMAIN/PORT are injected by
// Railway when a TCP proxy is configured on the service.
app.get('/api/stations/:id/connection-info', (req, res) => {
  const station = db.prepare('SELECT id, name FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  // Manual override wins (set ICECAST_PUBLIC_HOST/PORT in Railway Variables),
  // then Railway's auto-injected TCP proxy vars (only present in deployments
  // created AFTER the proxy was added — they're snapshotted at deploy time)
  const proxyDomain = process.env.ICECAST_PUBLIC_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN || '';
  const proxyPort = Number(process.env.ICECAST_PUBLIC_PORT) || Number(process.env.RAILWAY_TCP_PROXY_PORT) || 0;

  res.json({
    configured: !!(proxyDomain && proxyPort),
    type: 'Icecast 2',
    host: proxyDomain || req.hostname,
    port: (proxyDomain && proxyPort) ? proxyPort : Number(ICECAST_PORT),
    mount: `/live/${station.id}`,
    login: 'source',
    station_name: station.name,
  });
});

// ── Clean stream URL redirect ──
app.get('/stream/:stationId', (req, res) => {
  res.redirect(`/listen/${req.params.stationId}/radio.mp3`);
});

// ── Audio stream endpoint ──
app.get('/listen/:stationId/radio.mp3', (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.stationId);
  if (!station) return res.status(404).send('Station not found');

  // ?skip_buffer=1 for low-latency mode (dashboard preview, OBS)
  const skipBuffer = req.query.skip_buffer === '1';

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',       // disable nginx/proxy buffering
    'icy-name': station.name,
    'icy-description': station.description || '',
    'icy-genre': station.genre || 'Various',
    'icy-br': String(station.bitrate || 128),
    'Access-Control-Allow-Origin': '*',
  });

  streamEngine.addListener(station.id, res, skipBuffer);
  req.on('close', () => streamEngine.removeListener(station.id, res));
});

// ── Now Playing API (public — no auth) ──
// Prepared once — this endpoint is polled by every public visitor
const stmtPublicStations = db.prepare(`
  SELECT s.*, u.display_name AS owner_name,
    (SELECT COUNT(*) FROM station_members m WHERE m.station_id = s.id) AS member_count
  FROM stations s
  LEFT JOIN users u ON u.id = s.owner_id
  WHERE s.is_hidden = 0 OR s.is_hidden IS NULL
`);

app.get('/api/nowplaying', (req, res) => {
  const stations = stmtPublicStations.all();
  const result = stations.map(s => ({
    station: {
      id: s.id,
      name: s.name,
      description: s.description,
      genre: s.genre,
      logo_url: s.logo_url || '',
      location: s.location || '',
      owner_name: s.owner_name || '',
      member_count: s.member_count || 0,
    },
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

// ════════════════════════════════════
// WEBSOCKET HANDLERS
// ════════════════════════════════════
const wsLiveMics = new Map(); // ws -> { stationId, ffmpeg, userId, username }

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || 'dashboard';
  const stationId = url.searchParams.get('station');
  const userId = url.searchParams.get('user');
  const username = url.searchParams.get('name') || 'Anonymous';

  if (type === 'livemic' && stationId) {
    // ── Live mic input stream with real-time WebM->MP3 conversion ──

    // Refuse if something is already live on this station — two MP3 sources
    // interleaved into one stream produces corrupted, stuttering audio
    if (streamEngine.isLive(stationId)) {
      console.log(`  🎤 Live mic refused (already live): ${stationId}`);
      ws.close(4009, 'Station is already live');
      return;
    }

    console.log(`  🎤 Live mic connected: ${stationId} (${username})`);

    // Start ffmpeg process to convert WebM to MP3 (low-latency flags:
    // small probe window + flush every packet so audio reaches listeners fast)
    const ffmpeg = spawn('ffmpeg', [
      '-fflags', 'nobuffer',
      '-probesize', '32768',
      '-analyzeduration', '500000',
      '-i', 'pipe:0',           // input from stdin
      '-f', 'mp3',              // output format
      '-b:a', '128k',           // bitrate
      '-flush_packets', '1',    // push each packet immediately
      'pipe:1',                 // output to stdout
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Take over the stream: pause AutoDJ so mic audio is the ONLY source
    const wasRunning = autoDJ.isRunning(stationId);
    if (wasRunning) autoDJ.stop(stationId);
    streamEngine.setLive(stationId, true);
    streamEngine.setNowPlaying(stationId, {
      title: 'Live Broadcast',
      artist: username,
      album: '', duration: 0, media_id: null, artwork_url: '',
    });
    broadcast('live_start', { stationId, dj: username });

    wsLiveMics.set(ws, { stationId, ffmpeg, userId, username, wasRunning });

    // Handle ffmpeg output (MP3 data)
    ffmpeg.stdout.on('data', (chunk) => {
      if (chunk.length > 0) {
        streamEngine.pushLiveAudio(stationId, chunk);
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.log(`  ⚠ FFmpeg error: ${msg.trim().substring(0, 80)}`);
      }
    });

    ffmpeg.on('error', (e) => {
      console.log(`  ⚠ FFmpeg process error: ${e.message}`);
    });

    // Handle incoming WebM chunks from browser
    ws.on('message', (data) => {
      try {
        if (Buffer.isBuffer(data) && ffmpeg.stdin.writable) {
          ffmpeg.stdin.write(data);
        }
      } catch (e) {
        console.log(`  ⚠ Live mic error: ${e.message}`);
      }
    });

    ws.on('close', () => {
      // Close ffmpeg gracefully
      if (ffmpeg && ffmpeg.stdin) {
        ffmpeg.stdin.end();
      }
      setTimeout(() => {
        if (ffmpeg && !ffmpeg.killed) {
          ffmpeg.kill('SIGKILL');
        }
      }, 1000);

      wsLiveMics.delete(ws);
      streamEngine.setLive(stationId, false);
      broadcast('live_end', { stationId });
      if (wasRunning) {
        console.log(`  ▶ AutoDJ resuming after live mic: ${stationId}`);
        autoDJ.start(stationId);
      }
      console.log(`  🎤 Live mic disconnected: ${stationId}`);
    });

  } else {
    // ── Dashboard real-time updates ──
    ws.on('message', (msg) => {
      // Handle dashboard messages (reserved for future use)
    });
    ws.on('close', () => {
      // Dashboard client disconnected
    });
  }
});

// ── Start ──
// The main HTTP server must bind first — if it can't, log clearly and exit
// once instead of crash-looping via an unhandled 'error' on the WSS.
server.on('error', (e) => {
  console.error(`  ✖ Fatal: main HTTP server failed to bind :${PORT} — ${e.message}`);
  process.exit(1);
});
wss.on('error', (e) => {
  console.error(`  ⚠ WebSocketServer error: ${e.message}`);
});

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

  // Optional second listener for DJ source connections — started only after
  // the main server owns its port, and skipped entirely on a port collision
  startSourceServer();

  const stations = db.prepare('SELECT * FROM stations WHERE autodj_enabled = 1').all();
  stations.forEach(s => {
    console.log(`  ▶ AutoDJ starting: "${s.name}"`);
    autoDJ.start(s.id);
  });
});
