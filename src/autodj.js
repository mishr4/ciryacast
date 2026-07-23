const fs = require('fs');
const path = require('path');

const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const MEDIA_DIR = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, '..', 'media');

// Valid MPEG audio silence frame (128kbps, 44100Hz, stereo, ~26ms)
// Keeps the browser's MP3 decoder alive during track transitions
const SILENCE_FRAME = Buffer.from(
  'fffb9004000000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000000000', 'hex'
);

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
      nextBuf: null,    // pre-loaded next track (for gapless transitions)
      nextMeta: null,   // metadata for next track
      offset: 0,        // bytes sent so far
      startedAt: 0,     // hrtime when streaming began (ms)
      bytesPerMs: 0,    // target bytes per millisecond
      // Queue features
      priorityQueue: [],
      playNowId: null,
      // Voice tracking — insert presenter audio between songs
      lastPlayedMusic: false,
      // Jingle/ad/sweeper counters
      songsSinceLastJingle: 0,
      songsSinceLastAd: 0,
      songsSinceLastSweeper: 0,
      lastTopOfHour: -1,      // hour number of last TOH jingle
      lastBottomOfHour: -1,   // hour of last BOH
      // Per-playlist sequential indices (for 'sequential' play_mode)
      seqIndices: {},
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

  /** The scheduled show active on this station right now, or null. Public so the
   *  now-playing API can surface the current programme (e.g. "K-Pop Hour") on
   *  the player, independent of whether AutoDJ is the one running. */
  activeShow(stationId) {
    try { return this._getActiveScheduledShow(stationId); } catch { return null; }
  }

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

  /** Check if a scheduled show is active right now — honours the show's
   *  duration, so a playlist scheduled e.g. 18:00 for 180 min ("Latino Time")
   *  stays active across the whole 18:00–21:00 window, not just at 18:00. */
  _getActiveScheduledShow(stationId) {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun … 6=Sat
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

    const shows = this.db.prepare(
      'SELECT * FROM scheduled_shows WHERE station_id = ? AND is_enabled = 1'
    ).all(stationId);

    for (const show of shows) {
      if (!show.playlist_id) continue;
      const m = /^(\d{1,2}):(\d{2})$/.exec(show.start_time || '');
      if (!m) continue;
      const startMins = (+m[1]) * 60 + (+m[2]);
      const endMins = startMins + (show.duration_minutes || 60);
      // Within today's window? (no midnight-wrap: a window past 24:00 just ends
      // at midnight — fine for typical day-parts like "Latino Time".)
      if (nowMins < startMins || nowMins >= endMins) continue;

      let dayOk = false;
      if (show.schedule_type === 'daily') dayOk = true;
      else if (show.schedule_type === 'weekly') dayOk = this._parseDays(show.days_of_week).includes(dayOfWeek);
      else if (show.schedule_type === 'once') dayOk = (show.target_date === today);

      if (dayOk) return show;
    }
    return null;
  }

  /** Parse days_of_week string: '1,3,5' or '1-5' or '0' */
  _parseDays(daysStr) {
    if (!daysStr || daysStr === '0') return [0, 1, 2, 3, 4, 5, 6]; // every day

    const days = new Set();
    const parts = daysStr.split(',');

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        for (let i = start; i <= end; i++) {
          days.add(i % 7);
        }
      } else {
        days.add(Number(part) % 7);
      }
    }

    return Array.from(days).sort((a, b) => a - b);
  }

  /**
   * SMART FALLBACK RESOLVER — the core of AutoDJ.
   *
   * Five priority layers; the highest layer with audio wins, and each falls
   * through to the next automatically so the station never goes dark:
   *
   *   P1  Guest DJ input   ─┐  live layers — handled in server.js: a live source
   *   P2  Studio input     ─┘  pauses AutoDJ entirely (startLiveSession), so we
   *                            only run when P1+P2 are both absent.
   *   P3  Scheduled playlists — _getActiveScheduledShow(): a show scheduled for
   *                            right now wins. PARTIAL schedules are fine — an
   *                            empty slot simply returns null and falls through.
   *   P4  Weighted rotation  — _buildQueue(): A-list/B-list/jingles/sweepers,
   *                            each playlist weighted (CentovaCast-style).
   *   P5  Random library     — _buildQueue() fallback: when no playlist has
   *                            tracks, shuffle the whole library forever. Also
   *                            the emergency floor — if everything above is
   *                            empty we retry here rather than emit silence.
   *
   * Pick the next track along that ladder and start streaming it.
   */
  _next(stationId) {
    const s = this.sessions.get(stationId);
    if (!s || !s.active) return;
    this._cancelTimer(s);

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // ── 0) Check for active scheduled shows (highest priority) ──
    const activeShow = this._getActiveScheduledShow(stationId);
    if (activeShow && activeShow.playlist_id) {
      const showTrack = this._pickFromPlaylist(stationId, { id: activeShow.playlist_id });
      if (showTrack) {
        console.log(`  📻 Scheduled show: ${activeShow.title}`);
        this._streamFile(stationId, path.join(MEDIA_DIR, showTrack.filename), {
          title: showTrack.title || showTrack.original_name,
          artist: activeShow.title || 'Scheduled Show',
          album: '',
          duration: showTrack.duration || 0,
          media_id: showTrack.id,
          artwork_url: showTrack.artwork_url || '',
          is_request: false,
        });
        return;
      }
    }

    // ── 1) Top of hour jingle (within first 2 minutes of the hour) ──
    if (currentMinute < 2 && s.lastTopOfHour !== currentHour) {
      const tohTrack = this._pickFromPlaylistType(stationId, 'top_of_hour');
      if (tohTrack) {
        s.lastTopOfHour = currentHour;
        console.log(`  🕐 Top of hour jingle`);
        this._streamFile(stationId, path.join(MEDIA_DIR, tohTrack.filename), {
          title: tohTrack.title || 'Station ID', artist: tohTrack.artist || 'TMCast',
          album: '', duration: tohTrack.duration || 0, media_id: tohTrack.id,
          artwork_url: tohTrack.artwork_url || '', _isVT: true,
        });
        return;
      }
    }

    // ── 2) Bottom of hour (within first 2 minutes past :30) ──
    if (currentMinute >= 30 && currentMinute < 32 && s.lastBottomOfHour !== currentHour) {
      const bohTrack = this._pickFromPlaylistType(stationId, 'bottom_of_hour');
      if (bohTrack) {
        s.lastBottomOfHour = currentHour;
        console.log(`  🕐 Bottom of hour`);
        this._streamFile(stationId, path.join(MEDIA_DIR, bohTrack.filename), {
          title: bohTrack.title || 'Station ID', artist: bohTrack.artist || 'TMCast',
          album: '', duration: bohTrack.duration || 0, media_id: bohTrack.id,
          artwork_url: bohTrack.artwork_url || '', _isVT: true,
        });
        return;
      }
    }

    // ── 3) Sweepers between every song ──
    if (s.lastPlayedMusic) {
      const sweeper = this._pickFromPlaylistType(stationId, 'between_every_song');
      if (sweeper) {
        s.lastPlayedMusic = false;
        this._streamFile(stationId, path.join(MEDIA_DIR, sweeper.filename), {
          title: sweeper.title || 'Sweeper', artist: sweeper.artist || 'TMCast',
          album: '', duration: sweeper.duration || 0, media_id: sweeper.id,
          artwork_url: sweeper.artwork_url || '', _isVT: true,
        });
        return;
      }
    }

    // ── 4) Jingles every N songs ──
    if (s.lastPlayedMusic) {
      const jinglePl = this._getScheduledPlaylist(stationId, 'every_N_songs', 'jingles');
      if (jinglePl && s.songsSinceLastJingle >= (jinglePl.play_every_n || 3)) {
        const jingle = this._pickFromPlaylist(stationId, jinglePl);
        if (jingle) {
          s.songsSinceLastJingle = 0;
          s.lastPlayedMusic = false;
          console.log(`  🔔 Jingle: ${jingle.title}`);
          this._streamFile(stationId, path.join(MEDIA_DIR, jingle.filename), {
            title: jingle.title || 'Jingle', artist: jingle.artist || 'TMCast',
            album: '', duration: jingle.duration || 0, media_id: jingle.id,
            artwork_url: jingle.artwork_url || '', _isVT: true,
          });
          return;
        }
      }
    }

    // ── 5) Ads every N songs ──
    if (s.lastPlayedMusic) {
      const adPl = this._getScheduledPlaylist(stationId, 'every_N_songs', 'ads');
      if (adPl && s.songsSinceLastAd >= (adPl.play_every_n || 5)) {
        const ad = this._pickFromPlaylist(stationId, adPl);
        if (ad) {
          s.songsSinceLastAd = 0;
          s.lastPlayedMusic = false;
          console.log(`  📢 Ad: ${ad.title}`);
          this._streamFile(stationId, path.join(MEDIA_DIR, ad.filename), {
            title: ad.title || 'Advertisement', artist: ad.artist || 'TMCast',
            album: '', duration: ad.duration || 0, media_id: ad.id,
            artwork_url: ad.artwork_url || '', _isVT: true,
          });
          return;
        }
      }
    }

    // ── 6) Voice tracking ──
    if (s.lastPlayedMusic) {
      const vt = this._pickVoiceTrack(stationId);
      if (vt) {
        s.lastPlayedMusic = false;
        this._streamFile(stationId, vt.filePath, {
          title: vt.title || 'Voice Break', artist: vt.presenter || 'Presenter',
          album: '', duration: 0, media_id: null,
          artwork_url: '', _isVT: true,
        });
        return;
      }
    }

    // ── 7) Music: playNow > priorityQueue > requests > shuffle ──
    if (!s.queue.length || s.queueIndex >= s.queue.length) {
      this._buildQueue(stationId);
    }
    if (!s.queue.length) {
      console.log(`  ⏸ ${stationId}: no media, retrying in 5s`);
      s.timer = setTimeout(() => this._next(stationId), 5000);
      return;
    }

    const track = this._pickTrack(stationId, s);
    if (!track) {
      s.timer = setTimeout(() => this._next(stationId), 2000);
      return;
    }

    // Update counters
    s.lastPlayedMusic = true;
    s.songsSinceLastJingle++;
    s.songsSinceLastAd++;
    s.songsSinceLastSweeper++;

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
      'INSERT INTO play_history (station_id, media_id, title, artist, album, artwork_url, listeners) VALUES (?,?,?,?,?,?,?)'
    ).run(stationId, track.id, track.title || track.original_name,
          track.artist || 'Unknown', track.album || '', track.artwork_url || '',
          this.streamEngine.getListenerCount(stationId));

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

  /** Skip an unplayable track (missing/corrupt file) WITHOUT recursing. A run
   *  of bad files — e.g. a scheduled playlist whose files were deleted, which is
   *  now active for its whole window — must not blow the call stack or spin the
   *  CPU. Deferring to a fresh tick breaks the _streamFile→_next recursion. */
  _skip(stationId) {
    const s = this.sessions.get(stationId);
    if (!s || !s.active) return;
    s.skips = (s.skips || 0) + 1;
    if (s.skips > 40) {
      console.log(`  ⚠ ${stationId}: 40+ unplayable files in a row — backing off 5s`);
      s.skips = 0;
      s.timer = setTimeout(() => this._next(stationId), 5000);
    } else {
      s.timer = setTimeout(() => this._next(stationId), 0);
    }
  }

  /** Stream a file to a station — shared by music tracks and voice tracks */
  /** If on-air processing is enabled and a baked copy of this file exists, use it. */
  _streamFile(stationId, filePath, meta) {
    const s = this.sessions.get(stationId);
    if (!s || !s.active) return;

    // Swap in the pre-processed ("air-chain baked") copy of this track if one is ready.
    // Falls back to the original whenever it isn't → never a gap while a preset processes.
    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠ Missing: ${meta.title}, skip`);
      return this._skip(stationId);
    }

    let buf;
    try { buf = fs.readFileSync(filePath); } catch (e) {
      console.log(`  ⚠ Read error: ${e.message}`);
      return this._skip(stationId);
    }
    if (buf.length < 1000) {
      return this._skip(stationId);
    }

    buf = stripID3(buf);
    buf = alignFrame(buf);
    if (buf.length < 500) {
      return this._skip(stationId);
    }
    s.skips = 0;   // a good file played — reset the unplayable-file counter

    const station = this.db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
    // Stream each file at ITS real bitrate (falls back to the station setting).
    // Sending a 320k file at 128k drains the listener's buffer → lag on that
    // song; this keeps delivery matched to playback for every track.
    const fileKbps = mp3Bitrate(buf) || station?.bitrate || 128;
    const bps = (fileKbps * 1000) / 8;

    // The progress bar must reflect what ACTUALLY plays. Metadata duration
    // (e.g. Deezer's 3:18) can disagree with the real file length, which made
    // elapsed run past the total. Use the true stream length: bytes / bitrate.
    const realDuration = Math.round(buf.length / bps);
    if (realDuration > 0) meta = { ...meta, duration: realDuration };

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
    const drift = targetOffset - s.offset;
    const toSend = Math.min(drift, s.buf.length - s.offset);

    if (toSend > 0) {
      const chunk = s.buf.subarray(s.offset, s.offset + toSend);
      this.streamEngine.pushAudio(stationId, chunk);
      s.offset += toSend;
    }

    // Warn if the event loop fell badly behind (throttled to once per 30s)
    if (drift > 2000 * s.bytesPerMs && Date.now() - (s._lastDriftWarn || 0) > 30000) {
      s._lastDriftWarn = Date.now();
      console.warn(`  ⏱ AutoDJ drift on ${stationId}: ${Math.round(drift / s.bytesPerMs)}ms behind (event loop stall?)`);
    }

    if (s.offset >= s.buf.length) {
      // Track done — load next track immediately
      // Don't send silence frames (corrupt MP3 stream)
      // Instead, _next loads the next file synchronously before tick resumes
      s.buf = null;
      this._next(stationId);
      return;
    }

    // 50ms tick — the clock-based math above self-corrects for any jitter,
    // so a faster tick adds CPU wakeups without reducing latency
    s.timer = setTimeout(() => this._tick(stationId), 50);
  }

  /** Get a playlist matching a schedule rule and optional type */
  _getScheduledPlaylist(stationId, rule, type = null) {
    let query = 'SELECT * FROM playlists WHERE station_id = ? AND schedule_rule = ? AND is_enabled = 1';
    const params = [stationId, rule];
    if (type) { query += ' AND type = ?'; params.push(type); }
    return this.db.prepare(query).get(...params);
  }

  /** Pick a random/sequential item from a specific playlist */
  _pickFromPlaylist(stationId, playlist) {
    const items = this.db.prepare(`
      SELECT m.* FROM media m
      JOIN playlist_items pi ON pi.media_id = m.id
      WHERE pi.playlist_id = ?
    `).all(playlist.id);
    if (!items.length) return null;

    if (playlist.play_mode === 'sequential') {
      const s = this.sessions.get(stationId);
      const idx = (s?.seqIndices?.[playlist.id] || 0) % items.length;
      if (s) { if (!s.seqIndices) s.seqIndices = {}; s.seqIndices[playlist.id] = idx + 1; }
      return items[idx];
    }
    return items[Math.floor(Math.random() * items.length)];
  }

  /** Pick from any playlist matching a schedule rule (e.g. 'top_of_hour') */
  _pickFromPlaylistType(stationId, rule) {
    const pl = this._getScheduledPlaylist(stationId, rule);
    return pl ? this._pickFromPlaylist(stationId, pl) : null;
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

    // Music playlists only — special types feed jingles/ads/sweepers elsewhere.
    const SPECIAL = ['jingles', 'ads', 'sweepers', 'stingers', 'intros', 'outros',
                     'top_of_hour', 'bottom_of_hour', 'between_every_song'];
    const playlists = this.db.prepare(
      'SELECT id, name, weight, type FROM playlists WHERE station_id = ? AND is_enabled = 1'
    ).all(stationId).filter(p => !SPECIAL.includes(p.type || 'music'));

    // Load each playlist's tracks once.
    const buckets = [];
    let totalTracks = 0;
    for (const pl of playlists) {
      const items = this.db.prepare(`
        SELECT DISTINCT m.* FROM media m
        JOIN playlist_items pi ON pi.media_id = m.id
        WHERE pi.playlist_id = ?
      `).all(pl.id);
      if (items.length) { buckets.push({ items, weight: Math.max(1, pl.weight || 1) }); totalTracks += items.length; }
    }

    let media = [];
    if (buckets.length) {
      // Weighted rotation: each slot picks a playlist with probability ∝ weight
      // (independent of its track count), then a random track from it.
      const totalWeight = buckets.reduce((a, b) => a + b.weight, 0);
      const len = Math.max(40, totalTracks * 2);
      let lastId = null;
      for (let i = 0; i < len; i++) {
        let r = Math.random() * totalWeight, bucket = buckets[0];
        for (const b of buckets) { r -= b.weight; if (r <= 0) { bucket = b; break; } }
        let t = bucket.items[Math.floor(Math.random() * bucket.items.length)];
        if (t.id === lastId && bucket.items.length > 1) t = bucket.items[Math.floor(Math.random() * bucket.items.length)];
        lastId = t.id;
        media.push(t);
      }
    } else {
      // No playlists with tracks → fall back to all of the station's media.
      media = this.db.prepare('SELECT * FROM media WHERE station_id = ?').all(stationId);
      for (let i = media.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [media[i], media[j]] = [media[j], media[i]];
      }
    }

    s.queue = media;
    s.queueIndex = 0;
  }

  async _autoEnrich(track) {
    try {
      const q = `${track.artist} ${track.title}`.trim();
      if (!q || q === 'Unknown') return;

      // Try Deezer search (free, no auth, has album art)
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await resp.json();

      if (data.data?.length > 0) {
        const t = data.data[0];
        const art = t.album?.cover_big || t.album?.cover_medium || t.album?.cover || '';
        const albumName = t.album?.title || '';
        const deezerId = t.id ? String(t.id) : '';

        if (art) {
          this.db.prepare(`
            UPDATE media SET
              artwork_url = ?,
              album = CASE WHEN album = '' OR album IS NULL THEN ? ELSE album END,
              tm_track_id = CASE WHEN tm_track_id = '' OR tm_track_id IS NULL THEN ? ELSE tm_track_id END
            WHERE id = ? AND (artwork_url IS NULL OR artwork_url = '')
          `).run(art, albumName, deezerId, track.id);

          track.artwork_url = art;
          if (!track.album && albumName) track.album = albumName;

          // Update live now-playing immediately
          for (const [sid] of this.sessions) {
            const np = this.streamEngine.getNowPlaying(sid);
            if (np && np.media_id === track.id) {
              np.artwork_url = art;
              if (albumName) np.album = albumName;
              this.broadcast('nowplaying', { stationId: sid, ...np });
            }
          }
          console.log(`  🎨 Enriched: ${track.artist} — ${track.title} (${art.substring(0, 50)}...)`);
        }
      }
    } catch (e) {
      // Deezer search failed — try TypicalMedia as fallback
      try {
        const q2 = `${track.artist} ${track.title}`;
        const resp2 = await fetch(`https://api.typicalmedia.net/experiences/searchtrack.php?q=${encodeURIComponent(q2)}`, { signal: AbortSignal.timeout(5000) });
        const results = await resp2.json();
        if (Array.isArray(results) && results.length > 0 && results[0].album_art) {
          this.db.prepare('UPDATE media SET artwork_url = ? WHERE id = ? AND (artwork_url IS NULL OR artwork_url = "")').run(results[0].album_art, track.id);
          track.artwork_url = results[0].album_art;
          for (const [sid] of this.sessions) {
            const np = this.streamEngine.getNowPlaying(sid);
            if (np && np.media_id === track.id) { np.artwork_url = results[0].album_art; this.broadcast('nowplaying', { stationId: sid, ...np }); }
          }
        }
      } catch {}
    }
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

// Read the encoded bitrate (kbps) from the first MPEG Layer-3 frame header so
// each track is streamed at the rate it actually plays — not the station's
// assumed bitrate. A mismatch (e.g. a 320k file sent at 128k) drains the
// listener's buffer and makes the song lag.
const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
function mp3Bitrate(buf) {
  const limit = Math.min(buf.length - 4, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) continue;
    const ver = (buf[i + 1] >> 3) & 0x03;      // 11=MPEG1, 10=MPEG2, 00=MPEG2.5
    const layer = (buf[i + 1] >> 1) & 0x03;    // 01 = Layer III
    if (layer !== 0x01 || ver === 0x01) continue;
    const brIndex = (buf[i + 2] >> 4) & 0x0F;
    if (brIndex === 0 || brIndex === 0x0F) continue;
    const kbps = (ver === 0x03 ? BR_V1L3 : BR_V2L3)[brIndex];
    if (kbps) return kbps;
  }
  return null;
}

module.exports = { AutoDJ };
