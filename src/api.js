const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const router = express.Router();

// ── Access control: banned emails + IP capture ──
// Emails in the BANNED_EMAILS env var are always banned (survives DB resets);
// the banned_emails table holds bans added live from the dashboard.
const ENV_BANNED = new Set(
  (process.env.BANNED_EMAILS || '').split(',').map(s => s.toLowerCase().trim()).filter(Boolean)
);

function normEmail(e) { return (e || '').toLowerCase().trim(); }

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || req.ip || '';
}

function isEmailBanned(db, email) {
  const e = normEmail(email);
  if (!e) return false;
  if (ENV_BANNED.has(e)) return true;
  try { return !!db.prepare('SELECT 1 FROM banned_emails WHERE email = ?').get(e); }
  catch { return false; }
}

const BAN_MESSAGE = 'You have been banned from Cirya Utility and services.';

// ── Track metadata cleanup ──
// YouTube-sourced files carry junk tags: artist = a channel name like
// "Drake - Official", title = "Drake - One Dance (...) [OFFICIAL AUDIO]".
// This normalizes both into a clean "Drake" / "One Dance (...)".
function cleanTrackMeta(rawTitle, rawArtist) {
  let title = String(rawTitle || '').trim();
  let artist = String(rawArtist || '').trim();

  // Strip junk ()/[] tag groups: anything containing "official" (Official
  // Video / Official Lyric Video / Official Performance / OFFICIAL AUDIO…)
  // or a pure-junk word — while KEEPING legit groups like (feat. …),
  // (Acoustic), (Remix), (Live).
  title = title.replace(/\s*[([][^)\]]*[)\]]/g, (g) => {
    const inner = g.replace(/[()[\]]/g, '').trim().toLowerCase();
    if (/\bofficial\b/.test(inner)) return '';
    if (/^(audio|lyrics?|hd|hq|4k|mv|m\/v|visuali[sz]er|music\s*video|lyrics?\s*video|explicit|clean|audio\s*only|with\s*lyrics|remaster(ed)?(\s*\d{4})?)$/.test(inner)) return '';
    return g;
  });
  // Trailing "| channel" or stray "- Official Video" tails
  title = title.replace(/\s*[|｜]\s*[^|]*$/,'').trim();
  title = title.replace(/\s*[-–]\s*official\s*(music\s*)?(video|audio|performance|lyric[s]?\s*video)?\s*$/i, '').trim();

  // Channel-name artifacts on the artist
  artist = artist
    .replace(/\s*[-–]\s*(official|topic)\s*$/i, '')
    .replace(/vevo$/i, '')          // glued "ArtistVEVO"
    .replace(/\bvevo\b/gi, '')
    .replace(/\s*-\s*official$/i, '')
    .replace(/\bofficial\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const isUnknown = !artist || /^unknown$/i.test(artist);
  if (title.includes(' - ')) {
    const idx = title.indexOf(' - ');
    const head = title.slice(0, idx).trim();
    const tail = title.slice(idx + 3).trim();
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (isUnknown && tail) {
      // "Artist - Title" with no real artist → split it
      artist = head; title = tail;
    } else if (!isUnknown && tail) {
      // De-dupe an artist prefix repeated in the title
      const a = norm(artist), h = norm(head);
      if (a && h && (a.startsWith(h) || h.startsWith(a))) title = tail;
    }
  }

  title = title.replace(/\s{2,}/g, ' ').replace(/^[-–|\s]+|[-–|\s]+$/g, '').trim();
  artist = artist.replace(/\s{2,}/g, ' ').replace(/^[-–|\s]+|[-–|\s]+$/g, '').trim();

  return { title: title || String(rawTitle || '').trim() || 'Unknown', artist: artist || 'Unknown' };
}

// ── Audio normalization (EBU R128 loudnorm — broadcast standard) ──
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const os = require('os');

/**
 * Normalize an MP3 file to broadcast loudness (-14 LUFS, -1 dBTP).
 * Uses ffmpeg's loudnorm filter (two-pass for accuracy).
 * Overwrites the file in place. Skips if ffmpeg unavailable.
 */
