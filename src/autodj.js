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

    // ── Check song request queue first ──
    let track = null;
    let requestId = null;
    const pendingReq = this.db.prepare(`
      SELECT sr.*, m.filename, m.original_name, m.duration, m.size, m.artwork_url
      FROM song_requests sr
      JOIN media m ON m.id = sr.media_id
      WHERE sr.station_id = ? AND sr.status = 'pending' AND sr.media_id IS NOT NULL
      ORDER BY sr.created_at ASC
      LIMIT 1
    `).get(stationId);

    if (pendingReq) {
      // Play the requested track
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
      // Mark request as played
      this.db.prepare("UPDATE song_requests SET status = 'played', played_at = datetime('now') WHERE id = ?").run(requestId);
      console.log(`  ★ Request played: ${track.artist} — ${track.title}`);
    } else {
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
    const chunkSize = Math.floor(bytesPerSecond / 10); // 10 chunks per second
    const intervalMs = 100; // send a chunk every 100ms

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
        // Track finished — move to next
        clearInterval(session.interval);
        session.interval = null;
        session.fileBuffer = null;
        // Small gap between tracks
        setTimeout(() => this._playNext(stationId), 800);
        return;
      }

      const chunk = fileBuffer.subarray(start, end);
      this.streamEngine.pushAudio(stationId, chunk);
      session.bufferOffset = end;
    }, intervalMs);
  }
}

module.exports = { AutoDJ };
