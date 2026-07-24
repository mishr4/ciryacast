require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { db, defaultOrganization } = require("./db");
const { encrypt } = require("./credentials");
const playout = require("./playout");

const app = express();
const root = path.resolve(__dirname, "..");
const mediaDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "tv-media")
  : path.join(root, "media");
fs.mkdirSync(mediaDir, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS web_sessions (
    sid TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )
`);
db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(Date.now());

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare("SELECT data FROM web_sessions WHERE sid = ? AND expires_at > ?").get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }
  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      db.prepare(`
        INSERT INTO web_sessions (sid, expires_at, data) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data
      `).run(sid, expiresAt, JSON.stringify(value));
      callback();
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { db.prepare("DELETE FROM web_sessions WHERE sid = ?").run(sid); callback(); }
    catch (error) { callback(error); }
  }
  touch(sid, value, callback = () => {}) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      db.prepare("UPDATE web_sessions SET expires_at = ? WHERE sid = ?").run(expiresAt, sid);
      callback();
    } catch (error) { callback(error); }
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: mediaDir,
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("video/") || file.mimetype.startsWith("audio/"))
});
const brandingUpload = multer({
  storage: multer.diskStorage({
    destination: mediaDir,
    filename: (_req, file, callback) => callback(null, `branding-${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype))
});

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || process.env.CREDENTIALS_ENCRYPTION_KEY || "tmcast-local-session-only",
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use("/media", express.static(mediaDir, { acceptRanges: true, cacheControl: true, maxAge: "1h" }));
app.use(express.static(path.join(root, "public")));
app.get("/control", (_req, res) => res.sendFile(path.join(root, "public", "control.html")));
app.get(/^\/watch\/[^/]+(?:\/\d+)?$/, (_req, res) => res.sendFile(path.join(root, "public", "watch.html")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/networks", (_req, res) => {
  res.json(db.prepare(`
    SELECT o.name, o.slug,
      (SELECT COUNT(*) FROM channels c WHERE c.organization_id = o.id) AS channel_count
    FROM organizations o WHERE o.active = 1 ORDER BY o.name
  `).all());
});

if (!db.prepare("SELECT id FROM users LIMIT 1").get()) {
  const email = String(process.env.ADMIN_EMAIL || "alexnmishra@gmail.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  db.prepare("INSERT INTO users (organization_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
    .run(defaultOrganization.id, "TMCast Administrator", email, password ? bcrypt.hashSync(password, 12) : "");
  console.log(`First-run administrator: ${email}${password ? "" : " (password setup required in the website)"}`);
}
db.prepare("UPDATE users SET role = 'platform_admin' WHERE organization_id = ? AND role = 'owner' AND email = ?")
  .run(defaultOrganization.id, String(process.env.ADMIN_EMAIL || "alexnmishra@gmail.com").toLowerCase());
db.prepare("UPDATE users SET email = ?, password_hash = '', role = 'platform_admin' WHERE email = 'admin@tmcast.local'")
  .run("alexnmishra@gmail.com");

const currentUser = id => db.prepare(`
  SELECT u.id, u.name, u.email, u.role, u.organization_id, o.name AS organization_name, o.slug AS organization_slug, o.plan
  FROM users u JOIN organizations o ON o.id = u.organization_id
  WHERE u.id = ? AND u.active = 1 AND o.active = 1
`).get(id);
const requireAuth = (req, res, next) => {
  const user = currentUser(req.session.userId);
  if (!user) return res.status(401).json({ error: "Sign in required." });
  req.user = user;
  next();
};
const requireOwner = (req, res, next) => {
  if (req.user.role !== "platform_admin") return res.status(403).json({ error: "Platform administrator access required." });
  next();
};
const ownsChannel = (req, res, next) => {
  const id = req.params.id || req.params.channelId;
  const channel = req.user.role === "platform_admin"
    ? db.prepare("SELECT * FROM channels WHERE id = ?").get(id)
    : db.prepare("SELECT * FROM channels WHERE id = ? AND organization_id = ?").get(id, req.user.organization_id);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  req.channel = channel;
  next();
};

async function youtubeApi(endpoint, params) {
  const key = String(process.env.YOUTUBE_API_KEY || "").trim();
  if (!key) throw new Error("YOUTUBE_API_KEY is not configured in Railway.");
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries({ ...params, key }).forEach(([name, value]) => url.searchParams.set(name, value));
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || "YouTube could not be reached.");
  return body;
}

function youtubeChannelLookup(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a YouTube channel URL, @handle, or channel ID.");
  if (/^UC[\w-]{20,}$/i.test(raw)) return { id: raw };
  if (raw.startsWith("@")) return { forHandle: raw.slice(1) };
  try {
    const url = new URL(raw);
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) throw new Error();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "channel" && parts[1]) return { id: parts[1] };
    if (parts[0]?.startsWith("@")) return { forHandle: parts[0].slice(1) };
  } catch {}
  throw new Error("Use a youtube.com/@handle URL or youtube.com/channel/UC... URL.");
}

