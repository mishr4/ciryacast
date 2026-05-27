const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const router = express.Router();
const MEDIA_DIR = path.join(__dirname, '..', 'media');

// ── Multer config for file uploads ──
const storage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.ogg', '.flac', '.wav', '.m4a', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
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

router.post('/stations/:id/media', upload.array('files', 20), async (req, res) => {
  const db = req.app.get('db');
  const stationId = req.params.id;

  // Verify station exists
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const results = [];

  for (const file of req.files) {
    const id = uuid();
    let title = path.parse(file.originalname).name;
    let artist = 'Unknown';
    let album = '';
    let duration = 0;

    // Try to parse metadata
    try {
      const mm = await import('music-metadata');
      const metadata = await mm.parseFile(file.path);
      if (metadata.common.title) title = metadata.common.title;
      if (metadata.common.artist) artist = metadata.common.artist;
      if (metadata.common.album) album = metadata.common.album;
      if (metadata.format.duration) duration = metadata.format.duration;
    } catch {
      // Metadata parsing failed — that's fine, use filename
    }

    db.prepare(`
      INSERT INTO media (id, station_id, filename, original_name, title, artist, album, duration, size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, stationId, file.filename, file.originalname, title, artist, album, duration, file.size, file.mimetype);

    // Auto-add to default playlist
    const defaultPlaylist = db.prepare(
      'SELECT id FROM playlists WHERE station_id = ? AND is_default = 1'
    ).get(stationId);

    if (defaultPlaylist) {
      const maxOrder = db.prepare(
        'SELECT MAX(sort_order) as m FROM playlist_items WHERE playlist_id = ?'
      ).get(defaultPlaylist.id);

      db.prepare(`
        INSERT INTO playlist_items (id, playlist_id, media_id, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(uuid(), defaultPlaylist.id, id, (maxOrder?.m || 0) + 1);
    }

    results.push({ id, title, artist, album, duration, filename: file.filename, size: file.size });
  }

  req.app.get('broadcast')('media_uploaded', { stationId, count: results.length });
  res.status(201).json(results);
});

router.delete('/media/:id', (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  // Delete file
  const fp = path.join(MEDIA_DIR, media.filename);
  try { fs.unlinkSync(fp); } catch {}

  // Delete from DB (cascade will remove playlist_items)
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

  // Add item count
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

module.exports = router;
