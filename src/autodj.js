const fs = require('fs');
const path = require('path');

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const MEDIA_DIR = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, '..', 'media');

/**
 * AutoDJ — clock-based MP3 streamer.
 *
 * Instead of setInterval (which drifts), uses a setTimeout loop that
 * checks wall-clock time to decide how many bytes to send each tick.
 * This self-corrects for timing jitter and keeps the stream at exactly
 * the right bitrate.
 */
class AutoDJ {
  constructor(db, streamEngine, broadcast) {
    this.db = db;
    this.streamEngine = streamEngine;
    this.broadcast = broadcast;
    this.sessions = new Map();
  }

  /* ── Public API ───────────────────────────────────── */

  start(stationId) {
    if (this.sessions.has(stationId)) return;
    const session = {
      active: true,
      timer: null,
      queue: [],
      queueIndex: 0,
      // Current track streaming state
      buf: null,        // file buffer
      offset: 0,        // bytes sent so far
      startedAt: 0,     // hrtime when streaming began (ms)
      bytesPerMs: 0,    // target bytes per millisecond
      // Queue features
      priorityQueue: [],
      playNowId: null,
      // Voice tracking — insert presenter audio between songs
      lastPlayedMusic: false,  // true if last item was a music track (not VT)
    };
    this.sessions.set(stationId, session);
    this._buildQueue(stationId);
    this._next(stationId);
  }

  stop(stationId) {
    const s = this.sessions.get(stationId);
    if (!s) return;
    s.active = false;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    this.sessions.delete(stationId);
  }

  skip(stationId) {
    const s = this.sessions.get(stationId);
    if (!s) return;
    this._cancelTimer(s);
    this._next(stationId);
  }

  isRunning(id) { return this.sessions.has(id); }

  playNow(stationId, mediaId) {
    const s = this.sessions.get(stationId);
    if (!s) return false;
    s.playNowId = mediaId;
    this._cancelTimer(s);
    this._next(stationId);
    return true;
  }

  queueNext(stationId, mediaId) {
    const s = this.sessions.get(stationId);
    if (!s) return false;
    s.priorityQueue.push(mediaId);
    return true;
  }

  getQueue(stationId) {
    const s = this.sessions.get(stationId);
    if (!s) return [];
    return s.priorityQueue.map(id => {
      const m = this.db.prepare(
        'SELECT id, title, artist, album, duration, artwork_url FROM media WHERE id = ?'
      ).get(id);
      return m || { id, title: 'Unknown', artist: 'Unknown' };
    });
  }

  /* ── Internals ────────────────────────────────────── */

  _cancelTimer(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.buf = null;
    s.offset = 0;
  }

  /** Pick the next track and start streaming it */
  _next(stationId) {
    const s = this.sessions.get(stationId);
    if (!s || !s.active) return;
    this._cancelTimer(s);

    // ── Voice tracking: if last item was music, try to insert a VT before next song ──
    if (s.lastPlayedMusic) {
      const vt = this._pickVoiceTrack(stationId);
      if (vt) {
        s.lastPlayedMusic = false;
        this._streamFile(stationId, vt.filePath, {
          title: vt.title || 'Voice Break',
          artist: vt.presenter || 'Presenter',
          album: '', duration: 0, media_id: null,
          artwork_url: '', is_request: false, _isVT: true,
        });
        return;
      }
    }

    // Rebuild queue if needed
    if (!s.queue.length || s.queueIndex >= s.queue.length) {
      this._buildQueue(stationId);
    }
    if (!s.queue.length) {
      // No media — retry in 5s
      console.log(`  ⏸ ${stationId}: no media, retrying in 5s`);
      s.timer = setTimeout(() => this._next(stationId), 5000);
      return;
    }

    // ── Pick track: playNow > priorityQueue > requests > shuffle ──
    const track = this._pickTrack(stationId, s);
    if (!track) {
      s.timer = setTimeout(() => this._next(stationId), 2000);
      return;
    }

    // Mark that we're playing a music track (VT may follow)
    s.lastPlayedMusic = true;

    // Read + prepare file
    const filePath = path.join(MEDIA_DIR, track.filename);
    this._streamFile(stationId, filePath, {
      title: track.title || track.original_name,
      artist: track.artist || 'Unknown',
      album: track.album || '',
      duration: track.duration || 0,
      media_id: track.id,
      artwork_url: track.artwork_url || '',
      is_request: !!track._requestId,
    });

    this.db.prepare(
      'INSERT INTO play_history (station_id, media_id, title, artist, listeners) VALUES (?,?,?,?,?)'
    ).run(stationId, track.id, track.title || track.original_name,
          track.artist || 'Unknown', this.streamEngine.getListenerCount(stationId));

    this.broadcast('track_change', {
      stationId,
      track: { id: track.id, title: track.title || track.original_name,
               artist: track.artist || 'Unknown', album: track.album || '',
               duration: track.duration },
    });

    // Auto-enrich artwork in background
    if (!track.artwork_url && track.title && track.artist !== 'Unknown') {
      this._autoEnrich(track).catch(() => {});
    }
  }

