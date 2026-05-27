const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const CHUNK_SIZE = 4096;       // bytes per read chunk
const BITRATE_128 = 128000;    // bits per second

/**
 * AutoDJ — reads MP3 files from a station's playlist and streams
 * them as raw bytes to the StreamEngine at the correct bitrate.
 *
 * This is a pure Node.js streaming approach — no ffmpeg required.
 * It reads MP3 files and pushes audio chunks at the correct pace
 * to simulate real-time playback.
 */
class AutoDJ {
  constructor(db, streamEngine, broadcast) {
    this.db = db;
    this.streamEngine = streamEngine;
    this.broadcast = broadcast;
    // stationId -> { active, timer, currentMediaId, queue }
    this.sessions = new Map();
  }

  /**
   * Start AutoDJ for a station
   */
  start(stationId) {
    if (this.sessions.has(stationId)) return;

    const session = {
      active: true,
      timer: null,
      currentStream: null,
      queue: [],
      queueIndex: 0,
    };
    this.sessions.set(stationId, session);

    this._buildQueue(stationId);
    this._playNext(stationId);
  }

  /**
   * Stop AutoDJ for a station
   */
  stop(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return;

    session.active = false;
    if (session.timer) clearTimeout(session.timer);
    if (session.currentStream) {
      session.currentStream.destroy();
      session.currentStream = null;
    }
    this.sessions.delete(stationId);
  }

  /**
   * Skip to the next track
   */
  skip(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return;

    if (session.timer) clearTimeout(session.timer);
    if (session.currentStream) {
      session.currentStream.destroy();
      session.currentStream = null;
    }
    this._playNext(stationId);
  }

  isRunning(stationId) {
    return this.sessions.has(stationId);
  }

  /**
   * Build a shuffled queue from all media in the station's playlists
   */
  _buildQueue(stationId) {
    const session = this.sessions.get(stationId);
    if (!session) return;

    // Get all media for this station via playlists
    const media = this.db.prepare(`
      SELECT m.* FROM media m
      JOIN playlist_items pi ON pi.media_id = m.id
      JOIN playlists p ON p.id = pi.playlist_id
      WHERE p.station_id = ?
      ORDER BY pi.sort_order
    `).all(stationId);

    // Fallback: get all media for station (unplaylist'd)
    const allMedia = media.length > 0 ? media : this.db.prepare(
      'SELECT * FROM media WHERE station_id = ?'
    ).all(stationId);

    // Shuffle
    session.queue = allMedia.sort(() => Math.random() - 0.5);
    session.queueIndex = 0;
  }

  /**
   * Play the next track in the queue
   */
  _playNext(stationId) {
    const session = this.sessions.get(stationId);
    if (!session || !session.active) return;

    // If queue is empty or exhausted, rebuild
    if (session.queue.length === 0) {
      this._buildQueue(stationId);
    }

    if (session.queue.length === 0) {
      // No media at all — wait and retry
      session.timer = setTimeout(() => this._playNext(stationId), 5000);
      return;
    }

    // Wrap around
    if (session.queueIndex >= session.queue.length) {
      session.queue = session.queue.sort(() => Math.random() - 0.5);
      session.queueIndex = 0;
    }

    const track = session.queue[session.queueIndex++];
    const filePath = path.join(MEDIA_DIR, track.filename);

    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠ File missing: ${track.filename}, skipping`);
      this._playNext(stationId);
      return;
    }

    // Get station bitrate
    const station = this.db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    const bitrate = (station?.bitrate || 128) * 1000; // bits per second
    const bytesPerSecond = bitrate / 8;

    // Set now playing
    this.streamEngine.setNowPlaying(stationId, {
      title: track.title || track.original_name,
      artist: track.artist || 'Unknown',
      album: track.album || '',
      duration: track.duration || 0,
      media_id: track.id,
    });

    // Log to play history
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

    console.log(`  ♪ Now playing on ${station?.name || stationId}: ${track.artist} - ${track.title || track.original_name}`);

    // Stream the file at the correct bitrate
    this._streamFile(stationId, filePath, bytesPerSecond);
  }

  /**
   * Stream an MP3 file to the station at a controlled bitrate
   */
  _streamFile(stationId, filePath, bytesPerSecond) {
    const session = this.sessions.get(stationId);
    if (!session || !session.active) return;

    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
    session.currentStream = stream;

    let bytesSent = 0;
    const startTime = Date.now();

    // Interval to control pacing — send chunks at bitrate speed
    const msPerChunk = (CHUNK_SIZE / bytesPerSecond) * 1000;

    stream.on('readable', () => {
      const pump = () => {
        if (!session.active) { stream.destroy(); return; }

        const chunk = stream.read(CHUNK_SIZE);
        if (chunk === null) return; // wait for more data or end

        this.streamEngine.pushAudio(stationId, chunk);
        bytesSent += chunk.length;

        // Calculate when next chunk should be sent
        const elapsed = Date.now() - startTime;
        const expectedTime = (bytesSent / bytesPerSecond) * 1000;
        const delay = Math.max(0, expectedTime - elapsed);

        session.timer = setTimeout(pump, delay);
      };

      pump();
    });

    stream.on('end', () => {
      session.currentStream = null;
      // Small gap then next track
      session.timer = setTimeout(() => this._playNext(stationId), 500);
    });

    stream.on('error', (err) => {
      console.error(`  ✗ Stream error: ${err.message}`);
      session.currentStream = null;
      session.timer = setTimeout(() => this._playNext(stationId), 1000);
    });
  }
}

module.exports = { AutoDJ };
