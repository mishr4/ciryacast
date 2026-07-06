const fs = require('fs');
const path = require('path');

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const RECORDINGS_DIR = VOLUME ? path.join(VOLUME, 'recordings') : path.join(__dirname, '..', 'recordings');
try { if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); } catch (e) { console.log('  ⚠ Recordings dir:', e.message); }

/**
 * StreamEngine — manages audio streams for each station.
 *
 * Distributes MP3 chunks from the AutoDJ to connected HTTP listeners.
 * Keeps a small ring buffer so new listeners get instant audio on connect.
 * Supports recording streams to MP3 files.
 */
class StreamEngine {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.stations = new Map();
  }

  _ensure(stationId) {
    if (!this.stations.has(stationId)) {
      this.stations.set(stationId, {
        listeners: new Set(),
        nowPlaying: null,
        buffer: [],
        bufferSize: 0,
        live: false,
        // Recording state
        recording: null, // { id, stream, startedAt, title }
      });
    }
    return this.stations.get(stationId);
  }

  /** Push MP3 chunk to all listeners, ring buffer, and active recording */
  pushAudio(stationId, chunk) {
    const s = this._ensure(stationId);

    // Ring buffer — keep ~256KB so a burst tail is always available
    s.buffer.push(chunk);
    s.bufferSize += chunk.length;
    while (s.bufferSize > 256 * 1024 && s.buffer.length > 1) {
      s.bufferSize -= s.buffer.shift().length;
    }

    // Deliver to listeners — handle backpressure gracefully
    for (const res of s.listeners) {
      try {
        if (res.destroyed || res.writableEnded) {
          this.removeListener(stationId, res);
          continue;
        }
        const ok = res.write(chunk);
        if (!ok && !res._draining) {
          // Backpressure — pause sending to this client until drain
          res._draining = true;
          res.once('drain', () => { res._draining = false; });
        }
      } catch {
        this.removeListener(stationId, res);
      }
    }

    // Write to recording file if active
    if (s.recording && s.recording.stream) {
      try { s.recording.stream.write(chunk); } catch {}
    }
  }

  pushLiveAudio(stationId, chunk) {
    // Same as pushAudio — live mic input goes to the same buffer
    // and is treated identically by the streaming engine
    this.pushAudio(stationId, chunk);
  }

  addListener(stationId, res, skipBuffer = false) {
    const s = this._ensure(stationId);
    s.listeners.add(res);

    // Burst on connect: send only the LAST ~96KB (~6s at 128kbps).
    // Enough for the browser to start playing instantly, but keeps the
    // listener close to live. Bursting the whole ring buffer put every
    // listener 15-30s behind real time — that was the delay.
    if (!skipBuffer && s.buffer.length > 0) {
      const BURST_BYTES = 96 * 1024;
      const tail = [];
      let total = 0;
      for (let i = s.buffer.length - 1; i >= 0 && total < BURST_BYTES; i--) {
        tail.unshift(s.buffer[i]);
        total += s.buffer[i].length;
      }
      try { res.write(Buffer.concat(tail)); } catch {}
    }

    this.broadcast('listeners', { stationId, count: s.listeners.size });
  }

  removeListener(stationId, res) {
    const s = this.stations.get(stationId);
    if (!s) return;
    if (!s.listeners.has(res)) return;
    s.listeners.delete(res);
    try { res.end(); } catch {}
    this.broadcast('listeners', { stationId, count: s.listeners.size });
  }

  /* ── Recording ── */

  startRecording(stationId, title) {
    const s = this._ensure(stationId);
    if (s.recording) return null; // already recording

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const filename = `${stationId}_${id}.mp3`;
    const filePath = path.join(RECORDINGS_DIR, filename);
    const stream = fs.createWriteStream(filePath);

    s.recording = {
      id,
      filename,
      filePath,
      stream,
      startedAt: new Date().toISOString(),
      title: title || 'Recording',
    };

    console.log(`  ● REC: Started "${title || 'Recording'}" on station ${stationId}`);
    this.broadcast('recording_start', { stationId, id, title: s.recording.title });

    return { id, title: s.recording.title, started_at: s.recording.startedAt };
  }

  stopRecording(stationId) {
    const s = this.stations.get(stationId);
    if (!s || !s.recording) return null;

    const rec = s.recording;
    try { rec.stream.end(); } catch {}

    const stats = fs.existsSync(rec.filePath) ? fs.statSync(rec.filePath) : { size: 0 };
    const duration = Math.floor((Date.now() - new Date(rec.startedAt).getTime()) / 1000);

    const result = {
      id: rec.id,
      filename: rec.filename,
      title: rec.title,
      started_at: rec.startedAt,
      duration,
      size: stats.size,
    };

    s.recording = null;
    console.log(`  ■ REC: Stopped "${rec.title}" (${duration}s, ${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    this.broadcast('recording_stop', { stationId, ...result });

    return result;
  }

  isRecording(stationId) {
    const s = this.stations.get(stationId);
    return s?.recording ? { id: s.recording.id, title: s.recording.title, started_at: s.recording.startedAt } : null;
  }

  /** List all saved recordings for a station */
  listRecordings(stationId) {
    try {
      const files = fs.readdirSync(RECORDINGS_DIR)
        .filter(f => f.startsWith(stationId + '_') && f.endsWith('.mp3'))
        .map(f => {
          const filePath = path.join(RECORDINGS_DIR, f);
          const stats = fs.statSync(filePath);
          const id = f.replace(`${stationId}_`, '').replace('.mp3', '');
          return {
            id,
            filename: f,
            size: stats.size,
            created_at: stats.birthtime.toISOString(),
            duration_estimate: Math.round(stats.size / (128000 / 8)), // rough estimate at 128kbps
          };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return files;
    } catch {
      return [];
    }
  }

  getRecordingPath(stationId, recordingId) {
    const filename = `${stationId}_${recordingId}.mp3`;
    const filePath = path.join(RECORDINGS_DIR, filename);
    if (fs.existsSync(filePath)) return filePath;
    return null;
  }

  deleteRecording(stationId, recordingId) {
    const filePath = this.getRecordingPath(stationId, recordingId);
    if (filePath) { try { fs.unlinkSync(filePath); return true; } catch {} }
    return false;
  }

  /* ── Now Playing ── */

  setNowPlaying(stationId, meta) {
    const s = this._ensure(stationId);
    const startedAt = Date.now();

    s.nowPlaying = {
      title: meta.title || 'Unknown',
      artist: meta.artist || 'Unknown',
      album: meta.album || '',
      duration: meta.duration || 0,
      artwork_url: meta.artwork_url || '',
      started_at: new Date(startedAt).toISOString(),
      _startedAtMs: startedAt,
      media_id: meta.media_id || null,
      is_request: meta.is_request || false,
    };

    this.broadcast('nowplaying', { stationId, ...this.getNowPlaying(stationId) });
  }

  getNowPlaying(stationId) {
    const np = this.stations.get(stationId)?.nowPlaying;
    if (!np) return null;
    // Compute elapsed on read — no per-station timers needed
    const { _startedAtMs, ...pub } = np;
    pub.elapsed = Math.floor((Date.now() - _startedAtMs) / 1000);
    return pub;
  }

  getListenerCount(stationId) {
    return this.stations.get(stationId)?.listeners.size || 0;
  }

  isLive(stationId) {
    return this.stations.get(stationId)?.live || false;
  }

  setLive(stationId, live) {
    this._ensure(stationId).live = live;
  }
}

module.exports = { StreamEngine };
