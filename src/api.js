const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const router = express.Router();

// ── spotDL download (uses curl_cffi to bypass YouTube bot detection) ──
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const os = require('os');

async function spotdlDownload(spotifyId, artist, title) {
  const spotifyUrl = `https://open.spotify.com/track/${spotifyId}`;
  const tmpId = uuid();
  const outTemplate = path.join(os.tmpdir(), `${tmpId}.{output-ext}`);

  console.log(`  🎵 spotDL: ${artist} — ${title} (${spotifyId})`);

  await execFileAsync('spotdl', [
    'download', spotifyUrl,
    '--output', outTemplate,
    '--format', 'mp3',
    '--bitrate', '128k',
  ], { timeout: 120000 });

  // spotDL writes to the template path with the extension resolved
  const outMp3 = path.join(os.tmpdir(), `${tmpId}.mp3`);
  if (!fs.existsSync(outMp3)) {
    // spotDL may use the track name instead — find any new mp3 in tmpdir
    const tmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.endsWith('.mp3'));
    const recent = tmpFiles.map(f => ({ f, t: fs.statSync(path.join(os.tmpdir(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (recent && Date.now() - recent.t < 30000) {
      const alt = path.join(os.tmpdir(), recent.f);
      const buffer = fs.readFileSync(alt);
      try { fs.unlinkSync(alt); } catch {}
      console.log(`  ✓ spotDL: ${(buffer.length / 1024 / 1024).toFixed(1)}MB MP3`);
      return buffer;
    }
    throw new Error('spotDL produced no output file');
  }

  const buffer = fs.readFileSync(outMp3);
  try { fs.unlinkSync(outMp3); } catch {}
  console.log(`  ✓ spotDL: ${(buffer.length / 1024 / 1024).toFixed(1)}MB MP3`);
  return buffer;
}

// ── Password hashing (scrypt, no external deps) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return test === hash;
}
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const MEDIA_DIR = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, '..', 'media');

// ── Pre-load music-metadata (ESM module, cache the promise) ──
let mmLib = null;
const getMetadataParser = async () => {
  if (!mmLib) {
    try {
      mmLib = await import('music-metadata');
    } catch (err) {
      console.log('  ⚠ music-metadata not available:', err.message);
      mmLib = false;
    }
  }
  return mmLib || null;
};

// Eagerly load on startup
getMetadataParser();

// ── Multer config for file uploads ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Ensure media dir exists
    if (!fs.existsSync(MEDIA_DIR)) {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }
    cb(null, MEDIA_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,  // 100MB per file
    files: 200,                     // up to 200 files at once
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.ogg', '.flac', '.wav', '.m4a', '.aac', '.wma'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(null, false); // silently skip non-audio (don't error, just skip)
  },
});

// ════════════════════════════════════
// STATIONS
// ════════════════════════════════════

router.get('/stations', (req, res) => {
  const db = req.app.get('db');
  const stations = db.prepare('SELECT * FROM stations ORDER BY created_at').all();
  const streamEngine = req.app.get('streamEngine');

  const result = stations.map(s => ({
    ...s,
    listeners: streamEngine.getListenerCount(s.id),
    now_playing: streamEngine.getNowPlaying(s.id),
    autodj_running: req.app.get('autoDJ').isRunning(s.id),
    live: streamEngine.isLive(s.id),
  }));
  res.json(result);
});

router.post('/stations', (req, res) => {
  const db = req.app.get('db');
  const { name, description, genre, bitrate } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO stations (id, name, description, genre, bitrate)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, description || '', genre || 'Various', bitrate || 128);

  // Create default playlist
  const plId = uuid();
  db.prepare(`
    INSERT INTO playlists (id, station_id, name, is_default, weight)
    VALUES (?, ?, ?, 1, 1)
  `).run(plId, id, 'General Rotation');

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
  req.app.get('broadcast')('station_created', station);
  res.status(201).json(station);
});

