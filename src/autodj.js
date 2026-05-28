const fs = require('fs');
const path = require('path');

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const MEDIA_DIR = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, '..', 'media');

/**
 * AutoDJ — reads MP3 files from a station's playlist and streams
 * them as raw bytes to the StreamEngine at the correct bitrate.
 *
 * Pure Node.js — no ffmpeg, no Liquidsoap.
 */
class AutoDJ {
  constructor(db, streamEngine, broadcast) {
    this.db = db;
    this.streamEngine = streamEngine;
    this.broadcast = broadcast;
    // stationId -> { active, interval, queue, queueIndex }
    this.sessions = new Map();
  }

  start(stationId) {
    if (this.sessions.has(stationId)) return;

    const session = {
      active: true,
      interval: null,
      queue: [],
      queueIndex: 0,
      fileBuffer: null,
      bufferOffset: 0,
      priorityQueue: [],  // tracks queued via "Add to Queue"
      playNowId: null,    // media ID to play immediately (skip current)
    };
    this.sessions.set(stationId, session);
    this._buildQueue(stationId);
    this._playNext(stationId);
  }

  stop(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return;
    session.active = false;
    if (session.interval) clearInterval(session.interval);
    this.sessions.delete(stationId);
  }

  skip(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return;
    if (session.interval) clearInterval(session.interval);
    session.interval = null;
    session.fileBuffer = null;
    this._playNext(stationId);
  }

  isRunning(stationId) {
    return this.sessions.has(stationId);
  }

  /**
   * Play a specific track immediately (skip current track)
   */
  playNow(stationId, mediaId) {
    const session = this.sessions.get(stationId);
    if (!session) return false;
    session.playNowId = mediaId;
    // Stop current playback and trigger next (which will pick up playNowId)
    if (session.interval) clearInterval(session.interval);
    session.interval = null;
    session.fileBuffer = null;
    this._playNext(stationId);
    return true;
  }

  /**
   * Add a track to the front of the priority queue (plays after current track)
   */
  queueNext(stationId, mediaId) {
    const session = this.sessions.get(stationId);
    if (!session) return false;
    session.priorityQueue.push(mediaId);
    return true;
  }

  /**
   * Get the current priority queue for a station
   */
  getQueue(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return [];
    return session.priorityQueue.map(id => {
      const m = this.db.prepare('SELECT id, title, artist, album, duration, artwork_url FROM media WHERE id = ?').get(id);
      return m || { id, title: 'Unknown', artist: 'Unknown' };
    });
  }

  /**
   * Auto-enrich a track with artwork from TypicalMedia (runs in background)
   */
  async _autoEnrich(track) {
    try {
      const query = `${track.artist} ${track.title}`;
      const url = `https://api.typicalmedia.net/experiences/searchtrack.php?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const results = await resp.json();
      if (Array.isArray(results) && results.length > 0) {
        const t = results[0];
        if (t.album_art) {
          this.db.prepare(`
            UPDATE media SET artwork_url = ?, tm_track_id = COALESCE(?, tm_track_id)
            WHERE id = ? AND (artwork_url IS NULL OR artwork_url = '')
          `).run(t.album_art, t.deezer_id || null, track.id);
          track.artwork_url = t.album_art;
          // Update the live now-playing with the artwork
          const sessions = [...this.sessions.entries()];
          for (const [sid, sess] of sessions) {
            const np = this.streamEngine.getNowPlaying(sid);
            if (np && np.media_id === track.id) {
              np.artwork_url = t.album_art;
              this.broadcast('nowplaying', { stationId: sid, ...np });
            }
          }
          console.log(`  🎨 Auto-enriched: ${track.artist} — ${track.title}`);
        }
      }
    } catch {}
  }

  _buildQueue(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return;

    // Get all media for this station via playlists
    let media = this.db.prepare(`
      SELECT DISTINCT m.* FROM media m
      JOIN playlist_items pi ON pi.media_id = m.id
      JOIN playlists p ON p.id = pi.playlist_id
      WHERE p.station_id = ?
    `).all(stationId);

    // Fallback: all media for station
    if (media.length === 0) {
      media = this.db.prepare('SELECT * FROM media WHERE station_id = ?').all(stationId);
    }

    // Shuffle
    session.queue = media.sort(() => Math.random() - 0.5);
    session.queueIndex = 0;
  }

  _playNext(stationId) {
    const session = this.sessions.get(stationId);
    if (!session || !session.active) return;

    // Clean up previous interval
    if (session.interval) {
      clearInterval(session.interval);
      session.interval = null;
    }

    // Rebuild queue if empty or exhausted
    if (session.queue.length === 0 || session.queueIndex >= session.queue.length) {
      this._buildQueue(stationId);
    }

    if (session.queue.length === 0) {
      // No media — wait 10 seconds and retry
      session.interval = setTimeout(() => {
        session.interval = null;
        this._playNext(stationId);
      }, 10000);
      return;
    }

    // ── Priority: 1) playNow, 2) priorityQueue, 3) song requests, 4) regular queue ──
    let track = null;
    let requestId = null;

    // 1) Play Now — immediate override
    if (session.playNowId) {
      const m = this.db.prepare('SELECT * FROM media WHERE id = ?').get(session.playNowId);
      session.playNowId = null;
      if (m) {
        track = m;
        console.log(`  ⚡ Play Now: ${track.artist} — ${track.title}`);
      }
    }

    // 2) Priority Queue — manually queued tracks
    if (!track && session.priorityQueue.length > 0) {
      const mediaId = session.priorityQueue.shift();
      const m = this.db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
      if (m) {
        track = m;
        console.log(`  ▶ Queue: ${track.artist} — ${track.title}`);
      }
    }

    // 3) Song request queue
    if (!track) {
      const pendingReq = this.db.prepare(`
        SELECT sr.*, m.filename, m.original_name, m.duration, m.size, m.artwork_url
        FROM song_requests sr
        JOIN media m ON m.id = sr.media_id
        WHERE sr.station_id = ? AND sr.status = 'pending' AND sr.media_id IS NOT NULL
        ORDER BY sr.created_at ASC
        LIMIT 1
      `).get(stationId);

      if (pendingReq) {
        track = {
          id: pendingReq.media_id,
          title: pendingReq.title,
          artist: pendingReq.artist,
          album: pendingReq.album || '',
          filename: pendingReq.filename,
          original_name: pendingReq.original_name,
          duration: pendingReq.duration,
          artwork_url: pendingReq.artwork_url || '',
        };
        requestId = pendingReq.id;
        this.db.prepare("UPDATE song_requests SET status = 'played', played_at = datetime('now') WHERE id = ?").run(requestId);
        console.log(`  ★ Request played: ${track.artist} — ${track.title}`);
      }
    }

    // 4) Regular shuffle queue
    if (!track) {
      track = session.queue[session.queueIndex++];
    }

    const filePath = path.join(MEDIA_DIR, track.filename);

    // Check file exists BEFORE doing anything
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠ Missing: ${track.original_name}, skipping`);
      // Small delay to prevent rapid loop if all files missing
      setTimeout(() => this._playNext(stationId), 500);
      return;
    }