function isoDurationSeconds(value) {
  const match = String(value || "").match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return (Number(match[1]) || 0) * 86400 + (Number(match[2]) || 0) * 3600 + (Number(match[3]) || 0) * 60 + (Number(match[4]) || 0);
}

async function syncYoutubeChannel(channelId, input) {
  const lookup = youtubeChannelLookup(input);
  const channelResult = await youtubeApi("channels", { part: "snippet,contentDetails", ...lookup });
  const source = channelResult.items?.[0];
  if (!source) throw new Error("YouTube channel not found. Check the URL or handle.");
  const uploads = source.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("YouTube did not provide an uploads playlist for this channel.");

  const videos = [];
  let pageToken = "";
  do {
    const page = await youtubeApi("playlistItems", {
      part: "snippet,contentDetails,status",
      playlistId: uploads,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {})
    });
    for (const item of page.items || []) {
      const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      if (!videoId || !title || title === "Private video" || title === "Deleted video" || item.status?.privacyStatus === "private") continue;
      const thumbnails = item.snippet?.thumbnails || {};
      videos.push({
        title,
        description: item.snippet?.description || "",
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
        posterUrl: (thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default || {}).url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || new Date().toISOString()
      });
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  const durations = new Map();
  for (let index = 0; index < videos.length; index += 50) {
    const ids = videos.slice(index, index + 50).map(video => new URL(video.youtubeUrl).searchParams.get("v")).filter(Boolean);
    if (!ids.length) continue;
    const details = await youtubeApi("videos", { part: "contentDetails", id: ids.join(",") });
    for (const video of details.items || []) durations.set(video.id, isoDurationSeconds(video.contentDetails?.duration));
  }

  const find = db.prepare("SELECT id FROM youtube_programs WHERE channel_id = ? AND youtube_url = ?");
  const insert = db.prepare(`
    INSERT INTO youtube_programs (channel_id, title, description, youtube_url, poster_url, published_at, kind, on_demand, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, 'program', 1, ?)
  `);
  const update = db.prepare("UPDATE youtube_programs SET title = ?, description = ?, poster_url = ?, published_at = ?, duration_seconds = ? WHERE id = ?");
  let added = 0;
  let updated = 0;
  db.transaction(() => {
    for (const video of videos) {
      const existing = find.get(channelId, video.youtubeUrl);
      const videoId = new URL(video.youtubeUrl).searchParams.get("v");
      const duration = durations.get(videoId) || null;
      if (existing) {
        update.run(video.title, video.description, video.posterUrl, video.publishedAt, duration, existing.id);
        updated++;
      } else {
        insert.run(channelId, video.title, video.description, video.youtubeUrl, video.posterUrl, video.publishedAt, duration);
        added++;
      }
    }
    const channelUrl = `https://www.youtube.com/channel/${source.id}`;
    const artwork = source.snippet?.thumbnails?.high?.url || source.snippet?.thumbnails?.default?.url || "";
    db.prepare(`
      UPDATE channels SET youtube_channel_id = ?, youtube_channel_url = ?, youtube_last_synced_at = ?,
        auto_tv_enabled = 1, artwork_url = CASE WHEN artwork_url = '' THEN ? ELSE artwork_url END
      WHERE id = ?
    `).run(source.id, channelUrl, new Date().toISOString(), artwork, channelId);
  })();
  return { channelTitle: source.snippet?.title || "YouTube channel", total: videos.length, added, updated };
}

setTimeout(() => {
  for (const channel of db.prepare("SELECT id, youtube_channel_url FROM channels WHERE youtube_channel_url != ''").all()) {
    syncYoutubeChannel(channel.id, channel.youtube_channel_url).catch(error => console.error(`YouTube sync failed for channel ${channel.id}: ${error.message}`));
  }
}, 5000);

app.post("/api/auth/login", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(String(req.body.email || "").trim().toLowerCase());
  if (!user) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (!user.password_hash) {
    req.session.passwordSetupUserId = user.id;
    return res.json({ setup_required: true, email: user.email });
  }
  if (!bcrypt.compareSync(String(req.body.password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  req.session.userId = user.id;
  res.json(currentUser(user.id));
});
app.post("/api/auth/setup-password", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(req.session.passwordSetupUserId);
  if (!user || user.password_hash) return res.status(403).json({ error: "Password setup is not available." });
  const password = String(req.body.password || "");
  if (password.length < 10) return res.status(400).json({ error: "Use at least 10 characters." });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), user.id);
  req.session.userId = user.id;
  delete req.session.passwordSetupUserId;
  res.json(currentUser(user.id));
});
app.post("/api/auth/logout", (req, res) => req.session.destroy(() => res.status(204).end()));
app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req.session.userId);
  if (!user) return res.status(401).json({ error: "Sign in required." });
  res.json(user);
});