router.put('/stations/:id', (req, res) => {
  const db = req.app.get('db');
  const { name, description, genre, bitrate, logo_url, website_url, location } = req.body;

  db.prepare(`
    UPDATE stations SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      genre = COALESCE(?, genre),
      bitrate = COALESCE(?, bitrate),
      logo_url = COALESCE(?, logo_url),
      website_url = COALESCE(?, website_url),
      location = COALESCE(?, location),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description, genre, bitrate, logo_url || null, website_url || null, location || null, req.params.id);

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  res.json(station);
});

router.get('/stations/:id', (req, res) => {
  const db = req.app.get('db');
  const streamEngine = req.app.get('streamEngine');
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const mediaCount = db.prepare('SELECT COUNT(*) as c FROM media WHERE station_id = ?').get(req.params.id).c;
  const playCount = db.prepare('SELECT COUNT(*) as c FROM play_history WHERE station_id = ?').get(req.params.id).c;

  res.json({
    ...station,
    listeners: streamEngine.getListenerCount(station.id),
    now_playing: streamEngine.getNowPlaying(station.id),
    autodj_running: req.app.get('autoDJ').isRunning(station.id),
    media_count: mediaCount,
    play_count: playCount,
  });
});

router.delete('/stations/:id', (req, res) => {
  const db = req.app.get('db');
  const autoDJ = req.app.get('autoDJ');

  // Stop AutoDJ
  autoDJ.stop(req.params.id);

  // Delete media files
  const media = db.prepare('SELECT filename FROM media WHERE station_id = ?').all(req.params.id);
  media.forEach(m => {
    const fp = path.join(MEDIA_DIR, m.filename);
    try { fs.unlinkSync(fp); } catch {}
  });

  db.prepare('DELETE FROM stations WHERE id = ?').run(req.params.id);
  req.app.get('broadcast')('station_deleted', { id: req.params.id });
  res.json({ ok: true });
});

// ════════════════════════════════════
// AUTODJ CONTROLS
// ════════════════════════════════════

router.post('/stations/:id/autodj/start', (req, res) => {
  const db = req.app.get('db');
  const autoDJ = req.app.get('autoDJ');

  db.prepare('UPDATE stations SET autodj_enabled = 1 WHERE id = ?').run(req.params.id);
  autoDJ.start(req.params.id);
  res.json({ ok: true, running: true });
});

router.post('/stations/:id/autodj/stop', (req, res) => {
  const db = req.app.get('db');
  const autoDJ = req.app.get('autoDJ');

  db.prepare('UPDATE stations SET autodj_enabled = 0 WHERE id = ?').run(req.params.id);
  autoDJ.stop(req.params.id);
  res.json({ ok: true, running: false });
});

router.post('/stations/:id/autodj/skip', (req, res) => {
  const autoDJ = req.app.get('autoDJ');
  autoDJ.skip(req.params.id);
  res.json({ ok: true });
});

// Play a specific track immediately (skip current, play this now)
router.post('/stations/:id/play/:mediaId', (req, res) => {
  const autoDJ = req.app.get('autoDJ');
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.mediaId);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const ok = autoDJ.playNow(req.params.id, req.params.mediaId);
  if (!ok) return res.status(400).json({ error: 'AutoDJ not running for this station' });

  req.app.get('broadcast')('queue_update', { stationId: req.params.id });
  res.json({ ok: true, message: `Now playing: ${media.title}` });
});

// Add a track to the priority queue (plays after current track)
router.post('/stations/:id/queue/:mediaId', (req, res) => {
  const autoDJ = req.app.get('autoDJ');
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.mediaId);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const ok = autoDJ.queueNext(req.params.id, req.params.mediaId);
  if (!ok) return res.status(400).json({ error: 'AutoDJ not running for this station' });

  req.app.get('broadcast')('queue_update', { stationId: req.params.id });
  res.json({ ok: true, message: `Queued: ${media.title}` });
});

// Get the current priority queue
router.get('/stations/:id/queue', (req, res) => {
  const autoDJ = req.app.get('autoDJ');
  const queue = autoDJ.getQueue(req.params.id);
  res.json(queue);
});

// ════════════════════════════════════
// MEDIA
// ════════════════════════════════════

router.get('/stations/:id/media', (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare(
    'SELECT * FROM media WHERE station_id = ? ORDER BY uploaded_at DESC'
  ).all(req.params.id);
  res.json(media);
});

// Upload with multer error handling wrapper
router.post('/stations/:id/media', (req, res) => {
  const uploadHandler = upload.array('files', 200);

  uploadHandler(req, res, async (err) => {
    if (err) {
      console.log('  ⚠ Upload error:', err.message);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large (max 100MB per file)' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({ error: 'Too many files (max 200 per upload)' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(500).json({ error: `Upload failed: ${err.message}` });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No audio files received' });
    }

    const db = req.app.get('db');
    const stationId = req.params.id;

    // Verify station exists
    const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    if (!station) return res.status(404).json({ error: 'Station not found' });

    // Get default playlist once
    const defaultPlaylist = db.prepare(
      'SELECT id FROM playlists WHERE station_id = ? AND is_default = 1'
    ).get(stationId);

    let maxOrder = 0;
    if (defaultPlaylist) {
      const mo = db.prepare(
        'SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?'
      ).get(defaultPlaylist.id);
      maxOrder = mo?.m || 0;
    }

    // Get metadata parser (cached)
    const mm = await getMetadataParser();

    const results = [];
    const insertMedia = db.prepare(`
      INSERT INTO media (id, station_id, filename, original_name, title, artist, album, duration, size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPlaylistItem = defaultPlaylist ? db.prepare(`
      INSERT INTO playlist_items (id, playlist_id, media_id, sort_order)
      VALUES (?, ?, ?, ?)
    `) : null;

    for (const file of req.files) {
      const id = uuid();
      let title = path.parse(file.originalname).name;
      let artist = 'Unknown';
      let album = '';
      let duration = 0;

      // Try to parse metadata
      if (mm) {
        try {
          const metadata = await mm.parseFile(file.path);
          if (metadata.common.title) title = metadata.common.title;
          if (metadata.common.artist) artist = metadata.common.artist;
          if (metadata.common.album) album = metadata.common.album;
          if (metadata.format.duration) duration = Math.round(metadata.format.duration);
        } catch (e) {
          // Metadata parsing failed — use filename, that's fine
          console.log(`  ⚠ Metadata parse failed for ${file.originalname}: ${e.message}`);
        }
      }

      try {
        insertMedia.run(id, stationId, file.filename, file.originalname, title, artist, album, duration, file.size, file.mimetype);

        // Auto-add to default playlist
        if (insertPlaylistItem) {
          maxOrder++;
          insertPlaylistItem.run(uuid(), defaultPlaylist.id, id, maxOrder);
        }

        results.push({ id, title, artist, album, duration, filename: file.filename, size: file.size });
        console.log(`  ✓ Uploaded: ${title} — ${artist} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
      } catch (e) {
        console.log(`  ⚠ DB insert failed for ${file.originalname}: ${e.message}`);
      }
    }

    req.app.get('broadcast')('media_uploaded', { stationId, count: results.length });
    res.status(201).json(results);
  });
});

router.delete('/media/:id', (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  // Delete file
  const fp = path.join(MEDIA_DIR, media.filename);
  try { fs.unlinkSync(fp); } catch {}

  // Delete from DB
  db.prepare('DELETE FROM playlist_items WHERE media_id = ?').run(req.params.id);
  db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

// ════════════════════════════════════
// PLAYLISTS
// ════════════════════════════════════

router.get('/stations/:id/playlists', (req, res) => {
  const db = req.app.get('db');
  const playlists = db.prepare(
    'SELECT * FROM playlists WHERE station_id = ? ORDER BY created_at'
  ).all(req.params.id);

  const result = playlists.map(p => {
    const count = db.prepare(
      'SELECT COUNT(*) as c FROM playlist_items WHERE playlist_id = ?'
    ).get(p.id);
    return { ...p, item_count: count.c };
  });
  res.json(result);
});

router.post('/stations/:id/playlists', (req, res) => {
  const db = req.app.get('db');
  const { name, weight } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO playlists (id, station_id, name, weight)
    VALUES (?, ?, ?, ?)
  `).run(id, req.params.id, name, weight || 1);

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  res.status(201).json(playlist);
});

router.delete('/playlists/:id', (req, res) => {
  const db = req.app.get('db');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(req.params.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════
// PLAY HISTORY
// ════════════════════════════════════

router.get('/stations/:id/history', (req, res) => {
  const db = req.app.get('db');
  const limit = parseInt(req.query.limit) || 20;
  const history = db.prepare(
    'SELECT * FROM play_history WHERE station_id = ? ORDER BY played_at DESC LIMIT ?'
  ).all(req.params.id, limit);
  res.json(history);
});

// ════════════════════════════════════
// STATS
// ════════════════════════════════════

router.get('/stats', (req, res) => {
  const db = req.app.get('db');
  const streamEngine = req.app.get('streamEngine');

  const stations = db.prepare('SELECT * FROM stations').all();
  let totalListeners = 0;
  stations.forEach(s => { totalListeners += streamEngine.getListenerCount(s.id); });

  const totalMedia = db.prepare('SELECT COUNT(*) as c FROM media').get().c;
  const totalPlayed = db.prepare('SELECT COUNT(*) as c FROM play_history').get().c;

  res.json({
    stations: stations.length,
    total_listeners: totalListeners,
    total_media: totalMedia,
    total_played: totalPlayed,
  });
});

// ════════════════════════════════════
// TYPICALMEDIA SEARCH (proxy to avoid CORS)
// ════════════════════════════════════

router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  try {
    const url = `https://api.typicalmedia.net/experiences/searchtrack.php?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    // Normalize: TypicalMedia returns array of track objects
    // Each has: title, artist, album, artwork, id, duration, etc.
    res.json(data);
  } catch (e) {
    console.log('  ⚠ TypicalMedia search error:', e.message);
    res.json([]);
  }
});

// ════════════════════════════════════
// SONG REQUESTS
// ════════════════════════════════════

// Submit a song request (public — from player page)
// Auto-downloads the song from TypicalMedia if not in library
router.post('/stations/:id/requests', async (req, res) => {
  const db = req.app.get('db');
  const stationId = req.params.id;
  const { title, artist, album, artwork_url, tm_track_id, requested_by, duration } = req.body;

  if (!title || !artist) {
    return res.status(400).json({ error: 'Title and artist are required' });
  }

  // Check station exists
  const station = db.prepare('SELECT id FROM stations WHERE id = ?').get(stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  // Rate limit: max 1 request per IP per 30 seconds
  const recentReq = db.prepare(`
    SELECT id FROM song_requests
    WHERE station_id = ? AND requested_by = ? AND status = 'pending'
      AND datetime(created_at) > datetime('now', '-30 seconds')
  `).get(stationId, requested_by || 'Listener');

  if (recentReq) {
    return res.status(429).json({ error: 'Please wait before requesting another song' });
  }

  // 1) Check if we already have this exact song in the library
  //    Use exact match (not fuzzy LIKE) to avoid false positives
  let media_id = null;
  const mediaMatch = db.prepare(`
    SELECT id FROM media
    WHERE station_id = ?
      AND (
        (LOWER(title) = ? AND LOWER(artist) = ?)
        OR (tm_track_id IS NOT NULL AND tm_track_id != '' AND tm_track_id = ?)
      )
    LIMIT 1
  `).get(
    stationId,
    title.toLowerCase(),
    artist.toLowerCase(),
    tm_track_id || ''
  );
  if (mediaMatch) media_id = mediaMatch.id;

  // 2) If not in library and we have a TypicalMedia track ID — download it
  if (!media_id && tm_track_id) {
    try {
      console.log(`  ⬇ Downloading: ${artist} — ${title} (TM ID: ${tm_track_id})`);
      if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const streamUrl = `https://api.typicalmedia.net/experiences/trackstream.php?id=${tm_track_id}`;
      const streamRes = await fetch(streamUrl, { signal: AbortSignal.timeout(60000) });

      if (streamRes.ok) {
        const buffer = Buffer.from(await streamRes.arrayBuffer());

        if (buffer.length > 10000) { // Sanity check — at least 10KB
          const filename = `${uuid()}.mp3`;
          const filePath = path.join(MEDIA_DIR, filename);
          fs.writeFileSync(filePath, buffer);

          // Parse actual file metadata to verify/correct what TypicalMedia reported
          let actualTitle = title;
          let actualArtist = artist;
          let actualAlbum = album || '';
          let actualDuration = duration || 0;
          const mm = await getMetadataParser();
          if (mm) {
            try {
              const meta = await mm.parseFile(filePath);
              if (meta.common.title) actualTitle = meta.common.title;
              if (meta.common.artist) actualArtist = meta.common.artist;
              if (meta.common.album) actualAlbum = meta.common.album;
              if (meta.format.duration) actualDuration = Math.round(meta.format.duration);
            } catch (e) {
              console.log(`  ⚠ Metadata parse on download: ${e.message}`);
            }
          }

          const mediaId = uuid();
          db.prepare(`
            INSERT INTO media (id, station_id, filename, original_name, title, artist, album, duration, size, mime_type, artwork_url, tm_track_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            mediaId, stationId, filename,
            `${actualArtist} - ${actualTitle}.mp3`,
            actualTitle, actualArtist, actualAlbum, actualDuration,
            buffer.length, 'audio/mpeg',
            artwork_url || '', tm_track_id
          );

          // Add to default playlist
          const defaultPlaylist = db.prepare(
            'SELECT id FROM playlists WHERE station_id = ? AND is_default = 1'
          ).get(stationId);
          if (defaultPlaylist) {
            const mo = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(defaultPlaylist.id);
            db.prepare('INSERT INTO playlist_items (id, playlist_id, media_id, sort_order) VALUES (?, ?, ?, ?)').run(
              uuid(), defaultPlaylist.id, mediaId, (mo?.m || 0) + 1
            );
          }

          media_id = mediaId;
          console.log(`  ✓ Downloaded: ${artist} — ${title} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);

          req.app.get('broadcast')('media_uploaded', { stationId, count: 1 });
        } else {
          console.log(`  ⚠ Download too small (${buffer.length} bytes), skipping`);
        }
      } else {
        console.log(`  ⚠ Stream returned ${streamRes.status}`);
      }
    } catch (e) {
      console.log(`  ⚠ Download failed: ${e.message}`);
    }
  }

  const result = db.prepare(`
    INSERT INTO song_requests (station_id, title, artist, album, artwork_url, tm_track_id, media_id, requested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(stationId, title, artist, album || '', artwork_url || '', tm_track_id || '', media_id, requested_by || 'Listener');

  req.app.get('broadcast')('song_request', {
    stationId,
    title,
    artist,
    media_id,
    matched: !!media_id,
  });

  res.status(201).json({
    id: result.lastInsertRowid,
    matched: !!media_id,
    downloaded: !!media_id && !mediaMatch,
    message: media_id
      ? (mediaMatch ? 'Song found in library — queued!' : 'Song downloaded & queued!')
      : 'Requested — download unavailable',
  });
});

// Get pending requests for a station
router.get('/stations/:id/requests', (req, res) => {
  const db = req.app.get('db');
  const status = req.query.status || 'pending';
  const limit = parseInt(req.query.limit) || 50;

  const requests = db.prepare(`
    SELECT * FROM song_requests
    WHERE station_id = ? AND status = ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(req.params.id, status, limit);

  res.json(requests);
});

// Mark a request as played/skipped (dashboard action)
router.patch('/requests/:id', (req, res) => {
  const db = req.app.get('db');
  const { status } = req.body; // 'played', 'skipped', 'pending'
  if (!['played', 'skipped', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.prepare(`
    UPDATE song_requests SET status = ?, played_at = CASE WHEN ? = 'played' THEN datetime('now') ELSE played_at END
    WHERE id = ?
  `).run(status, status, req.params.id);

  res.json({ ok: true });
});

// ════════════════════════════════════
// METADATA ENRICHMENT (TypicalMedia)
// ════════════════════════════════════

router.post('/media/:id/enrich', async (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const query = `${media.artist !== 'Unknown' ? media.artist + ' ' : ''}${media.title}`;
  try {
    const url = `https://api.typicalmedia.net/experiences/searchtrack.php?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const results = await resp.json();

    if (Array.isArray(results) && results.length > 0) {
      const track = results[0];
      // Update with enriched metadata (TypicalMedia fields: album_art, album_name, deezer_id)
      db.prepare(`
        UPDATE media SET
          title = COALESCE(?, title),
          artist = COALESCE(?, artist),
          album = COALESCE(?, album),
          artwork_url = COALESCE(?, artwork_url),
          tm_track_id = COALESCE(?, tm_track_id)
        WHERE id = ?
      `).run(
        track.title || null,
        track.artist || null,
        track.album_name || null,
        track.album_art || null,
        track.deezer_id || track.spotify_id || null,
        req.params.id
      );

      const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
      return res.json({ enriched: true, media: updated });
    }

    res.json({ enriched: false, message: 'No matches found' });
  } catch (e) {
    console.log('  ⚠ Enrich error:', e.message);
    res.status(500).json({ error: 'Enrichment failed: ' + e.message });
  }
});

// Bulk enrich all media for a station
router.post('/stations/:id/enrich', async (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare(
    "SELECT * FROM media WHERE station_id = ? AND (artwork_url IS NULL OR artwork_url = '')"
  ).all(req.params.id);

  let enriched = 0;
  for (const m of media) {
    const query = `${m.artist !== 'Unknown' ? m.artist + ' ' : ''}${m.title}`;
    try {
      const url = `https://api.typicalmedia.net/experiences/searchtrack.php?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const results = await resp.json();

      if (Array.isArray(results) && results.length > 0) {
        const track = results[0];
        db.prepare(`
          UPDATE media SET
            title = COALESCE(?, title),
            artist = COALESCE(?, artist),
            album = COALESCE(?, album),
            artwork_url = COALESCE(?, artwork_url),
            tm_track_id = COALESCE(?, tm_track_id)
          WHERE id = ?
        `).run(
          track.title || null,
          track.artist || null,
          track.album_name || null,
          track.album_art || null,
          track.deezer_id || track.spotify_id || null,
          m.id
        );
        enriched++;
      }
      // Rate limit: small delay between API calls
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }

  res.json({ total: media.length, enriched });
});

// ════════════════════════════════════
// DJ ACCOUNTS
// ════════════════════════════════════

// Generate a random stream key
function generateStreamKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  for (let i = 0; i < 24; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

// List DJ accounts for a station
router.get('/stations/:id/dj-accounts', (req, res) => {
  const db = req.app.get('db');
  const accounts = db.prepare(
    'SELECT id, station_id, username, stream_key, display_name, is_active, created_at, last_connected FROM dj_accounts WHERE station_id = ? ORDER BY created_at'
  ).all(req.params.id);
  res.json(accounts);
});

// Create DJ account
router.post('/stations/:id/dj-accounts', (req, res) => {
  const db = req.app.get('db');
  const { username, display_name } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const station = db.prepare('SELECT id FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  // Check for duplicate username on this station
  const existing = db.prepare('SELECT id FROM dj_accounts WHERE station_id = ? AND username = ?').get(req.params.id, username);
  if (existing) return res.status(409).json({ error: 'Username already exists for this station' });

  const id = uuid();
  const streamKey = generateStreamKey();

  db.prepare(
    'INSERT INTO dj_accounts (id, station_id, username, stream_key, display_name) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.params.id, username, streamKey, display_name || username);

  const account = db.prepare('SELECT * FROM dj_accounts WHERE id = ?').get(id);
  res.status(201).json(account);
});

// Update DJ account
router.put('/dj-accounts/:id', (req, res) => {
  const db = req.app.get('db');
  const { display_name, is_active } = req.body;

  db.prepare(
    'UPDATE dj_accounts SET display_name = COALESCE(?, display_name), is_active = COALESCE(?, is_active) WHERE id = ?'
  ).run(display_name, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);

  const account = db.prepare('SELECT * FROM dj_accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(account);
});

// Regenerate stream key
router.post('/dj-accounts/:id/regenerate-key', (req, res) => {
  const db = req.app.get('db');
  const newKey = generateStreamKey();

  const result = db.prepare('UPDATE dj_accounts SET stream_key = ? WHERE id = ?').run(newKey, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' });

  const account = db.prepare('SELECT * FROM dj_accounts WHERE id = ?').get(req.params.id);
  res.json(account);
});

// Delete DJ account
router.delete('/dj-accounts/:id', (req, res) => {
  const db = req.app.get('db');
  db.prepare('DELETE FROM dj_accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Get live status for a station
router.get('/stations/:id/live', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const liveSources = req.app.get('liveSources');
  const live = liveSources?.has(req.params.id) || false;
  const source = liveSources?.get(req.params.id);

  res.json({
    live,
    dj: source ? (source.dj.display_name || source.dj.username) : null,
    listeners: streamEngine.getListenerCount(req.params.id),
  });
});

// Kick a live DJ (admin action)
router.post('/stations/:id/live/kick', (req, res) => {
  const liveSources = req.app.get('liveSources');
  const source = liveSources?.get(req.params.id);
  if (!source) return res.status(404).json({ error: 'No live DJ on this station' });

  // Destroy the incoming request to force disconnect
  try { source.req.destroy(); } catch {}
  res.json({ ok: true, message: 'DJ kicked' });
});

// ════════════════════════════════════
// USER AUTH & MANAGEMENT
// ════════════════════════════════════

// Login with email + password
router.post('/auth/login', (req, res) => {
  const db = req.app.get('db');
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  // Get assigned stations
  const stations = db.prepare(`
    SELECT s.id, s.name FROM stations s
    JOIN station_assignments sa ON sa.station_id = s.id
    WHERE sa.user_id = ?
  `).all(user.id);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
    },
    stations: stations,
  });
});

// List all users (admin only — no middleware yet, rely on CiryaSSO admin)
router.get('/users', (req, res) => {
  const db = req.app.get('db');
  const users = db.prepare(`
    SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.created_at, u.last_login,
      (SELECT GROUP_CONCAT(s.name, ', ')
       FROM station_assignments sa JOIN stations s ON s.id = sa.station_id
       WHERE sa.user_id = u.id) as assigned_stations,
      (SELECT GROUP_CONCAT(sa.station_id, ',')
       FROM station_assignments sa
       WHERE sa.user_id = u.id) as station_ids
    FROM users u ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Create/invite a user
router.post('/users', (req, res) => {
  const db = req.app.get('db');
  const { email, password, display_name, role, station_ids } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Email already exists' });

  const id = uuid();
  const hash = hashPassword(password);

  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase().trim(), hash, display_name || '', role || 'manager');

  // Assign stations
  if (station_ids && Array.isArray(station_ids)) {
    const insert = db.prepare('INSERT OR IGNORE INTO station_assignments (id, user_id, station_id) VALUES (?, ?, ?)');
    for (const sid of station_ids) {
      insert.run(uuid(), id, sid);
    }
  }

  const user = db.prepare('SELECT id, email, display_name, role, is_active, created_at FROM users WHERE id = ?').get(id);
  res.status(201).json(user);
});

// Update user (change password, display name, role, active status)
router.put('/users/:id', (req, res) => {
  const db = req.app.get('db');
  const { display_name, role, is_active, password } = req.body;

  if (password) {
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const hash = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }

  db.prepare(`
    UPDATE users SET
      display_name = COALESCE(?, display_name),
      role = COALESCE(?, role),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(display_name, role, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id);

  const user = db.prepare('SELECT id, email, display_name, role, is_active, created_at, last_login FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Delete user
router.delete('/users/:id', (req, res) => {
  const db = req.app.get('db');
  db.prepare('DELETE FROM station_assignments WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Assign station to user
router.post('/users/:id/stations', (req, res) => {
  const db = req.app.get('db');
  const { station_id } = req.body;
  if (!station_id) return res.status(400).json({ error: 'station_id required' });

  try {
    db.prepare('INSERT INTO station_assignments (id, user_id, station_id) VALUES (?, ?, ?)').run(uuid(), req.params.id, station_id);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already assigned' });
    throw e;
  }
  res.json({ ok: true });
});

// Remove station assignment
router.delete('/users/:userId/stations/:stationId', (req, res) => {
  const db = req.app.get('db');
  db.prepare('DELETE FROM station_assignments WHERE user_id = ? AND station_id = ?').run(req.params.userId, req.params.stationId);
  res.json({ ok: true });
});

// Get stations assigned to a user (for manager login)
router.get('/users/:id/stations', (req, res) => {
  const db = req.app.get('db');
  const stations = db.prepare(`
    SELECT s.* FROM stations s
    JOIN station_assignments sa ON sa.station_id = s.id
    WHERE sa.user_id = ?
  `).all(req.params.id);
  res.json(stations);
});

// ════════════════════════════════════
// AD BREAKS
// ════════════════════════════════════

// Play an ad break (plays immediately, then resumes previous track)
router.post('/stations/:id/ad-break', async (req, res) => {
  const db = req.app.get('db');
  const autoDJ = req.app.get('autoDJ');
  const stationId = req.params.id;

  if (!autoDJ.isRunning(stationId)) {
    return res.status(400).json({ error: 'AutoDJ not running' });
  }

  const { media_id } = req.body;

  if (media_id) {
    // Use an existing media file as the ad
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(media_id);
    if (!media) return res.status(404).json({ error: 'Media not found' });
    autoDJ.playNow(stationId, media_id);
    return res.json({ ok: true, message: `Ad break: ${media.title}` });
  }

  // Auto-select an ad from media tagged as ads (title contains [AD])
  const ad = db.prepare(
    "SELECT * FROM media WHERE station_id = ? AND (title LIKE '%[AD]%' OR title LIKE '%[ad]%') ORDER BY RANDOM() LIMIT 1"
  ).get(stationId);

  if (ad) {
    autoDJ.playNow(stationId, ad.id);
    return res.json({ ok: true, message: `Ad break: ${ad.title}` });
  }

  res.status(404).json({ error: 'No ad media found — upload a track with [AD] in the title' });
});

// ════════════════════════════════════
// STREAM URL RELAY
// Proxy an external MP3 stream URL as a live source
// ════════════════════════════════════

router.post('/stations/:id/stream-relay/start', async (req, res) => {
  const { stream_url, title, artist } = req.body;
  if (!stream_url) return res.status(400).json({ error: 'stream_url required' });

  const stationId = req.params.id;
  const streamEngine = req.app.get('streamEngine');
  const autoDJ = req.app.get('autoDJ');
  const broadcast = req.app.get('broadcast');

  const relays = req.app.get('streamRelays') || new Map();
  req.app.set('streamRelays', relays);

  if (relays.has(stationId)) return res.status(409).json({ error: 'Already relaying on this station' });

  console.log(`  📡 Relay: ${stream_url} → station ${stationId}`);

  const wasRunning = autoDJ.isRunning(stationId);
  if (wasRunning) autoDJ.stop(stationId);
  streamEngine.setLive(stationId, true);
  streamEngine.setNowPlaying(stationId, {
    title: title || 'Live Stream',
    artist: artist || 'External Source',
    album: '', duration: 0, media_id: null, artwork_url: '',
  });
  broadcast('live_start', { stationId, dj: title || 'External Stream' });

  // Fetch and relay the stream
  const controller = new AbortController();
  const relay = { controller, wasRunning, url: stream_url };
  relays.set(stationId, relay);

  fetch(stream_url, { signal: controller.signal }).then(async (r) => {
    if (!r.ok) {
      relays.delete(stationId);
      streamEngine.setLive(stationId, false);
      if (wasRunning) autoDJ.start(stationId);
      return;
    }
    const reader = r.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !relays.has(stationId)) break;
        streamEngine.pushAudio(stationId, Buffer.from(value));
      }
    } catch {}
    relays.delete(stationId);
    streamEngine.setLive(stationId, false);
    broadcast('live_end', { stationId });
    if (wasRunning) autoDJ.start(stationId);
  }).catch(() => {
    relays.delete(stationId);
    streamEngine.setLive(stationId, false);
    if (wasRunning) autoDJ.start(stationId);
  });

  res.json({ ok: true, url: stream_url });
});

router.post('/stations/:id/stream-relay/stop', (req, res) => {
  const stationId = req.params.id;
  const relays = req.app.get('streamRelays') || new Map();
  const relay = relays.get(stationId);
  if (!relay) return res.status(404).json({ error: 'No relay active' });

  try { relay.controller.abort(); } catch {}
  relays.delete(stationId);
  res.json({ ok: true });
});

// ════════════════════════════════════
// SEARCH & ADD SONGS (TypicalMedia)
// ════════════════════════════════════

// Download a song from TypicalMedia into a station's library
router.post('/stations/:id/add-song', async (req, res) => {
  const db = req.app.get('db');
  const stationId = req.params.id;
  const { title, artist, album, artwork_url, deezer_id, spotify_id, duration } = req.body;

  if (!title || (!deezer_id && !spotify_id)) return res.status(400).json({ error: 'title and deezer_id or spotify_id required' });

  const station = db.prepare('SELECT id FROM stations WHERE id = ?').get(stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  // Check if already exists
  const trackKey = deezer_id ? String(deezer_id) : `sp_${spotify_id}`;
  const existing = db.prepare(
    "SELECT id FROM media WHERE station_id = ? AND tm_track_id = ?"
  ).get(stationId, trackKey);
  if (existing) return res.json({ ok: true, message: 'Already in library', skipped: true });

  // Download — try TypicalMedia first, fall back to Spotisaver
  try {
    console.log(`  ⬇ Adding: ${artist} — ${title}`);
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

    let buffer = null;
    let downloadSource = '';

    // Try TypicalMedia
    if (deezer_id) {
      try {
        const streamUrl = `https://api.typicalmedia.net/experiences/trackstream.php?id=${deezer_id}`;
        const streamRes = await fetch(streamUrl, { signal: AbortSignal.timeout(30000) });
        if (streamRes.ok) {
          const buf = Buffer.from(await streamRes.arrayBuffer());
          if (buf.length >= 10000) { buffer = buf; downloadSource = 'typicalmedia'; }
        }
      } catch (e) {
        console.log(`  ⚠ TypicalMedia failed: ${e.message}`);
      }
    }

    // Fallback: spotDL (Spotify → YouTube via curl_cffi, bypasses bot detection)
    if (!buffer && spotify_id) {
      try {
        console.log(`  ↻ Trying spotDL for ${artist} — ${title}...`);
        const buf = await spotdlDownload(spotify_id, artist || '', title);
        if (buf && buf.length >= 10000) { buffer = buf; downloadSource = 'spotdl'; }
      } catch (e) {
        console.log(`  ⚠ spotDL failed: ${e.message}`);
      }
    }

    if (!buffer) return res.status(502).json({ error: 'Download failed from all sources' });

    const filename = `${uuid()}.mp3`;
    const filePath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    // Parse actual metadata
    let actualTitle = title, actualArtist = artist || 'Unknown', actualAlbum = album || '', actualDuration = duration || 0;
    const mm = await getMetadataParser();
    if (mm) {
      try {
        const meta = await mm.parseFile(filePath);
        if (meta.common.title) actualTitle = meta.common.title;
        if (meta.common.artist) actualArtist = meta.common.artist;
        if (meta.common.album) actualAlbum = meta.common.album;
        if (meta.format.duration) actualDuration = Math.round(meta.format.duration);
      } catch {}
    }

    const mediaId = uuid();
    db.prepare(`
      INSERT INTO media (id, station_id, filename, original_name, title, artist, album, duration, size, mime_type, artwork_url, tm_track_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mediaId, stationId, filename, `${actualArtist} - ${actualTitle}.mp3`,
      actualTitle, actualArtist, actualAlbum, actualDuration,
      buffer.length, 'audio/mpeg', artwork_url || '', trackKey);

    // Add to default playlist
    const defaultPl = db.prepare('SELECT id FROM playlists WHERE station_id = ? AND is_default = 1').get(stationId);
    if (defaultPl) {
      const mo = db.prepare('SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?').get(defaultPl.id);
      db.prepare('INSERT INTO playlist_items (id, playlist_id, media_id, sort_order) VALUES (?, ?, ?, ?)').run(
        uuid(), defaultPl.id, mediaId, (mo?.m || 0) + 1
      );
    }

    console.log(`  ✓ Added (${downloadSource}): ${actualArtist} — ${actualTitle} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    req.app.get('broadcast')('media_uploaded', { stationId, count: 1 });

    res.json({ ok: true, id: mediaId, title: actualTitle, artist: actualArtist });
  } catch (e) {
    console.log(`  ⚠ Add song failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════
// RECORDINGS
// ════════════════════════════════════

// Start recording
router.post('/stations/:id/recording/start', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const { title } = req.body;
  const result = streamEngine.startRecording(req.params.id, title || 'Recording');
  if (!result) return res.status(409).json({ error: 'Already recording on this station' });
  res.json(result);
});

// Stop recording
router.post('/stations/:id/recording/stop', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const result = streamEngine.stopRecording(req.params.id);
  if (!result) return res.status(404).json({ error: 'Not recording' });
  res.json(result);
});

// Get recording status
router.get('/stations/:id/recording', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const status = streamEngine.isRecording(req.params.id);
  res.json({ recording: !!status, ...(status || {}) });
});

// List recordings
router.get('/stations/:id/recordings', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const recordings = streamEngine.listRecordings(req.params.id);
  res.json(recordings);
});

// Download a recording
router.get('/stations/:id/recordings/:recId/download', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const filePath = streamEngine.getRecordingPath(req.params.id, req.params.recId);
  if (!filePath) return res.status(404).json({ error: 'Recording not found' });

  const filename = `recording-${req.params.recId}.mp3`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'audio/mpeg');
  const stream = require('fs').createReadStream(filePath);
  stream.pipe(res);
});

// Delete a recording
router.delete('/stations/:id/recordings/:recId', (req, res) => {
  const streamEngine = req.app.get('streamEngine');
  const ok = streamEngine.deleteRecording(req.params.id, req.params.recId);
  if (!ok) return res.status(404).json({ error: 'Recording not found' });
  res.json({ ok: true });
});

// ════════════════════════════════════
// AZURACAST IMPORT
// ════════════════════════════════════

// Debug: probe AzuraCast API to see the actual response structure
router.post('/stations/:id/import/azuracast/probe', async (req, res) => {
  const { azuracast_url, api_key, azura_station_id } = req.body;
  if (!azuracast_url || !api_key) return res.status(400).json({ error: 'url and api_key required' });

  const baseUrl = azuracast_url.replace(/\/+$/, '');
  const headers = { 'X-API-Key': api_key };
  const sid = azura_station_id || 1;

  const probe = {};
  try {
    // Try /files
    const r1 = await fetch(`${baseUrl}/api/station/${sid}/files`, { headers, signal: AbortSignal.timeout(10000) });
    probe.files_status = r1.status;
    if (r1.ok) {
      const data = await r1.json();
      probe.files_count = Array.isArray(data) ? data.length : 'not array';
      probe.files_sample = Array.isArray(data) ? data.slice(0, 2) : data;
    }
  } catch (e) { probe.files_error = e.message; }

  try {
    // Try /files/list
    const r2 = await fetch(`${baseUrl}/api/station/${sid}/files/list`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowCount: 2, current: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    probe.files_list_status = r2.status;
    if (r2.ok) probe.files_list_sample = await r2.json();
  } catch (e) { probe.files_list_error = e.message; }

  res.json(probe);
});

router.post('/stations/:id/import/azuracast', async (req, res) => {
  const db = req.app.get('db');
  const stationId = req.params.id;
  const { azuracast_url, api_key, azura_station_id } = req.body;

  if (!azuracast_url || !api_key || !azura_station_id) {
    return res.status(400).json({ error: 'azuracast_url, api_key, and azura_station_id are required' });
  }

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const baseUrl = azuracast_url.replace(/\/+$/, '');
  const headers = { 'X-API-Key': api_key };
  const results = { media_imported: 0, media_skipped: 0, media_failed: 0, playlists_imported: 0 };

  // Ensure media dir
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  // Get metadata parser
  const mm = await getMetadataParser();

  try {
    // ── 1) Fetch playlists from AzuraCast ──
    console.log(`  📥 AzuraCast import: fetching playlists from ${baseUrl}`);
    const playlistMap = new Map(); // azura playlist id -> ciryacast playlist id

    try {
      const plRes = await fetch(`${baseUrl}/api/station/${azura_station_id}/playlists`, { headers, signal: AbortSignal.timeout(15000) });
      if (plRes.ok) {
        const playlists = await plRes.json();
        for (const pl of playlists) {
          // Check if playlist already exists by name
          let existing = db.prepare('SELECT id FROM playlists WHERE station_id = ? AND name = ?').get(stationId, pl.name);
          if (!existing) {
            const plId = uuid();
            db.prepare('INSERT INTO playlists (id, station_id, name, weight) VALUES (?, ?, ?, ?)').run(
              plId, stationId, pl.name, pl.weight || 1
            );
            existing = { id: plId };
            results.playlists_imported++;
            console.log(`    ✓ Playlist: ${pl.name}`);
          }
          playlistMap.set(pl.id, existing.id);
        }
      }
    } catch (e) {
      console.log(`    ⚠ Playlist fetch failed: ${e.message}`);
    }

    // Get or create default playlist
    let defaultPlaylist = db.prepare('SELECT id FROM playlists WHERE station_id = ? AND is_default = 1').get(stationId);
    if (!defaultPlaylist) {
      const dpId = uuid();
      db.prepare('INSERT INTO playlists (id, station_id, name, is_default, weight) VALUES (?, ?, ?, 1, 1)').run(dpId, stationId, 'General Rotation');
      defaultPlaylist = { id: dpId };
    }

    // ── 2) Fetch media files from AzuraCast ──
    console.log(`  📥 AzuraCast import: fetching media list`);
    let mediaList = [];
    try {
      const mRes = await fetch(`${baseUrl}/api/station/${azura_station_id}/files`, { headers, signal: AbortSignal.timeout(30000) });
      if (mRes.ok) {
        mediaList = await mRes.json();
        console.log(`    Found ${mediaList.length} files`);
      } else {
        // Try alternate endpoint
        const mRes2 = await fetch(`${baseUrl}/api/station/${azura_station_id}/files/list`, { headers, signal: AbortSignal.timeout(30000) });
        if (mRes2.ok) mediaList = await mRes2.json();
      }
    } catch (e) {
      console.log(`    ⚠ Media list failed: ${e.message}`);
    }

    // Log first file structure for debugging
    if (mediaList.length > 0) {
      console.log(`    Sample file keys: ${Object.keys(mediaList[0]).join(', ')}`);
      if (mediaList[0].song) console.log(`    Song keys: ${Object.keys(mediaList[0].song).join(', ')}`);
      if (mediaList[0].links) console.log(`    Links: ${JSON.stringify(mediaList[0].links)}`);
      console.log(`    Sample: id=${mediaList[0].id}, unique_id=${mediaList[0].unique_id}, path=${mediaList[0].path}`);
    }

    // ── 3) Download each file ──
    for (const file of mediaList) {
      const title = file.title || file.song?.title || '';
      const artist = file.artist || file.song?.artist || '';
      const album = file.album || file.song?.album || '';

      // Skip if we already have this exact track
      const existing = db.prepare(
        'SELECT id FROM media WHERE station_id = ? AND LOWER(title) = ? AND LOWER(artist) = ?'
      ).get(stationId, title.toLowerCase(), artist.toLowerCase());

      if (existing) {
        results.media_skipped++;
        continue;
      }

      // Try to download the file
      try {
        // Build all possible download URLs for AzuraCast
        const fileId = file.id;
        const uniqueId = file.unique_id;
        const azuraPath = file.path; // e.g. "media/Artist - Title.mp3"

        const downloadUrls = [
          // links.download is the most reliable (full API path)
          file.links?.download ? (file.links.download.startsWith('http') ? file.links.download : `${baseUrl}${file.links.download}`) : null,
          // Direct file endpoint by numeric ID
          fileId ? `${baseUrl}/api/station/${azura_station_id}/file/${fileId}` : null,
          // By unique_id
          uniqueId ? `${baseUrl}/api/station/${azura_station_id}/file/${uniqueId}` : null,
          // By path (URL-encoded)
          azuraPath ? `${baseUrl}/api/station/${azura_station_id}/file/${encodeURIComponent(azuraPath)}` : null,
        ].filter(Boolean);

        let buffer = null;
        let lastStatus = '';
        for (const url of downloadUrls) {
          try {
            const dlRes = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
            lastStatus = `${dlRes.status} ${dlRes.statusText}`;
            if (dlRes.ok) {
              buffer = Buffer.from(await dlRes.arrayBuffer());
              if (buffer.length > 5000) break;
              buffer = null; // too small, try next URL
            }
          } catch (e) { lastStatus = e.message; }
        }

        if (!buffer || buffer.length < 5000) {
          if (results.media_failed < 3) console.log(`    ⚠ Failed: ${artist} - ${title} (${lastStatus}) tried ${downloadUrls.length} URLs`);
          results.media_failed++;
          continue;
        }

        // Save file
        const filename = `${uuid()}.mp3`;
        const filePath = path.join(MEDIA_DIR, filename);
        fs.writeFileSync(filePath, buffer);

        // Parse actual metadata from file
        let actualTitle = title || 'Unknown';
        let actualArtist = artist || 'Unknown';
        let actualAlbum = album || '';
        let duration = file.length || file.song?.length || 0;
        let artworkUrl = file.art || file.song?.art || '';

        if (mm) {
          try {
            const meta = await mm.parseFile(filePath);
            if (meta.common.title) actualTitle = meta.common.title;
            if (meta.common.artist) actualArtist = meta.common.artist;
            if (meta.common.album) actualAlbum = meta.common.album;
            if (meta.format.duration) duration = Math.round(meta.format.duration);
          } catch {}
        }

        // Insert into DB
        const mediaId = uuid();
        db.prepare(`
          INSERT INTO media (id, station_id, filename, original_name, title, artist, album, duration, size, mime_type, artwork_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          mediaId, stationId, filename,
          `${actualArtist} - ${actualTitle}.mp3`,
          actualTitle, actualArtist, actualAlbum,
          duration, buffer.length, 'audio/mpeg', artworkUrl
        );

        // Add to appropriate playlist
        const playlists = file.playlists || [];
        let addedToPlaylist = false;
        for (const pl of playlists) {
          const ccPlId = playlistMap.get(pl.id || pl);
          if (ccPlId) {
            db.prepare('INSERT INTO playlist_items (id, playlist_id, media_id, sort_order) VALUES (?, ?, ?, ?)').run(
              uuid(), ccPlId, mediaId, 0
            );
            addedToPlaylist = true;
          }
        }
        // Fallback: add to default playlist
        if (!addedToPlaylist) {
          db.prepare('INSERT INTO playlist_items (id, playlist_id, media_id, sort_order) VALUES (?, ?, ?, ?)').run(
            uuid(), defaultPlaylist.id, mediaId, 0
          );
        }

        results.media_imported++;
        console.log(`    ✓ ${actualArtist} — ${actualTitle} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);

        // Small delay to avoid hammering the AzuraCast API
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        results.media_failed++;
        console.log(`    ⚠ Failed: ${title} — ${e.message}`);
      }
    }

    console.log(`  📥 Import complete: ${results.media_imported} imported, ${results.media_skipped} skipped, ${results.media_failed} failed, ${results.playlists_imported} playlists`);

    req.app.get('broadcast')('media_uploaded', { stationId, count: results.media_imported });
    res.json(results);

  } catch (e) {
    console.log(`  ⚠ Import error: ${e.message}`);
    res.status(500).json({ error: `Import failed: ${e.message}`, ...results });
  }
});

// ── Global multer error handler ──
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.log('  ⚠ Multer error:', err.code, err.message);
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.log('  ⚠ API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
  next();
});

module.exports = router;
