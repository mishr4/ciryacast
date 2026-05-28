/**
 * StreamEngine — manages audio streams for each station.
 *
 * Distributes MP3 chunks from the AutoDJ to connected HTTP listeners.
 * Keeps a small ring buffer so new listeners get instant audio on connect.
 */
class StreamEngine {
  constructor(broadcast) {
    this.broadcast = broadcast;
    // stationId -> StationState
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
        _elapsedTimer: null,
      });
    }
    return this.stations.get(stationId);
  }

  /** Push MP3 chunk to all listeners and ring buffer */
  pushAudio(stationId, chunk) {
    const s = this._ensure(stationId);

    // Ring buffer: ~192KB ≈ 12s at 128kbps — enough for smooth connect,
    // small enough that skips aren't delayed by stale data
    s.buffer.push(chunk);
    s.bufferSize += chunk.length;
    while (s.bufferSize > 192 * 1024 && s.buffer.length > 1) {
      s.bufferSize -= s.buffer.shift().length;
    }

    // Deliver to every connected listener
    for (const res of s.listeners) {
      try {
        if (!res.write(chunk)) {
          // Backpressure — slow client, disconnect
          this.removeListener(stationId, res);
        }
      } catch {
        this.removeListener(stationId, res);
      }
    }
  }

  /** Add an HTTP response as a stream listener */
  addListener(stationId, res) {
    const s = this._ensure(stationId);
    s.listeners.add(res);

    // Burst: send recent audio so playback starts instantly
    for (const chunk of s.buffer) {
      try { res.write(chunk); } catch { break; }
    }

    this.broadcast('listeners', { stationId, count: s.listeners.size });
  }

  /** Remove a listener cleanly */
  removeListener(stationId, res) {
    const s = this.stations.get(stationId);
    if (!s) return;
    if (!s.listeners.has(res)) return; // already removed
    s.listeners.delete(res);
    try { res.end(); } catch {}
    this.broadcast('listeners', { stationId, count: s.listeners.size });
  }

  /** Set now-playing metadata and start elapsed timer */
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
      elapsed: 0,
      media_id: meta.media_id || null,
      is_request: meta.is_request || false,
    };

    if (s._elapsedTimer) clearInterval(s._elapsedTimer);
    s._elapsedTimer = setInterval(() => {
      if (s.nowPlaying) {
        s.nowPlaying.elapsed = Math.floor((Date.now() - startedAt) / 1000);
      }
    }, 1000);

    this.broadcast('nowplaying', { stationId, ...s.nowPlaying });
  }

  getNowPlaying(stationId) {
    return this.stations.get(stationId)?.nowPlaying || null;
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