app.get("/api/watch/:organization", (req, res) => {
  const organization = db.prepare("SELECT id, name, slug FROM organizations WHERE slug = ? AND active = 1").get(req.params.organization);
  if (!organization) return res.status(404).json({ error: "Catalog not found." });
  const assets = db.prepare(`
    SELECT a.id, a.title, a.description, a.poster_url, a.mime_type, a.size, a.published_at, c.name AS channel_name
    FROM assets a JOIN channels c ON c.id = a.channel_id
    WHERE c.organization_id = ? AND a.on_demand = 1 ORDER BY a.published_at DESC
  `).all(organization.id);
  res.json({ organization, assets });
});
app.get("/api/watch/:organization/:assetId", (req, res) => {
  const asset = db.prepare(`
    SELECT a.id, a.title, a.description, a.poster_url, a.filename, a.mime_type, a.published_at,
           c.name AS channel_name, o.name AS organization_name, o.slug AS organization_slug
    FROM assets a JOIN channels c ON c.id = a.channel_id JOIN organizations o ON o.id = c.organization_id
    WHERE o.slug = ? AND a.id = ? AND a.on_demand = 1 AND o.active = 1
  `).get(req.params.organization, req.params.assetId);
  if (!asset) return res.status(404).json({ error: "Video not found." });
  res.json({ ...asset, playback_url: `/media/${encodeURIComponent(asset.filename)}` });
});
app.get("/api/viewer/:organization", (req, res) => {
  const organization = db.prepare("SELECT id, name, slug FROM organizations WHERE slug = ? AND active = 1").get(req.params.organization);
  if (!organization) return res.status(404).json({ error: "Network not found." });
  const channels = db.prepare(`
    SELECT id, name, description, public_live_url, artwork_url, watermark_url,
      ident_youtube_url, ident_duration_seconds, output_enabled
    FROM channels WHERE organization_id = ? ORDER BY id
  `).all(organization.id).map(channel => {
    const source = playout.getSource(channel.id);
    const automatedUrl = source.type === "youtube" ? source.url : "";
    const playbackUrl = automatedUrl || (channel.output_enabled ? channel.public_live_url : "");
    return {
      ...channel,
      playback_url: playbackUrl,
      playback_start_seconds: automatedUrl ? Math.floor(Number(source.startSeconds) || 0) : 0,
      playback_mode: automatedUrl ? (source.autoTv ? "auto_tv" : "automation") : playbackUrl ? "youtube_live" : "off_air",
      is_live: Boolean(playbackUrl),
      now_playing: source.label
    };
  });
  const programs = db.prepare(`
    SELECT a.id, a.title, a.description, a.poster_url, a.mime_type, a.published_at,
      c.name AS channel_name, c.watermark_url, c.ident_youtube_url, c.ident_duration_seconds
    FROM assets a JOIN channels c ON c.id = a.channel_id
    WHERE c.organization_id = ? AND a.on_demand = 1 ORDER BY a.published_at DESC
  `).all(organization.id).map(program => ({ ...program, playback_url: `/media/${encodeURIComponent(db.prepare("SELECT filename FROM assets WHERE id = ?").get(program.id).filename)}` }));
  const youtubePrograms = db.prepare(`
    SELECT y.id, y.title, y.description, y.poster_url, y.youtube_url, y.published_at,
      c.name AS channel_name, c.watermark_url, c.ident_youtube_url, c.ident_duration_seconds
    FROM youtube_programs y JOIN channels c ON c.id = y.channel_id
    WHERE c.organization_id = ? AND y.on_demand = 1 ORDER BY y.published_at DESC
  `).all(organization.id).map(program => ({ ...program, playback_type: "youtube" }));
  res.json({ organization, channels, programs: [...youtubePrograms, ...programs].sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))) });
});

