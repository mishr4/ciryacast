const fs = require('fs');
const path = require('path');

/**
 * StreamEngine — manages audio streams for each station.
 * Buffers audio chunks and distributes them to connected HTTP listeners.
 * Works with raw MP3 frames piped in by the AutoDJ.
 */
class StreamEngine {
  constructor(broadcast) {
    this.broadcast = broadcast;
    // stationId -> { listeners: Set<res>, nowPlaying: {}, buffer: Buffer[], live: bool }
    this.stations = new Map();
  }

  _ensure(stationId) {
    if (!this.stations.has(stationId)) {
      this.stations.set(stationId, {
        listeners: new Set(),
        nowPlaying: null,
        buffer: [],       // ring buffer of recent chunks for burst-on-connect
        bufferSize: 0,
        live: false,
      });
    }
    return this.stations.get(stationId);
  }

  /**
   * Push a chunk of MP3 data to all listeners on a station
   */
  pushAudio(stationId, chunk) {
    const state = this._ensure(stationId);

    // Add to ring buffer (keep ~1MB for burst-on-connect — smoother start)
    state.buffer.push(chunk);
    state.bufferSize += chunk.length;
    while (state.bufferSize > 1024 * 1024 && state.buffer.length > 1) {
      state.bufferSize -= state.buffer.shift().length;
    }

    // Write to all connected listeners
    for (const res of state.listeners) {
      try {
        const ok = res.write(chunk);
        if (!ok) {
          // Backpressure — listener too slow, drop them
          this.removeListener(stationId, res);
        }
      } catch {
        this.removeListener(stationId, res);
      }
    }
  }

  /**
   * Add an HTTP response as a listener
   */
  addListener(stationId, res) {
    const state = this._ensure(stationId);
    state.listeners.add(res);

    // Burst: send buffered audio so playback starts faster
    for (const chunk of state.buffer) {
      try { res.write(chunk); } catch { break; }
    }

    this.broadcast('listeners', {
      stationId,
      count: state.listeners.size,
    });
  }

  /**
   * Remove a listener
   */
  removeListener(stationId, res) {
    const state = this.stations.get(stationId);
    if (!state) return;
    state.listeners.delete(res);
    try { res.end(); } catch {}

    this.broadcast('listeners', {
      stationId,
      count: state.listeners.size,
    });
  }

  /**
   * Set now-playing metadata
   */
  setNowPlaying(stationId, meta) {
    const state = this._ensure(stationId);
    state.nowPlaying = {
      title: meta.title || 'Unknown',
      artist: meta.artist || 'Unknown',
      album: meta.album || '',
      duration: meta.duration || 0,
      art: meta.art || null,
      artwork_url: meta.artwork_url || '',
      started_at: new Date().toISOString(),
      elapsed: 0,
      media_id: meta.media_id || null,
      is_request: meta.is_request || false,
    };
    // Track elapsed time
    if (state._elapsedTimer) clearInterval(state._elapsedTimer);
    state._elapsedTimer = setInterval(() => {
      if (state.nowPlaying) state.nowPlaying.elapsed = Math.floor((Date.now() - new Date(state.nowPlaying.started_at).getTime()) / 1000);
    }, 1000);

    this.broadcast('nowplaying', {
      stationId,
      ...state.nowPlaying,
    });
  }

  getNowPlaying(stationId) {
    const state = this.stations.get(stationId);
    return state?.nowPlaying || null;
  }

  getListenerCount(stationId) {
    const state = this.stations.get(stationId);
    return state?.listeners.size || 0;
  }

  isLive(stationId) {
    const state = this.stations.get(stationId);
    return state?.live || false;
  }

  setLive(stationId, live) {
    const state = this._ensure(stationId);
    state.live = live;
  }
}

module.exports = { StreamEngine };
