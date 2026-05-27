const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const router = express.Router();
const MEDIA_DIR = path.join(__dirname, '..', 'media');

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