async function normalizeAudio(filePath) {
  try {
    // Pass 1: measure loudness
    const { stderr: info } = await execFileAsync('ffmpeg', [
      '-i', filePath, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f', 'null', '-'
    ], { timeout: 60000 });

    // Parse measured values from ffmpeg output
    const jsonMatch = info.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
    if (!jsonMatch) { console.log('  ⚠ Loudnorm: could not parse pass 1'); return; }
    const m = JSON.parse(jsonMatch[0]);

    // Skip if already close to target (-14 LUFS ± 1)
    const inputLufs = parseFloat(m.input_i);
    if (Math.abs(inputLufs - (-14)) < 1) {
      console.log(`  ✓ Already normalized (${inputLufs.toFixed(1)} LUFS)`);
      return;
    }

    // Pass 2: apply correction
    const tmpOut = filePath + '.norm.mp3';
    await execFileAsync('ffmpeg', [
      '-i', filePath, '-af',
      `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
      '-ar', '44100', '-ab', '128k', '-y', tmpOut
    ], { timeout: 120000 });

    // Replace original
    fs.unlinkSync(filePath);
    fs.renameSync(tmpOut, filePath);

    const newSize = fs.statSync(filePath).size;
    console.log(`  🔊 Normalized: ${inputLufs.toFixed(1)} → -14.0 LUFS (${(newSize/1024/1024).toFixed(1)}MB)`);
  } catch (e) {
    // ffmpeg not available or error — skip normalization silently
    console.log(`  ⚠ Normalization skipped: ${e.message?.split('\n')[0] || e.message}`);
    // Clean up temp file if exists
    try { fs.unlinkSync(filePath + '.norm.mp3'); } catch {}
  }
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

// Multer for station logos (images only)
const imageStorage = multer.memoryStorage();
const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only image files allowed (JPG, PNG, WebP, GIF)'));
  },
});

// ════════════════════════════════════
// STATIONS
// ════════════════════════════════════

router.get('/stations', (req, res) => {
  const db = req.app.get('db');
  // Show only non-hidden stations in public list
  const stations = db.prepare('SELECT * FROM stations WHERE is_hidden = 0 ORDER BY created_at').all();
  const streamEngine = req.app.get('streamEngine');

  const result = stations.map(s => {
    const owner = s.owner_id ? db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(s.owner_id) : null;
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM station_members WHERE station_id = ?').get(s.id).c;
    return {
      ...s,
      owner: owner ? { id: owner.id, email: owner.email, display_name: owner.display_name } : null,
      member_count: memberCount,
      listeners: streamEngine.getListenerCount(s.id),
      now_playing: streamEngine.getNowPlaying(s.id),
      autodj_running: req.app.get('autoDJ').isRunning(s.id),
      live: streamEngine.isLive(s.id),
    };
  });
  res.json(result);
});

// Get stations for a specific user (authenticated endpoint)
// Pass ?user_id=<id> to get user's stations, or pass user_id in body for auth
router.get('/users/:userId/stations', (req, res) => {
  const db = req.app.get('db');
  const userId = req.params.userId;

  // Get stations user owns or is a member of
  const stations = db.prepare(`
    SELECT DISTINCT s.* FROM stations s
    LEFT JOIN station_members sm ON sm.station_id = s.id
    WHERE s.owner_id = ? OR sm.user_id = ?
    ORDER BY s.created_at DESC
  `).all(userId, userId);

  const streamEngine = req.app.get('streamEngine');
  const result = stations.map(s => {
    const owner = s.owner_id ? db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get(s.owner_id) : null;
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM station_members WHERE station_id = ?').get(s.id).c;
    const userRole = db.prepare('SELECT role FROM station_members WHERE station_id = ? AND user_id = ?').get(s.id, userId);
    const isOwner = s.owner_id === userId;

    return {
      ...s,
      owner: owner ? { id: owner.id, email: owner.email, display_name: owner.display_name } : null,
      member_count: memberCount,
      my_role: userRole?.role || (isOwner ? 'owner' : null),
      listeners: streamEngine.getListenerCount(s.id),
      now_playing: streamEngine.getNowPlaying(s.id),
      autodj_running: req.app.get('autoDJ').isRunning(s.id),
      live: streamEngine.isLive(s.id),
    };
  });
  res.json(result);
});

router.post('/stations', (req, res) => {
  const db = req.app.get('db');
  const { name, description, genre, bitrate, owner_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuid();
  const slug = db.makeUniqueSlug(name);
  db.prepare(`
    INSERT INTO stations (id, name, slug, description, genre, bitrate, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, slug, description || '', genre || 'Various', bitrate || 128, owner_id || '');

  // Create default playlist
  const plId = uuid();
  db.prepare(`
    INSERT INTO playlists (id, station_id, name, is_default, weight)
    VALUES (?, ?, ?, 1, 1)
  `).run(plId, id, 'General Rotation');

  // If owner_id provided, add them to station_members with 'owner' role
  if (owner_id) {
    const memberId = uuid();
    db.prepare(`
      INSERT INTO station_members (id, station_id, user_id, role)
      VALUES (?, ?, ?, 'owner')
    `).run(memberId, id, owner_id);
  }

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
  req.app.get('broadcast')('station_created', station);
  res.status(201).json(station);
});

router.put('/stations/:id', (req, res) => {
  const db = req.app.get('db');
  const { name, description, genre, bitrate, logo_url, website_url, location, owner_id } = req.body;

  db.prepare(`
    UPDATE stations SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      genre = COALESCE(?, genre),
      bitrate = COALESCE(?, bitrate),
      logo_url = COALESCE(?, logo_url),
      website_url = COALESCE(?, website_url),
      location = COALESCE(?, location),
      owner_id = COALESCE(?, owner_id),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description, genre, bitrate, logo_url || null, website_url || null, location || null, owner_id || null, req.params.id);

  // If owner changed, update station_members table
  if (owner_id) {
    // Remove old owner from station_members if any
    db.prepare('DELETE FROM station_members WHERE station_id = ? AND role = ?').run(req.params.id, 'owner');
    // Add new owner to station_members
    const { v4: uuid } = require('uuid');
    const memberId = uuid();
    db.prepare(`
      INSERT INTO station_members (id, station_id, user_id, role)
      VALUES (?, ?, ?, 'owner')
    `).run(memberId, req.params.id, owner_id);
  }

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

// Upload station logo (image file)
router.post('/stations/:id/logo', uploadImage.single('logo'), async (req, res) => {
  const db = req.app.get('db');

  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  try {
    // Save image file with UUID filename
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `logo-${req.params.id}${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);

    // Write image to disk
    fs.writeFileSync(filepath, req.file.buffer);

    // Update station logo_url to point to the uploaded file
    const logo_url = `/media/${filename}`;
    db.prepare('UPDATE stations SET logo_url = ? WHERE id = ?').run(logo_url, req.params.id);

    res.json({ ok: true, logo_url });
  } catch (err) {
    console.error('  ⚠ Logo upload error:', err.message);
    res.status(500).json({ error: 'Failed to save logo' });
  }
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
      // Scrub YouTube-style junk from tags / filename
      ({ title, artist } = cleanTrackMeta(title, artist));

      try {
        // Normalize loudness to broadcast standard (-14 LUFS)
        await normalizeAudio(file.path);
        const normalizedSize = fs.statSync(file.path).size;

        insertMedia.run(id, stationId, file.filename, file.originalname, title, artist, album, duration, normalizedSize, file.mimetype);

        // Auto-add to default playlist
        if (insertPlaylistItem) {
          maxOrder++;
          insertPlaylistItem.run(uuid(), defaultPlaylist.id, id, maxOrder);
        }

        results.push({ id, title, artist, album, duration, filename: file.filename, size: normalizedSize });
        console.log(`  ✓ Uploaded: ${title} — ${artist} (${(normalizedSize / 1024 / 1024).toFixed(1)}MB)`);
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
  const { name, weight, type, schedule_rule, play_every_n, play_mode } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO playlists (id, station_id, name, weight, type, schedule_rule, play_every_n, play_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, name, weight || 1,
    type || 'music', schedule_rule || '', play_every_n || 3, play_mode || 'shuffle');

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  res.status(201).json(playlist);
});

router.put('/playlists/:id', (req, res) => {
  const db = req.app.get('db');
  const { name, weight, type, schedule_rule, play_every_n, play_mode, is_enabled } = req.body;

  db.prepare(`
    UPDATE playlists SET
      name = COALESCE(?, name),
      weight = COALESCE(?, weight),
      type = COALESCE(?, type),
      schedule_rule = COALESCE(?, schedule_rule),
      play_every_n = COALESCE(?, play_every_n),
      play_mode = COALESCE(?, play_mode),
      is_enabled = COALESCE(?, is_enabled)
    WHERE id = ?
  `).run(name, weight, type, schedule_rule, play_every_n, play_mode,
    is_enabled !== undefined ? (is_enabled ? 1 : 0) : null, req.params.id);

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  res.json(playlist);
});

router.delete('/playlists/:id', (req, res) => {
  const db = req.app.get('db');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(req.params.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Update media folder/genre
router.patch('/media/:id/meta', (req, res) => {
  const db = req.app.get('db');
  const { folder, genre, title, artist, album } = req.body;

  db.prepare(`
    UPDATE media SET
      folder = COALESCE(?, folder),
      genre = COALESCE(?, genre),
      title = COALESCE(?, title),
      artist = COALESCE(?, artist),
      album = COALESCE(?, album)
    WHERE id = ?
  `).run(folder, genre, title, artist, album, req.params.id);

  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found' });
  res.json(media);
});

// List unique folders for a station
router.get('/stations/:id/folders', (req, res) => {
  const db = req.app.get('db');
  const folders = db.prepare(
    "SELECT DISTINCT folder FROM media WHERE station_id = ? AND folder != '' ORDER BY folder"
  ).all(req.params.id).map(r => r.folder);
  res.json(folders);
});

// Batch move media to a folder
router.post('/stations/:id/media/move', (req, res) => {
  const db = req.app.get('db');
  const { media_ids, folder } = req.body;
  if (!Array.isArray(media_ids) || folder === undefined) {
    return res.status(400).json({ error: 'media_ids array and folder required' });
  }
  const stmt = db.prepare('UPDATE media SET folder = ? WHERE id = ? AND station_id = ?');
  let updated = 0;
  for (const id of media_ids) {
    const r = stmt.run(folder, id, req.params.id);
    updated += r.changes;
  }
  res.json({ ok: true, updated });
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

// Metadata-only song search (Deezer public API) — used by the player's
// "Request a Song" box. Returns search results, never downloads audio.
router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=12`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    const tracks = (data.data || []).map(t => ({
      title: t.title,
      artist: t.artist?.name || '',
      album_name: t.album?.title || '',
      album_art: t.album?.cover_medium || t.album?.cover_big || '',
      deezer_id: t.id ? String(t.id) : '',
      duration_sec: t.duration || 0,
    }));
    res.json(tracks);
  } catch (e) {
    console.log('  ⚠ Search error:', e.message);
    res.json([]);
  }
});

// ════════════════════════════════════
// SONG REQUESTS
// ════════════════════════════════════

// Submit a song request (public — from player page)
// Auto-downloads the song from TypicalMedia if not in library
// Resolve a station by UUID or slug → id
function resolveStationId(db, key) {
  const row = db.prepare('SELECT id FROM stations WHERE id = ? OR slug = ?').get(key, key);
  return row ? row.id : null;
}

// Public, lightweight song library for the player's "Request a Song" browser.
// Only tracks that have a file (i.e. can actually be played), with art.
router.get('/stations/:id/library', (req, res) => {
  const db = req.app.get('db');
  const stationId = resolveStationId(db, req.params.id);
  if (!stationId) return res.json([]);
  const q = (req.query.q || '').toLowerCase().trim();
  let rows = db.prepare(
    "SELECT id, title, artist, album, artwork_url FROM media WHERE station_id = ? AND title != '' ORDER BY (artwork_url = '' ) ASC, artist COLLATE NOCASE, title COLLATE NOCASE"
  ).all(stationId);
  if (q) {
    rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.artist || '').toLowerCase().includes(q) ||
      (r.album || '').toLowerCase().includes(q)
    );
  }
  res.json(rows);
});

const MAX_REQUESTS_PER_LISTENER = 2;

router.post('/stations/:id/requests', async (req, res) => {
  const db = req.app.get('db');
  const stationId = resolveStationId(db, req.params.id);
  if (!stationId) return res.status(404).json({ error: 'Station not found' });
  let { title, artist, album, artwork_url, tm_track_id, requested_by, media_id } = req.body;

  const ip = clientIp(req);

  // If a library track was picked, use it directly (this is the normal path
  // now that listeners browse the available library)
  let media = null;
  if (media_id) {
    media = db.prepare('SELECT * FROM media WHERE id = ? AND station_id = ?').get(media_id, stationId);
    if (!media) return res.status(404).json({ error: 'That track is not available' });
    title = media.title; artist = media.artist; album = media.album;
    artwork_url = media.artwork_url; tm_track_id = media.tm_track_id;
  } else {
    if (!title || !artist) return res.status(400).json({ error: 'Pick a song to request' });
    // Fall back to an exact library match
    const m = db.prepare(
      "SELECT * FROM media WHERE station_id = ? AND LOWER(title) = ? AND LOWER(artist) = ? LIMIT 1"
    ).get(stationId, title.toLowerCase(), artist.toLowerCase());
    if (m) { media = m; media_id = m.id; }
  }
  const resolvedMediaId = media ? media.id : null;

  // Max N pending requests per listener (by IP)
  const pendingCount = db.prepare(
    "SELECT COUNT(*) AS c FROM song_requests WHERE station_id = ? AND ip = ? AND status = 'pending'"
  ).get(stationId, ip).c;
  if (pendingCount >= MAX_REQUESTS_PER_LISTENER) {
    return res.status(429).json({ error: `You can have ${MAX_REQUESTS_PER_LISTENER} songs in the queue at a time` });
  }

  // Light anti-spam: no duplicate of the same pending track
  const dupe = db.prepare(
    "SELECT id FROM song_requests WHERE station_id = ? AND ip = ? AND status = 'pending' AND LOWER(title) = ? AND LOWER(artist) = ?"
  ).get(stationId, ip, String(title).toLowerCase(), String(artist).toLowerCase());
  if (dupe) return res.status(409).json({ error: 'That song is already in your queue' });

  const result = db.prepare(`
    INSERT INTO song_requests (station_id, title, artist, album, artwork_url, tm_track_id, media_id, requested_by, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(stationId, title, artist, album || '', artwork_url || '', tm_track_id || '', resolvedMediaId, requested_by || 'Listener', ip);

  req.app.get('broadcast')('song_request', { stationId, title, artist, media_id: resolvedMediaId, matched: !!resolvedMediaId });

  res.status(201).json({
    id: result.lastInsertRowid,
    matched: !!resolvedMediaId,
    remaining: MAX_REQUESTS_PER_LISTENER - (pendingCount + 1),
    message: 'Added to the queue!',
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
// METADATA ENRICHMENT (Deezer — metadata only, no downloads)
// ════════════════════════════════════
const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const CHANNEL_RE = /records|vevo|topic|\bmusic\b|sounds|official|channel|\bmix\b|\bhd\b|\btv\b|\d{2,}|life$/i;
const GENERIC_TITLE_RE = /^(track\s*\d+|unknown|untitled|audio|new recording.*)$/i;

// Clean one track's metadata + (when needed) fix it from Deezer. Shared by
// the single-track "Fetch from Deezer" button and the bulk station enrich.
// Returns { changed, arted } and updates the row in place.
async function enrichTrack(db, m) {
  let changed = false, arted = false;

  // 1) Local cleanup (junk tags, channel suffixes, dupe artist prefix)
  const c = cleanTrackMeta(m.title, m.artist);
  let curTitle = c.title, curArtist = c.artist;
  if (c.title !== m.title || c.artist !== m.artist) {
    db.prepare('UPDATE media SET title = ?, artist = ? WHERE id = ?').run(c.title, c.artist, m.id);
    changed = true;
  }

  // 2) Hit Deezer when art is missing, the artist looks like a channel, or
  //    the title is generic
  const artistJunky = curArtist === 'Unknown' || CHANNEL_RE.test(curArtist);
  const titleGeneric = !curTitle || GENERIC_TITLE_RE.test(curTitle);
  if (m.artwork_url && !artistJunky && !titleGeneric) return { changed, arted };

  // Build the best query: drop a junky artist; if the title is generic, try
  // the original filename ("Track 2" → "BITE NOW")
  let bestTitle = curTitle;
  if (titleGeneric) {
    const fromName = cleanTrackMeta(path.parse(m.original_name || '').name, '').title;
    if (fromName && !GENERIC_TITLE_RE.test(fromName)) {
      bestTitle = fromName;
      if (bestTitle !== curTitle) { curTitle = bestTitle; changed = true; }
    }
  }
  const query = `${artistJunky ? '' : curArtist + ' '}${bestTitle}`.trim();
  if (!query) return { changed, arted };

  const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const t = (await resp.json()).data?.[0];
  if (!t || !t.artist?.name) return { changed, arted };

  const art = t.album?.cover_big || t.album?.cover_medium || '';
  const dzArtist = norm(t.artist.name), dzTitle = norm(t.title), myTitle = norm(curTitle);
  const artistAppears = dzArtist && norm(`${curArtist} ${curTitle} ${m.original_name || ''}`).includes(dzArtist);
  // Title must genuinely match — guards against Deezer returning a different
  // song (e.g. "BITE NOW" → "BURNING UP")
  const titleMatches = dzTitle && myTitle && (dzTitle.includes(myTitle) || myTitle.includes(dzTitle));
  const confident = artistAppears && titleMatches;

  const finalArtist = confident ? t.artist.name : (artistJunky && artistAppears ? t.artist.name : curArtist);
  const finalTitle = confident ? t.title : curTitle;
  const useArt = confident ? art : '';   // never attach a wrong cover
  if (finalArtist !== curArtist || finalTitle !== curTitle) changed = true;

  db.prepare(`
    UPDATE media SET
      title = ?, artist = ?,
      artwork_url = CASE WHEN ? != '' THEN ? ELSE artwork_url END,
      album = CASE WHEN (? != '') AND (album = '' OR album IS NULL) THEN ? ELSE album END,
      tm_track_id = CASE WHEN (? != '') AND (tm_track_id = '' OR tm_track_id IS NULL) THEN ? ELSE tm_track_id END
    WHERE id = ?
  `).run(finalTitle, finalArtist, useArt, useArt, useArt, t.album?.title || '', useArt, t.id ? String(t.id) : '', m.id);
  arted = !!useArt;
  return { changed, arted };
}

router.post('/media/:id/enrich', async (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found' });
  try {
    const { arted } = await enrichTrack(db, media);
    const updated = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
    res.json({ enriched: arted, media: updated });
  } catch (e) {
    console.log('  ⚠ Enrich error:', e.message);
    res.status(500).json({ error: 'Enrichment failed: ' + e.message });
  }
});

// Bulk enrich all media for a station
router.post('/stations/:id/enrich', async (req, res) => {
  const db = req.app.get('db');
  const media = db.prepare('SELECT * FROM media WHERE station_id = ?').all(req.params.id);

  let cleaned = 0, enriched = 0, failed = 0;
  for (const m of media) {
    try {
      const { changed, arted } = await enrichTrack(db, m);
      if (changed) cleaned++;
      if (arted) enriched++;
      else if (!m.artwork_url) failed++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 300)); // Deezer rate limit
  }

  res.json({ total: media.length, cleaned, enriched, failed });
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

// Validate an active session — called by the dashboard on load and whenever
// a force_reload is broadcast. Logs the caller's IP against their email so
// admins can retrieve an abuser's IP, and reports ban status.
router.post('/auth/validate', (req, res) => {
  const db = req.app.get('db');
  const email = normEmail(req.body.email);
  const ip = clientIp(req);
  if (email) {
    try {
      db.prepare('INSERT INTO access_log (email, ip, user_agent) VALUES (?, ?, ?)')
        .run(email, ip, (req.headers['user-agent'] || '').slice(0, 300));
    } catch {}
  }
  const banned = isEmailBanned(db, email);
  res.json({ banned, message: banned ? BAN_MESSAGE : '', your_ip: ip });
});

// Login with email + password
router.post('/auth/login', (req, res) => {
  const db = req.app.get('db');
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const cleanEmail = normEmail(email);

  // Log the attempt's IP and block banned emails before checking credentials
  try {
    db.prepare('INSERT INTO access_log (email, ip, user_agent) VALUES (?, ?, ?)')
      .run(cleanEmail, clientIp(req), (req.headers['user-agent'] || '').slice(0, 300));
  } catch {}
  if (isEmailBanned(db, cleanEmail)) {
    return res.status(403).json({ error: BAN_MESSAGE, banned: true });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(cleanEmail);
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

// ════════════════════════════════════
// BANS & IP CAPTURE (abuse mitigation)
// ════════════════════════════════════

// Ban an email — kicks them out of the dashboard and forces every connected
// session to reload (banned ones land on the ban screen). Returns any IPs
// we've already logged for that email so they can be IP-banned elsewhere.
router.post('/admin/ban', (req, res) => {
  const db = req.app.get('db');
  const email = normEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'email required' });

  db.prepare('INSERT OR REPLACE INTO banned_emails (email, reason, banned_by) VALUES (?, ?, ?)')
    .run(email, req.body.reason || '', req.body.by || 'admin');

  // Kick any live DJ matching this email's display name is out of scope here;
  // the force_reload + ban gate handles dashboard sessions.
  try { req.app.get('broadcast')('force_reload', { reason: 'ban' }); } catch {}

  const ips = db.prepare(
    "SELECT DISTINCT ip FROM access_log WHERE email = ? AND ip != '' ORDER BY at DESC LIMIT 25"
  ).all(email).map(r => r.ip);

  console.log(`  ⛔ BANNED ${email} — known IPs: ${ips.join(', ') || 'none yet'}`);
  res.json({ ok: true, email, message: BAN_MESSAGE, known_ips: ips });
});

// Lift a ban (env-var bans cannot be lifted here — remove them in Railway)
router.post('/admin/unban', (req, res) => {
  const db = req.app.get('db');
  const email = normEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'email required' });
  db.prepare('DELETE FROM banned_emails WHERE email = ?').run(email);
  const stillEnv = ENV_BANNED.has(email);
  res.json({ ok: true, email, env_locked: stillEnv });
});

// List active bans
router.get('/admin/banned', (req, res) => {
  const db = req.app.get('db');
  const rows = db.prepare('SELECT email, reason, banned_by, banned_at FROM banned_emails ORDER BY banned_at DESC').all();
  const envBans = [...ENV_BANNED].map(email => ({ email, reason: 'env BANNED_EMAILS', banned_by: 'railway', banned_at: '' }));
  res.json([...envBans, ...rows]);
});

// IP log for an email — for IP-banning an abuser in Cirya / Cloudflare / etc.
// Excludes server-side admin tooling (curl/node) so only real browser visits
// surface — those are the abuser's actual IPs.
router.get('/admin/access-log', (req, res) => {
  const db = req.app.get('db');
  const email = normEmail(req.query.email);
  const includeTools = req.query.all === '1';
  const rows = email
    ? db.prepare('SELECT email, ip, user_agent, at FROM access_log WHERE email = ? ORDER BY at DESC LIMIT 100').all(email)
    : db.prepare('SELECT email, ip, user_agent, at FROM access_log ORDER BY at DESC LIMIT 100').all();
  const isTool = (ua) => /curl|wget|node|postman|python-requests|httpie/i.test(ua || '');
  const visible = includeTools ? rows : rows.filter(r => !isTool(r.user_agent));
  const uniqueIps = [...new Set(visible.map(r => r.ip).filter(Boolean))];
  res.json({ email: email || null, unique_ips: uniqueIps, entries: visible });
});

// Clear logged IPs for an email (e.g. to discard admin test noise before
// capturing the real abuser IP)
router.delete('/admin/access-log', (req, res) => {
  const db = req.app.get('db');
  const email = normEmail(req.query.email);
  if (!email) return res.status(400).json({ error: 'email required' });
  const info = db.prepare('DELETE FROM access_log WHERE email = ?').run(email);
  res.json({ ok: true, email, deleted: info.changes });
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
        ({ title: actualTitle, artist: actualArtist } = cleanTrackMeta(actualTitle, actualArtist));

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

// ════════════════════════════════════
// VOICE TRACKS (remote presenter recordings)
// ════════════════════════════════════

const VT_DIR = VOLUME ? path.join(VOLUME, 'voicetracks') : path.join(__dirname, '..', 'voicetracks');

// Upload voice tracks for a station
const vtStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(VT_DIR, req.params.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Keep original name so presenter + title are preserved
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '');
    cb(null, safe || `${uuid()}.mp3`);
  },
});
const vtUpload = multer({ storage: vtStorage, limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/stations/:id/voicetracks', vtUpload.array('files', 50), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files' });
  console.log(`  🎙 ${req.files.length} voice track(s) uploaded for station ${req.params.id}`);
  res.json({ ok: true, count: req.files.length, files: req.files.map(f => f.filename) });
});

// Record voice track from browser. Accepts ANY audio the browser's
// MediaRecorder produces (webm/opus, mp4, ogg, or raw mp3) and converts
// to MP3 server-side, then loudness-normalizes to match the music.
router.post('/stations/:id/voicetracks/record', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'No audio data' });
  }

  const { title, presenter } = req.query;
  if (!title) return res.status(400).json({ error: 'title query param required' });

  const stationDir = path.join(VT_DIR, req.params.id);
  if (!fs.existsSync(stationDir)) fs.mkdirSync(stationDir, { recursive: true });

  // Keep "Presenter - Title.mp3" naming but strip path/separator characters
  const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').replace(/ - /g, '—').trim();
  const presenterName = clean(presenter || 'Presenter') || 'Presenter';
  const filename = `${presenterName} - ${clean(title)}.mp3`;
  const filePath = path.join(stationDir, filename);

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const isMp3 = contentType.includes('mpeg') || contentType.includes('mp3');

  try {
    if (isMp3) {
      fs.writeFileSync(filePath, req.body);
    } else {
      // Convert browser recording (webm/ogg/mp4) to MP3
      const tmpIn = path.join(os.tmpdir(), `vt-${Date.now()}-${Math.random().toString(36).slice(2)}.in`);
      fs.writeFileSync(tmpIn, req.body);
      try {
        await execFileAsync('ffmpeg', [
          '-i', tmpIn, '-vn',
          '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100',
          '-y', filePath,
        ], { timeout: 120000 });
      } finally {
        try { fs.unlinkSync(tmpIn); } catch {}
      }
    }

    // Match broadcast loudness so VTs sit at the same level as songs
    try { await normalizeAudio(filePath); } catch {}

    const size = fs.statSync(filePath).size;
    console.log(`  🎙 Voice track recorded: ${filename} (${(size / 1024).toFixed(0)} KB, from ${contentType || 'unknown'})`);
    res.json({ ok: true, filename, size });
  } catch (e) {
    console.log(`  ⚠ VT record failed: ${e.message}`);
    try { fs.unlinkSync(filePath); } catch {}
    res.status(500).json({ error: 'Conversion failed: ' + e.message });
  }
});

// List voice tracks for a station
router.get('/stations/:id/voicetracks', (req, res) => {
  const dir = path.join(VT_DIR, req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3')).map(f => {
      const stats = fs.statSync(path.join(dir, f));
      const name = path.parse(f).name;
      const parts = name.split(' - ');
      return {
        filename: f,
        presenter: parts.length > 1 ? parts[0].trim() : 'Presenter',
        title: parts.length > 1 ? parts[1].trim() : name,
        size: stats.size,
        uploaded_at: stats.birthtime.toISOString(),
      };
    });
    res.json(files);
  } catch { res.json([]); }
});

// Delete a voice track
router.delete('/stations/:id/voicetracks/:filename', (req, res) => {
  const filePath = path.join(VT_DIR, req.params.id, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ════════════════════════════════════
// SCHEDULED SHOWS
// ════════════════════════════════════

router.get('/stations/:id/shows', (req, res) => {
  const db = req.app.get('db');
  const shows = db.prepare(`
    SELECT ss.*, p.name as playlist_name
    FROM scheduled_shows ss
    LEFT JOIN playlists p ON p.id = ss.playlist_id
    WHERE ss.station_id = ?
    ORDER BY ss.start_time, ss.days_of_week
  `).all(req.params.id);
  res.json(shows);
});

router.post('/stations/:id/shows', (req, res) => {
  const db = req.app.get('db');
  const { title, description, playlist_id, schedule_type, start_time, days_of_week, duration_minutes, target_date, created_by } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const showId = uuid();
  db.prepare(`
    INSERT INTO scheduled_shows
    (id, station_id, title, description, playlist_id, schedule_type, start_time, days_of_week, duration_minutes, target_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(showId, req.params.id, title, description || '', playlist_id || null,
    schedule_type || 'weekly', start_time || '09:00', days_of_week || '1-5',
    duration_minutes || 60, target_date || '', created_by || '');

  const show = db.prepare('SELECT * FROM scheduled_shows WHERE id = ?').get(showId);
  res.status(201).json(show);
});

router.put('/shows/:id', (req, res) => {
  const db = req.app.get('db');
  const { title, description, playlist_id, schedule_type, start_time, days_of_week, duration_minutes, target_date, is_enabled } = req.body;

  db.prepare(`
    UPDATE scheduled_shows SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      playlist_id = COALESCE(?, playlist_id),
      schedule_type = COALESCE(?, schedule_type),
      start_time = COALESCE(?, start_time),
      days_of_week = COALESCE(?, days_of_week),
      duration_minutes = COALESCE(?, duration_minutes),
      target_date = COALESCE(?, target_date),
      is_enabled = COALESCE(?, is_enabled),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(title, description, playlist_id, schedule_type, start_time, days_of_week,
    duration_minutes, target_date, is_enabled !== undefined ? (is_enabled ? 1 : 0) : null, req.params.id);

  const show = db.prepare('SELECT * FROM scheduled_shows WHERE id = ?').get(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  res.json(show);
});

router.delete('/shows/:id', (req, res) => {
  const db = req.app.get('db');
  db.prepare('DELETE FROM scheduled_shows WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════
// USERS & STATION MEMBERS (ROLES)
// ════════════════════════════════════

// Get all users (super admin only)
router.get('/admin/users', (req, res) => {
  const db = req.app.get('db');
  // Check if current user is super admin (would need auth middleware)
  const users = db.prepare(`
    SELECT id, email, display_name, is_super_admin, is_active, created_at, last_login
    FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

// Create a user
router.post('/admin/users', (req, res) => {
  const db = req.app.get('db');
  const { email, display_name, is_super_admin } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const id = uuid();
  try {
    db.prepare(`
      INSERT INTO users (id, email, display_name, is_super_admin, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, email, display_name || email.split('@')[0], is_super_admin ? 1 : 0, '');

    const user = db.prepare('SELECT id, email, display_name, is_super_admin FROM users WHERE id = ?').get(id);
    res.status(201).json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get station members (with roles)
router.get('/stations/:id/members', (req, res) => {
  const db = req.app.get('db');
  const members = db.prepare(`
    SELECT sm.id, sm.user_id, sm.role, sm.created_at,
           u.email, u.display_name, u.is_super_admin
    FROM station_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.station_id = ?
    ORDER BY sm.role DESC, u.email
  `).all(req.params.id);
  res.json(members);
});

// Add a user to a station with a role
router.post('/stations/:id/members', (req, res) => {
  const db = req.app.get('db');
  const { user_id, role } = req.body;
  if (!user_id || !['owner', 'admin', 'dj'].includes(role)) {
    return res.status(400).json({ error: 'user_id and role (owner/admin/dj) required' });
  }

  const id = uuid();
  try {
    db.prepare(`
      INSERT INTO station_members (id, station_id, user_id, role)
      VALUES (?, ?, ?, ?)
    `).run(id, req.params.id, user_id, role);

    const member = db.prepare(`
      SELECT sm.id, sm.user_id, sm.role, sm.created_at, u.email, u.display_name
      FROM station_members sm
      JOIN users u ON u.id = sm.user_id
      WHERE sm.id = ?
    `).get(id);
    res.status(201).json(member);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update a station member's role
router.patch('/stations/:stationId/members/:userId', (req, res) => {
  const db = req.app.get('db');
  const { role } = req.body;
  if (!role || !['owner', 'admin', 'dj'].includes(role)) {
    return res.status(400).json({ error: 'role (owner/admin/dj) required' });
  }

  db.prepare(`
    UPDATE station_members SET role = ? WHERE station_id = ? AND user_id = ?
  `).run(role, req.params.stationId, req.params.userId);

  const member = db.prepare(`
    SELECT sm.id, sm.user_id, sm.role, sm.created_at, u.email, u.display_name
    FROM station_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.station_id = ? AND sm.user_id = ?
  `).get(req.params.stationId, req.params.userId);

  if (!member) return res.status(404).json({ error: 'Member not found' });
  res.json(member);
});

// Remove a user from a station
router.delete('/stations/:stationId/members/:userId', (req, res) => {
  const db = req.app.get('db');
  db.prepare(`
    DELETE FROM station_members WHERE station_id = ? AND user_id = ?
  `).run(req.params.stationId, req.params.userId);

  res.json({ ok: true });
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
