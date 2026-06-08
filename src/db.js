const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

// Use Railway volume for persistent storage if available
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const dataDir = VOLUME ? path.join(VOLUME, 'data') : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, 'ciryacast.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');

// ── Schema ──
db.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    genre TEXT DEFAULT 'Various',
    bitrate INTEGER DEFAULT 128,
    autodj_enabled INTEGER DEFAULT 1,
    is_live INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    title TEXT DEFAULT '',
    artist TEXT DEFAULT '',
    album TEXT DEFAULT '',
    duration REAL DEFAULT 0,
    size INTEGER DEFAULT 0,
    mime_type TEXT DEFAULT 'audio/mpeg',
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    weight INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlist_items (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    media_id TEXT,
    title TEXT DEFAULT '',
    artist TEXT DEFAULT '',
    played_at TEXT DEFAULT (datetime('now')),
    listeners INTEGER DEFAULT 0,
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS song_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT DEFAULT '',
    artwork_url TEXT DEFAULT '',
    tm_track_id TEXT DEFAULT '',
    media_id TEXT,
    requested_by TEXT DEFAULT 'Listener',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    played_at TEXT,
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_requests_station_status
    ON song_requests(station_id, status);

  CREATE TABLE IF NOT EXISTS dj_accounts (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    username TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_connected TEXT,
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_dj_station
    ON dj_accounts(station_id);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT DEFAULT 'manager',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT,
    created_by TEXT DEFAULT 'system'
  );

  CREATE TABLE IF NOT EXISTS station_assignments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE,
    UNIQUE(user_id, station_id)
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_user ON station_assignments(user_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_station ON station_assignments(station_id);
`);

// ── Migrations: add columns if missing ──
try { db.exec('ALTER TABLE media ADD COLUMN artwork_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE media ADD COLUMN tm_track_id TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE stations ADD COLUMN logo_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE stations ADD COLUMN website_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE stations ADD COLUMN location TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE media ADD COLUMN stream_url TEXT DEFAULT ""'); } catch {}

// ── Playlist types & scheduling ──
// type: 'music' (default rotation), 'jingles', 'ads', 'sweepers', 'stingers', 'intros', 'outros'
try { db.exec('ALTER TABLE playlists ADD COLUMN type TEXT DEFAULT "music"'); } catch {}
// schedule_rule: when items from this playlist should play
//   '' = normal rotation (weighted shuffle with other music playlists)
//   'every_N_songs' = play one after every N music tracks
//   'top_of_hour' = play at :00 each hour
//   'bottom_of_hour' = play at :30 each hour
//   'once_per_hour' = play once per hour at random point
//   'between_every_song' = play between every song (for sweepers)
try { db.exec('ALTER TABLE playlists ADD COLUMN schedule_rule TEXT DEFAULT ""'); } catch {}
// How many songs between plays (for 'every_N_songs' rule)
try { db.exec('ALTER TABLE playlists ADD COLUMN play_every_n INTEGER DEFAULT 3'); } catch {}
// play_mode: 'shuffle' (random pick), 'sequential' (round-robin), 'once' (play once then disable)
try { db.exec('ALTER TABLE playlists ADD COLUMN play_mode TEXT DEFAULT "shuffle"'); } catch {}
// enabled flag (separate from is_default)
try { db.exec('ALTER TABLE playlists ADD COLUMN is_enabled INTEGER DEFAULT 1'); } catch {}

// ── Media folders/categories ──
// folder: organizational tag like 'Top Hits', 'Hawaiian', 'Throwbacks', 'Daily Top 40'
try { db.exec('ALTER TABLE media ADD COLUMN folder TEXT DEFAULT ""'); } catch {}
// genre tag for individual tracks
try { db.exec('ALTER TABLE media ADD COLUMN genre TEXT DEFAULT ""'); } catch {}

// ── Seed default station if none exist ──
const count = db.prepare('SELECT COUNT(*) as c FROM stations').get();
if (count.c === 0) {
  const id = uuid();
  db.prepare(`
    INSERT INTO stations (id, name, description, genre, bitrate, autodj_enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, 'Cirya Radio One', 'The flagship station of the Cirya Media Network', 'Various', 128, 1);

  // Create default playlist
  const plId = uuid();
  db.prepare(`
    INSERT INTO playlists (id, station_id, name, is_default, weight)
    VALUES (?, ?, ?, 1, 1)
  `).run(plId, id, 'General Rotation');

  console.log(`  ✓ Created default station: Cirya Radio One (${id})`);
}

module.exports = db;
