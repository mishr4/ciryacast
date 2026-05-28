const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const router = express.Router();
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
  const { name, description, genre, bitrate } = req.body;

  db.prepare(`
    UPDATE stations SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      genre = COALESCE(?, genre),
      bitrate = COALESCE(?, bitrate),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description, genre, bitrate, req.params.id);

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

  // 1) Check if we already have this song in the library
  let media_id = null;
  const mediaMatch = db.prepare(`
    SELECT id FROM media
    WHERE station_id = ?
      AND (LOWER(title) LIKE ? OR LOWER(original_name) LIKE ?)
      AND (LOWER(artist) LIKE ? OR artist = 'Unknown')
    LIMIT 1
  `).get(
    stationId,
    `%${title.toLowerCase()}%`,
    `%${title.toLowerCase()}%`,
    `%${artist.toLowerCase()}%`
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

          const mediaId = uuid();
          db.prepare(`
            INSERT INTO media (id, station_id, filename, original_name, title, artist, album, duration, size, mime_type, artwork_url, tm_track_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            mediaId, stationId, filename,
            `${artist} - ${title}.mp3`,
            title, artist, album || '', duration || 0,
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