app.use("/api", requireAuth);
app.get("/api/channels", (_req, res) => {
  const requestedOrganization = Number(_req.query.organization_id);
  const organizationId = _req.user.role === "platform_admin" && requestedOrganization
    ? requestedOrganization
    : _req.user.organization_id;
  const channels = db.prepare("SELECT * FROM channels WHERE organization_id = ? ORDER BY id").all(organizationId);
  res.json(channels.map(({ stream_key_encrypted, ...channel }) => ({
    ...channel,
    stream_key_configured: Boolean(stream_key_encrypted),
    status: playout.status(channel.id)
  })));
});
app.get("/api/organizations", requireOwner, (_req, res) => {
  res.json(db.prepare("SELECT id, name, slug, plan, active FROM organizations ORDER BY name").all());
});
app.post("/api/channels", async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Channel name is required." });
  const organizationId = req.user.role === "platform_admin" && req.body.organization_id
    ? Number(req.body.organization_id)
    : req.user.organization_id;
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE id = ? AND active = 1").get(organizationId);
  if (!organization) {
    return res.status(400).json({ error: "Choose an active company." });
  }
  const baseSlug = String(req.body.slug || `${organization.slug}-${name}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  let slug = baseSlug;
  let suffix = 2;
  while (db.prepare("SELECT id FROM channels WHERE slug = ?").get(slug)) slug = `${baseSlug}-${suffix++}`;
  try {
    const result = db.prepare("INSERT INTO channels (name, slug, description, organization_id) VALUES (?, ?, ?, ?)").run(name, slug, req.body.description || "", organizationId);
    let sync = null;
    let syncError = "";
    if (req.body.youtube_channel_url) {
      try { sync = await syncYoutubeChannel(result.lastInsertRowid, req.body.youtube_channel_url); }
      catch (error) { syncError = error.message; }
    }
    res.status(201).json({ ...db.prepare("SELECT * FROM channels WHERE id = ?").get(result.lastInsertRowid), sync, sync_error: syncError });
  } catch (error) {
    res.status(400).json({ error: error.message.includes("UNIQUE") ? "That channel slug already exists." : error.message });
  }
});
app.post("/api/channels/:id/youtube-sync", ownsChannel, async (req, res) => {
  try {
    const source = String(req.body.youtube_channel_url || req.channel.youtube_channel_url || "").trim();
    const sync = await syncYoutubeChannel(req.channel.id, source);
    res.json({ ...sync, channel: db.prepare("SELECT * FROM channels WHERE id = ?").get(req.channel.id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.patch("/api/channels/:id", ownsChannel, (req, res) => {
  const current = req.channel;
  const next = { ...current, ...req.body };
  db.prepare(`
    UPDATE channels SET name = ?, description = ?, rtmp_url = ?, stream_key_env = ?, fallback_asset_id = ?,
      public_live_url = ?, artwork_url = ?, watermark_url = ?, ident_youtube_url = ?, ident_duration_seconds = ?,
      auto_tv_enabled = ?, auto_tv_slot_minutes = ?
    WHERE id = ?
  `).run(next.name, next.description, next.rtmp_url, next.stream_key_env, next.fallback_asset_id || null,
    next.public_live_url || "", next.artwork_url || "", next.watermark_url || "",
    next.ident_youtube_url || "", Math.max(1, Math.min(30, Number(next.ident_duration_seconds) || 6)),
    next.auto_tv_enabled ? 1 : 0, Math.max(5, Math.min(240, Number(next.auto_tv_slot_minutes) || 30)), current.id);
  const { stream_key_encrypted, ...channel } = db.prepare("SELECT * FROM channels WHERE id = ?").get(current.id);
  res.json({ ...channel, stream_key_configured: Boolean(stream_key_encrypted) });
});
app.post("/api/channels/:id/branding", ownsChannel, brandingUpload.fields([
  { name: "artwork", maxCount: 1 },
  { name: "watermark", maxCount: 1 }
]), (req, res) => {
  const artwork = req.files?.artwork?.[0];
  const watermark = req.files?.watermark?.[0];
  if (!artwork && !watermark) return res.status(400).json({ error: "Choose an artwork or watermark image." });

  const current = db.prepare("SELECT artwork_url, watermark_url FROM channels WHERE id = ?").get(req.channel.id);
  const removeOldUpload = value => {
    const match = String(value || "").match(/^\/tv\/media\/(branding-[^/]+)$/);
    if (match) fs.rmSync(path.join(mediaDir, match[1]), { force: true });
  };
  if (artwork) removeOldUpload(current.artwork_url);
  if (watermark) removeOldUpload(current.watermark_url);

  const artworkUrl = artwork ? `/tv/media/${artwork.filename}` : current.artwork_url;
  const watermarkUrl = watermark ? `/tv/media/${watermark.filename}` : current.watermark_url;
  db.prepare("UPDATE channels SET artwork_url = ?, watermark_url = ? WHERE id = ?")
    .run(artworkUrl, watermarkUrl, req.channel.id);
  res.json({ artwork_url: artworkUrl, watermark_url: watermarkUrl });
});
app.put("/api/channels/:id/youtube-credentials", ownsChannel, (req, res) => {
  const streamKey = String(req.body.stream_key || "").trim();
  const rtmpUrl = String(req.body.rtmp_url || "rtmp://a.rtmp.youtube.com/live2").trim();
  if (!streamKey || streamKey.length < 8) return res.status(400).json({ error: "Enter a valid YouTube stream key." });
  if (!/^rtmps?:\/\//i.test(rtmpUrl)) return res.status(400).json({ error: "RTMP server must begin with rtmp:// or rtmps://." });
  db.prepare("UPDATE channels SET stream_key_encrypted = ?, rtmp_url = ? WHERE id = ?")
    .run(encrypt(streamKey), rtmpUrl, req.channel.id);
  playout.stop(req.channel.id);
  playout.reconcile();
  res.json({ configured: true });
});
app.delete("/api/channels/:id/youtube-credentials", ownsChannel, (req, res) => {
  db.prepare("UPDATE channels SET stream_key_encrypted = NULL, output_enabled = 0 WHERE id = ?").run(req.channel.id);
  playout.stop(req.channel.id);
  res.status(204).end();
});

app.get("/api/channels/:id/assets", ownsChannel, (req, res) => {
  res.json(db.prepare("SELECT * FROM assets WHERE channel_id = ? ORDER BY created_at DESC").all(req.params.id));
});
app.post("/api/channels/:id/assets", ownsChannel, upload.array("files", 30), (req, res) => {
  const channel = req.channel;
  const kind = ["program", "promo", "ad", "ident"].includes(req.body.kind) ? req.body.kind : "program";
  const insert = db.prepare(`
    INSERT INTO assets (channel_id, filename, original_name, title, mime_type, size, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const items = (req.files || []).map(file => {
    const title = path.parse(file.originalname).name;
    const result = insert.run(channel.id, file.filename, file.originalname, title, file.mimetype, file.size, kind);
    return db.prepare("SELECT * FROM assets WHERE id = ?").get(result.lastInsertRowid);
  });
  res.status(201).json(items);
});
app.delete("/api/assets/:id", (req, res) => {
  const asset = db.prepare("SELECT a.* FROM assets a JOIN channels c ON c.id = a.channel_id WHERE a.id = ? AND c.organization_id = ?").get(req.params.id, req.user.organization_id);
  if (!asset) return res.status(404).json({ error: "Asset not found." });
  db.prepare("UPDATE channels SET fallback_asset_id = NULL WHERE fallback_asset_id = ?").run(asset.id);
  db.prepare("DELETE FROM assets WHERE id = ?").run(asset.id);
  fs.rmSync(path.join(mediaDir, asset.filename), { force: true });
  res.status(204).end();
});
app.patch("/api/assets/:id/on-demand", (req, res) => {
  const asset = db.prepare("SELECT a.* FROM assets a JOIN channels c ON c.id = a.channel_id WHERE a.id = ? AND c.organization_id = ?").get(req.params.id, req.user.organization_id);
  if (!asset) return res.status(404).json({ error: "Asset not found." });
  const publish = Boolean(req.body.on_demand);
  db.prepare("UPDATE assets SET on_demand = ?, title = ?, description = ?, poster_url = ?, published_at = ? WHERE id = ?")
    .run(publish ? 1 : 0, String(req.body.title || asset.title).trim(), String(req.body.description || ""), String(req.body.poster_url || ""), publish ? new Date().toISOString() : null, asset.id);
  res.json(db.prepare("SELECT * FROM assets WHERE id = ?").get(asset.id));
});
app.get("/api/channels/:id/youtube-programs", ownsChannel, (req, res) => {
  res.json(db.prepare("SELECT * FROM youtube_programs WHERE channel_id = ? ORDER BY published_at DESC").all(req.channel.id));
});
app.post("/api/channels/:id/youtube-programs", ownsChannel, (req, res) => {
  const url = String(req.body.youtube_url || "").trim();
  let videoId = "";
  try {
    const parsed = new URL(url);
    videoId = parsed.hostname.includes("youtu.be") ? parsed.pathname.slice(1) : parsed.searchParams.get("v");
    if (!videoId || !["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(parsed.hostname)) throw new Error();
  } catch { return res.status(400).json({ error: "Enter a valid YouTube video URL." }); }
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Program title is required." });
  const poster = String(req.body.poster_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`).trim();
  const kind = ["program", "promo", "ad", "ident"].includes(req.body.kind) ? req.body.kind : "program";
  const onDemand = req.body.on_demand === false ? 0 : 1;
  const result = db.prepare("INSERT INTO youtube_programs (channel_id, title, description, youtube_url, poster_url, kind, on_demand) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(req.channel.id, title, String(req.body.description || "").trim(), url, poster, kind, onDemand);
  res.status(201).json(db.prepare("SELECT * FROM youtube_programs WHERE id = ?").get(result.lastInsertRowid));
});
app.patch("/api/youtube-programs/:id", (req, res) => {
  const program = req.user.role === "platform_admin"
    ? db.prepare("SELECT y.* FROM youtube_programs y WHERE y.id = ?").get(req.params.id)
    : db.prepare("SELECT y.* FROM youtube_programs y JOIN channels c ON c.id = y.channel_id WHERE y.id = ? AND c.organization_id = ?").get(req.params.id, req.user.organization_id);
  if (!program) return res.status(404).json({ error: "Program not found." });
  db.prepare("UPDATE youtube_programs SET on_demand = ? WHERE id = ?").run(req.body.on_demand ? 1 : 0, program.id);
  res.json(db.prepare("SELECT * FROM youtube_programs WHERE id = ?").get(program.id));
});
app.delete("/api/youtube-programs/:id", (req, res) => {
  const program = req.user.role === "platform_admin"
    ? db.prepare("SELECT y.id FROM youtube_programs y WHERE y.id = ?").get(req.params.id)
    : db.prepare("SELECT y.id FROM youtube_programs y JOIN channels c ON c.id = y.channel_id WHERE y.id = ? AND c.organization_id = ?").get(req.params.id, req.user.organization_id);
  if (!program) return res.status(404).json({ error: "Program not found." });
  db.prepare("DELETE FROM youtube_programs WHERE id = ?").run(program.id);
  res.status(204).end();
});

app.get("/api/channels/:id/schedule", ownsChannel, (req, res) => {
  const local = db.prepare(`
    SELECT s.*, a.original_name, a.kind FROM schedule s
    JOIN assets a ON a.id = s.asset_id WHERE s.channel_id = ?
    ORDER BY s.start_at
  `).all(req.params.id).map(item => ({ ...item, schedule_type: "local", schedule_key: `local-${item.id}` }));
  const youtube = db.prepare(`
    SELECT s.*, y.title AS program_title, y.youtube_url, y.kind
    FROM youtube_schedule s JOIN youtube_programs y ON y.id = s.youtube_program_id
    WHERE s.channel_id = ? ORDER BY s.start_at
  `).all(req.params.id).map(item => ({ ...item, original_name: "YouTube hosted", schedule_type: "youtube", schedule_key: `youtube-${item.id}` }));
  res.json([...local, ...youtube].sort((a, b) => a.start_at.localeCompare(b.start_at)));
});
app.post("/api/channels/:id/schedule", ownsChannel, (req, res) => {
  const { asset_id, youtube_program_id, title, start_at, end_at } = req.body;
  if ((!asset_id && !youtube_program_id) || !start_at || !end_at || new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: "Choose a video and a valid start/end time." });
  }
  if (youtube_program_id) {
    const program = db.prepare("SELECT id, title FROM youtube_programs WHERE id = ? AND channel_id = ?").get(youtube_program_id, req.channel.id);
    if (!program) return res.status(400).json({ error: "Choose a YouTube video from this channel." });
    const result = db.prepare(`
      INSERT INTO youtube_schedule (channel_id, youtube_program_id, title, start_at, end_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, program.id, title || program.title, new Date(start_at).toISOString(), new Date(end_at).toISOString());
    return res.status(201).json(db.prepare("SELECT * FROM youtube_schedule WHERE id = ?").get(result.lastInsertRowid));
  }
  const result = db.prepare(`
    INSERT INTO schedule (channel_id, asset_id, title, start_at, end_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, asset_id, title || "Scheduled program", new Date(start_at).toISOString(), new Date(end_at).toISOString());
  res.status(201).json(db.prepare("SELECT * FROM schedule WHERE id = ?").get(result.lastInsertRowid));
});
app.delete("/api/schedule/:id", (req, res) => {
  const [type, id] = String(req.params.id).split("-");
  if (type === "youtube") {
    const event = db.prepare("SELECT s.id, c.organization_id FROM youtube_schedule s JOIN channels c ON c.id = s.channel_id WHERE s.id = ?").get(id);
    if (!event || (req.user.role !== "platform_admin" && event.organization_id !== req.user.organization_id)) return res.status(404).json({ error: "Program not found." });
    db.prepare("DELETE FROM youtube_schedule WHERE id = ?").run(id);
  } else {
    const localId = type === "local" ? id : req.params.id;
    const event = db.prepare("SELECT s.id, c.organization_id FROM schedule s JOIN channels c ON c.id = s.channel_id WHERE s.id = ?").get(localId);
    if (!event || (req.user.role !== "platform_admin" && event.organization_id !== req.user.organization_id)) return res.status(404).json({ error: "Program not found." });
    db.prepare("DELETE FROM schedule WHERE id = ?").run(localId);
  }
  res.status(204).end();
});

app.post("/api/channels/:id/override", ownsChannel, (req, res) => {
  const type = req.body.type;
  if (!["asset", "youtube"].includes(type)) return res.status(400).json({ error: "Invalid override type." });
  if (type === "youtube") {
    try {
      const url = new URL(req.body.url);
      const host = url.hostname.replace(/^www\./, "");
      if (!["youtube.com", "youtu.be", "m.youtube.com"].includes(host)) throw new Error();
    } catch {
      return res.status(400).json({ error: "Enter a valid YouTube or youtu.be URL." });
    }
  }
  if (type === "asset" && !db.prepare("SELECT id FROM assets WHERE id = ? AND channel_id = ?").get(req.body.asset_id, req.params.id)) {
    return res.status(400).json({ error: "Choose a video from this channel." });
  }
  db.prepare("UPDATE overrides SET active = 0, stopped_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND active = 1").run(req.params.id);
  const label = String(req.body.label || (type === "youtube" ? "YouTube Live override" : "Video override")).trim();
  const result = db.prepare(`
    INSERT INTO overrides (channel_id, type, asset_id, url, label) VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, type, req.body.asset_id || null, req.body.url || null, label);
  playout.reconcile();
  res.status(201).json(db.prepare("SELECT * FROM overrides WHERE id = ?").get(result.lastInsertRowid));
});
app.delete("/api/channels/:id/override", ownsChannel, (req, res) => {
  db.prepare("UPDATE overrides SET active = 0, stopped_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND active = 1").run(req.params.id);
  playout.reconcile();
  res.status(204).end();
});
app.post("/api/channels/:id/output/:action", ownsChannel, (req, res) => {
  const enabled = req.params.action === "start" ? 1 : 0;
  if (!["start", "stop"].includes(req.params.action)) return res.status(400).json({ error: "Invalid action." });
  db.prepare("UPDATE channels SET output_enabled = ? WHERE id = ?").run(enabled, req.params.id);
  if (!enabled) playout.stop(req.params.id);
  else playout.reconcile();
  res.json(playout.status(req.params.id));
});
app.get("/api/channels/:id/status", ownsChannel, (req, res) => res.json(playout.status(req.params.id)));

app.get("/api/partners", requireOwner, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.active, o.id AS organization_id, o.name AS organization_name, o.slug, o.plan,
      (SELECT COUNT(*) FROM channels c WHERE c.organization_id = o.id) AS channel_count
    FROM users u JOIN organizations o ON o.id = u.organization_id ORDER BY o.created_at DESC
  `).all());
});
app.post("/api/partners", requireOwner, (req, res) => {
  const name = String(req.body.company_name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !email || password.length < 10) return res.status(400).json({ error: "Company, email, and a password of at least 10 characters are required." });
  const slug = String(req.body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const transaction = db.transaction(() => {
    const org = db.prepare("INSERT INTO organizations (name, slug, plan) VALUES (?, ?, ?)").run(name, slug, req.body.plan || "partner");
    const user = db.prepare("INSERT INTO users (organization_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
      .run(org.lastInsertRowid, req.body.contact_name || name, email, bcrypt.hashSync(password, 12));
    const channel = db.prepare("INSERT INTO channels (name, slug, description, organization_id) VALUES (?, ?, ?, ?)").run(`${name} One`, `${slug}-one`, "Primary channel", org.lastInsertRowid);
    return { organization_id: Number(org.lastInsertRowid), user_id: Number(user.lastInsertRowid), channel_id: Number(channel.lastInsertRowid), slug };
  });
  try { res.status(201).json(transaction()); } catch (error) { res.status(400).json({ error: error.message.includes("UNIQUE") ? "That email or company URL is already in use." : error.message }); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || "Unexpected server error." });
});

const port = Number(process.env.PORT || 4173);
if (require.main === module) {
  app.listen(port, () => console.log(`TMCast TV is ready at http://localhost:${port}`));
}

module.exports = app;