    // Read entire file into memory (radio files are typically 3-10MB, fine for memory)
    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(filePath);
    } catch (err) {
      console.log(`  ⚠ Read error: ${err.message}`);
      setTimeout(() => this._playNext(stationId), 1000);
      return;
    }

    if (fileBuffer.length === 0) {
      setTimeout(() => this._playNext(stationId), 500);
      return;
    }

    // Get station bitrate
    const station = this.db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    const bitrate = (station?.bitrate || 128) * 1000;
    const bytesPerSecond = bitrate / 8;
    // Stream at 1.15x real-time so client buffer stays ahead of playback.
    // Larger chunks (4/sec) reduce overhead vs tiny chunks (10/sec).
    const SPEED_MULT = 1.15;
    const CHUNKS_PER_SEC = 4;
    const chunkSize = Math.floor((bytesPerSecond * SPEED_MULT) / CHUNKS_PER_SEC);
    const intervalMs = Math.floor(1000 / CHUNKS_PER_SEC); // 250ms

    // Auto-enrich artwork from TypicalMedia if missing
    if (!track.artwork_url && track.title && track.artist !== 'Unknown') {
      this._autoEnrich(track).catch(() => {});
    }

    // NOW set metadata and log history (file confirmed valid)
    this.streamEngine.setNowPlaying(stationId, {
      title: track.title || track.original_name,
      artist: track.artist || 'Unknown',
      album: track.album || '',
      duration: track.duration || 0,
      media_id: track.id,
      artwork_url: track.artwork_url || '',
      is_request: !!requestId,
    });

    this.db.prepare(`
      INSERT INTO play_history (station_id, media_id, title, artist, listeners)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      stationId, track.id,
      track.title || track.original_name,
      track.artist || 'Unknown',
      this.streamEngine.getListenerCount(stationId)
    );

    this.broadcast('track_change', {
      stationId,
      track: {
        id: track.id,
        title: track.title || track.original_name,
        artist: track.artist || 'Unknown',
        album: track.album || '',
        duration: track.duration,
      },
    });

    console.log(`  ♪ ${station?.name}: ${track.artist || 'Unknown'} — ${track.title || track.original_name}`);

    // Stream the file buffer at bitrate pace
    session.fileBuffer = fileBuffer;
    session.bufferOffset = 0;

    session.interval = setInterval(() => {
      if (!session.active) {
        clearInterval(session.interval);
        return;
      }

      const start = session.bufferOffset;
      const end = Math.min(start + chunkSize, fileBuffer.length);

      if (start >= fileBuffer.length) {
        // Track finished — move to next immediately
        clearInterval(session.interval);
        session.interval = null;
        session.fileBuffer = null;
        setTimeout(() => this._playNext(stationId), 50);
        return;
      }

      const chunk = fileBuffer.subarray(start, end);
      this.streamEngine.pushAudio(stationId, chunk);
      session.bufferOffset = end;
    }, intervalMs);
  }
}

module.exports = { AutoDJ };
