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
    is_super_admin INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT,
    created_by TEXT DEFAULT 'system'
  );

  CREATE TABLE IF NOT EXISTS station_members (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'dj',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE,
    UNIQUE(station_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_station_members_station ON station_members(station_id);
  CREATE INDEX IF NOT EXISTS idx_station_members_user ON station_members(user_id);

  -- Banned staff emails — blocked from the dashboard / Cirya Utility
  CREATE TABLE IF NOT EXISTS banned_emails (
    email TEXT PRIMARY KEY,
    reason TEXT DEFAULT '',
    banned_by TEXT DEFAULT '',
    banned_at TEXT DEFAULT (datetime('now'))
  );

  -- Access log — captures IP per email so admins can IP-ban abusers
  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_access_log_email ON access_log(email);
`);

// ── Migrations: add columns if missing ──
try { db.exec('ALTER TABLE media ADD COLUMN artwork_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE media ADD COLUMN tm_track_id TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE stations ADD COLUMN logo_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE stations ADD COLUMN website_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE stations ADD COLUMN location TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE media ADD COLUMN stream_url TEXT DEFAULT ""'); } catch {}

// Clean URL slugs for stations (e.g. /player/cirya-radio-one)
try { db.exec('ALTER TABLE stations ADD COLUMN slug TEXT DEFAULT ""'); } catch {}
// Artwork + album on play history so "recently played" can show covers
try { db.exec('ALTER TABLE play_history ADD COLUMN artwork_url TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE play_history ADD COLUMN album TEXT DEFAULT ""'); } catch {}
// Requester IP — to cap how many songs one listener can queue
try { db.exec('ALTER TABLE song_requests ADD COLUMN ip TEXT DEFAULT ""'); } catch {}

// ── Station ownership & roles ──
// owner_id: user ID of the station owner (can manage users, settings, etc.)
try { db.exec('ALTER TABLE stations ADD COLUMN owner_id TEXT DEFAULT ""'); } catch {}
// is_hidden: 1 = not listed in public /stations directory, 0 = listed
try { db.exec('ALTER TABLE stations ADD COLUMN is_hidden INTEGER DEFAULT 0'); } catch {}
// is_super_admin: users with cirya.co email OR manually marked as super admin
try { db.exec('ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0'); } catch {}

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

// ── Scheduled Shows ──
// Create scheduled_shows table for time-based show automation
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_shows (
      id TEXT PRIMARY KEY,
      station_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      playlist_id TEXT,
      is_enabled INTEGER DEFAULT 1,
      -- Schedule: 'daily', 'weekly', 'monthly', 'once'
      schedule_type TEXT DEFAULT 'weekly',
      -- Time to start (HH:MM in 24h format)
      start_time TEXT DEFAULT '09:00',
      -- Days: '1,3,5' = Mon,Wed,Fri; '0' = every day; '1-5' = weekdays; '6,0' = weekend
      days_of_week TEXT DEFAULT '1-5',
      -- Duration in minutes
      duration_minutes INTEGER DEFAULT 60,
      -- For once-only shows: target date (YYYY-MM-DD)
      target_date TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT DEFAULT '',
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_shows_station ON scheduled_shows(station_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_shows_enabled ON scheduled_shows(is_enabled);
  `);
} catch {}

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

// ── Slug helpers + backfill ──
function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'station';
}

function makeUniqueSlug(base, excludeId) {
  const root = slugify(base);
  let slug = root, n = 1;
  while (true) {
    const row = db.prepare('SELECT id FROM stations WHERE slug = ?').get(slug);
    if (!row || row.id === excludeId) return slug;
    n++; slug = `${root}-${n}`;
  }
}

// Backfill slugs for any station missing one
for (const s of db.prepare("SELECT id, name FROM stations WHERE slug IS NULL OR slug = ''").all()) {
  db.prepare('UPDATE stations SET slug = ? WHERE id = ?').run(makeUniqueSlug(s.name, s.id), s.id);
}

db.slugify = slugify;
db.makeUniqueSlug = makeUniqueSlug;

module.exports = db;
