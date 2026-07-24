const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "tv-data")
  : path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "tmcast-tv.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'partner',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'manager',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    rtmp_url TEXT NOT NULL DEFAULT 'rtmp://a.rtmp.youtube.com/live2',
    stream_key_env TEXT NOT NULL DEFAULT 'YOUTUBE_STREAM_KEY',
    output_enabled INTEGER NOT NULL DEFAULT 0,
    fallback_asset_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    title TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'program',
    duration_seconds REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('asset', 'youtube')),
    asset_id INTEGER,
    url TEXT,
    label TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    stopped_at TEXT,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS youtube_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    youtube_url TEXT NOT NULL,
    poster_url TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS youtube_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    youtube_program_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY(youtube_program_id) REFERENCES youtube_programs(id) ON DELETE CASCADE
  );
`);

function addColumn(table, definition) {
  const name = definition.split(/\s+/)[0];
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
addColumn("channels", "organization_id INTEGER REFERENCES organizations(id)");
addColumn("channels", "stream_key_encrypted TEXT");
addColumn("channels", "public_live_url TEXT NOT NULL DEFAULT ''");
addColumn("channels", "artwork_url TEXT NOT NULL DEFAULT ''");
addColumn("channels", "watermark_url TEXT NOT NULL DEFAULT ''");
addColumn("channels", "ident_youtube_url TEXT NOT NULL DEFAULT ''");
addColumn("channels", "ident_duration_seconds INTEGER NOT NULL DEFAULT 6");
addColumn("channels", "auto_tv_enabled INTEGER NOT NULL DEFAULT 0");
addColumn("channels", "auto_tv_slot_minutes INTEGER NOT NULL DEFAULT 30");
addColumn("channels", "youtube_channel_id TEXT NOT NULL DEFAULT ''");
addColumn("channels", "youtube_channel_url TEXT NOT NULL DEFAULT ''");
addColumn("channels", "youtube_last_synced_at TEXT");
addColumn("youtube_programs", "kind TEXT NOT NULL DEFAULT 'program'");
addColumn("youtube_programs", "on_demand INTEGER NOT NULL DEFAULT 1");
addColumn("assets", "on_demand INTEGER NOT NULL DEFAULT 0");
addColumn("assets", "description TEXT NOT NULL DEFAULT ''");
addColumn("assets", "poster_url TEXT NOT NULL DEFAULT ''");
addColumn("assets", "published_at TEXT");

let defaultOrganization = db.prepare("SELECT * FROM organizations ORDER BY id LIMIT 1").get();
if (!defaultOrganization) {
  const result = db.prepare("INSERT INTO organizations (name, slug, plan) VALUES (?, ?, ?)").run("TMC Media", "tmc-media", "owner");
  defaultOrganization = db.prepare("SELECT * FROM organizations WHERE id = ?").get(result.lastInsertRowid);
}

if (!db.prepare("SELECT id FROM channels LIMIT 1").get()) {
  db.prepare(`
    INSERT INTO channels (name, slug, description)
    VALUES (?, ?, ?)
  `).run("TMCast One", "tmcast-one", "Main linear channel");
}
db.prepare("UPDATE channels SET organization_id = ? WHERE organization_id IS NULL").run(defaultOrganization.id);

module.exports = { db, defaultOrganization };