  /** Stream a file to a station — shared by music tracks and voice tracks */
  _streamFile(stationId, filePath, meta) {
    const s = this.sessions.get(stationId);
    if (!s || !s.active) return;

    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠ Missing: ${meta.title}, skip`);
      setTimeout(() => this._next(stationId), 200);
      return;
    }

    let buf;
    try { buf = fs.readFileSync(filePath); } catch (e) {
      console.log(`  ⚠ Read error: ${e.message}`);
      setTimeout(() => this._next(stationId), 500);
      return;
    }
    if (buf.length < 1000) {
      setTimeout(() => this._next(stationId), 200);
      return;
    }

    buf = stripID3(buf);
    buf = alignFrame(buf);
    if (buf.length < 500) {
      setTimeout(() => this._next(stationId), 200);
      return;
    }

    const station = this.db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    const bps = ((station?.bitrate || 128) * 1000) / 8;

    this.streamEngine.setNowPlaying(stationId, meta);

    if (meta._isVT) {
      console.log(`  🎙 ${station?.name}: VT — ${meta.title}`);
    } else {
      console.log(`  ♪ ${station?.name}: ${meta.artist} — ${meta.title}`);
    }

    s.buf = buf;
    s.offset = 0;
    s.startedAt = Date.now();
    s.bytesPerMs = bps / 1000;

    this._tick(stationId);
  }

  /**
   * Clock-based tick: calculates how many bytes *should* have been sent
   * by now based on wall-clock time, then sends the difference.
   * Self-corrects for any timing jitter.
   */
  _tick(stationId) {
    const s = this.sessions.get(stationId);
    if (!s || !s.active || !s.buf) return;

    const elapsed = Date.now() - s.startedAt;
    const targetOffset = Math.floor(elapsed * s.bytesPerMs);
    const toSend = Math.min(targetOffset - s.offset, s.buf.length - s.offset);

    if (toSend > 0) {
      const chunk = s.buf.subarray(s.offset, s.offset + toSend);
      this.streamEngine.pushAudio(stationId, chunk);
      s.offset += toSend;
    }

    if (s.offset >= s.buf.length) {
      // Track done → next
      s.buf = null;
      s.timer = setTimeout(() => this._next(stationId), 0);
      return;
    }

    // Schedule next tick in 50ms — smoother delivery, less jitter
    s.timer = setTimeout(() => this._tick(stationId), 50);
  }

  /** Pick a random voice track for a station (if any exist) */
  _pickVoiceTrack(stationId) {
    const VT_DIR = VOLUME ? path.join(VOLUME, 'voicetracks') : path.join(__dirname, '..', 'voicetracks');
    const stationDir = path.join(VT_DIR, stationId);
    if (!fs.existsSync(stationDir)) return null;

    try {
      const files = fs.readdirSync(stationDir).filter(f => f.endsWith('.mp3'));
      if (!files.length) return null;
      const pick = files[Math.floor(Math.random() * files.length)];
      const name = path.parse(pick).name;
      // Filename format: "PresenterName - Title.mp3" or just "break.mp3"
      const parts = name.split(' - ');
      return {
        filePath: path.join(stationDir, pick),
        presenter: parts.length > 1 ? parts[0].trim() : 'Presenter',
        title: parts.length > 1 ? parts[1].trim() : name,
      };
    } catch {
      return null;
    }
  }

  _pickTrack(stationId, s) {
    let track = null;

    // 1) Play Now
    if (s.playNowId) {
      track = this.db.prepare('SELECT * FROM media WHERE id = ?').get(s.playNowId);
      s.playNowId = null;
      if (track) { console.log(`  ⚡ Play Now: ${track.artist} — ${track.title}`); return track; }
    }

    // 2) Priority Queue
    while (!track && s.priorityQueue.length) {
      const id = s.priorityQueue.shift();
      track = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id);
      if (track) { console.log(`  ▶ Queue: ${track.artist} — ${track.title}`); return track; }
    }

    // 3) Song requests
    const req = this.db.prepare(`
      SELECT sr.*, m.filename, m.original_name, m.duration, m.size, m.artwork_url
      FROM song_requests sr JOIN media m ON m.id = sr.media_id
      WHERE sr.station_id = ? AND sr.status = 'pending' AND sr.media_id IS NOT NULL
      ORDER BY sr.created_at ASC LIMIT 1
    `).get(stationId);
    if (req) {
      this.db.prepare("UPDATE song_requests SET status='played', played_at=datetime('now') WHERE id=?").run(req.id);
      console.log(`  ★ Request: ${req.artist} — ${req.title}`);
      return {
        id: req.media_id, title: req.title, artist: req.artist,
        album: req.album || '', filename: req.filename,
        original_name: req.original_name, duration: req.duration,
        artwork_url: req.artwork_url || '', _requestId: req.id,
      };
    }

    // 4) Shuffle queue
    if (s.queueIndex < s.queue.length) {
      return s.queue[s.queueIndex++];
    }
    return null;
  }

  _buildQueue(stationId) {
    const s = this.sessions.get(stationId);
    if (!s) return;

    let media = this.db.prepare(`
      SELECT DISTINCT m.* FROM media m
      JOIN playlist_items pi ON pi.media_id = m.id
      JOIN playlists p ON p.id = pi.playlist_id
      WHERE p.station_id = ?
    `).all(stationId);

    if (!media.length) {
      media = this.db.prepare('SELECT * FROM media WHERE station_id = ?').all(stationId);
    }

    // Fisher-Yates shuffle
    for (let i = media.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [media[i], media[j]] = [media[j], media[i]];
    }

    s.queue = media;
    s.queueIndex = 0;
  }

  async _autoEnrich(track) {
    try {
      const q = `${track.artist} ${track.title}`;
      const url = `https://api.typicalmedia.net/experiences/searchtrack.php?q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const results = await resp.json();
      if (Array.isArray(results) && results.length > 0 && results[0].album_art) {
        const t = results[0];
        this.db.prepare(`
          UPDATE media SET artwork_url = ?, tm_track_id = COALESCE(?, tm_track_id)
          WHERE id = ? AND (artwork_url IS NULL OR artwork_url = '')
        `).run(t.album_art, t.deezer_id || null, track.id);
        track.artwork_url = t.album_art;
        // Update live now-playing
        for (const [sid] of this.sessions) {
          const np = this.streamEngine.getNowPlaying(sid);
          if (np && np.media_id === track.id) {
            np.artwork_url = t.album_art;
            this.broadcast('nowplaying', { stationId: sid, ...np });
          }
        }
        console.log(`  🎨 Enriched: ${track.artist} — ${track.title}`);
      }
    } catch {}
  }
}

/* ── MP3 helpers ── */

function stripID3(buf) {
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    const end = 10 + size;
    if (end < buf.length) return buf.subarray(end);
  }
  return buf;
}

function alignFrame(buf) {
  for (let i = 0; i < Math.min(buf.length - 1, 8192); i++) {
    if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) {
      return i > 0 ? buf.subarray(i) : buf;
    }
  }
  return buf;
}

module.exports = { AutoDJ };
