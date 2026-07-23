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

const upload = multer({
  storage: multer.diskStorage({
    destination: mediaDir,
    filename: (_req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("video/") || file.mimetype.startsWith("audio/"))
});

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use("/media", express.static(mediaDir, { acceptRanges: true, cacheControl: true, maxAge: "1h" }));
app.use(express.static(path.join(root, "public")));
app.get("/control", (_req, res) => res.sendFile(path.join(root, "public", "control.html")));
app.get(/^\/watch\/[^/]+(?:\/\d+)?$/, (_req, res) => res.sendFile(path.join(root, "public", "watch.html")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

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
  const channel = db.prepare("SELECT * FROM channels WHERE id = ? AND organization_id = ?").get(id, req.user.organization_id);
  if (!channel) return res.status(404).json({ error: "Channel not found." });
  req.channel = channel;
  next();
};

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
  `).all(organization.id).map(channel => ({
    ...channel,
    is_live: Boolean(channel.output_enabled && channel.public_live_url),
    now_playing: playout.getSource(channel.id).label
  }));
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
    WHERE c.organization_id = ? ORDER BY y.published_at DESC
  `).all(organization.id).map(program => ({ ...program, playback_type: "youtube" }));
  res.json({ organization, channels, programs: [...youtubePrograms, ...programs].sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))) });
});

app.use("/api", requireAuth);
app.get("/api/channels", (_req, res) => {
  const channels = db.prepare("SELECT * FROM channels WHERE organization_id = ? ORDER BY id").all(_req.user.organization_id);
  res.json(channels.map(({ stream_key_encrypted, ...channel }) => ({
    ...channel,
    stream_key_configured: Boolean(stream_key_encrypted),
    status: playout.status(channel.id)
  })));
});
app.get("/api/organizations", requireOwner, (_req, res) => {
  res.json(db.prepare("SELECT id, name, slug, plan, active FROM organizations ORDER BY name").all());
});
app.post("/api/channels", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Channel name is required." });
  const slug = String(req.body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const organizationId = req.user.role === "platform_admin" && req.body.organization_id
    ? Number(req.body.organization_id)
    : req.user.organization_id;
  if (!db.prepare("SELECT id FROM organizations WHERE id = ? AND active = 1").get(organizationId)) {
    return res.status(400).json({ error: "Choose an active company." });
  }
  try {
    const result = db.prepare("INSERT INTO channels (name, slug, description, organization_id) VALUES (?, ?, ?, ?)").run(name, slug, req.body.description || "", organizationId);
    res.status(201).json(db.prepare("SELECT * FROM channels WHERE id = ?").get(result.lastInsertRowid));
  } catch (error) {
    res.status(400).json({ error: error.message.includes("UNIQUE") ? "That channel slug already exists." : error.message });
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
  const result = db.prepare("INSERT INTO youtube_programs (channel_id, title, description, youtube_url, poster_url) VALUES (?, ?, ?, ?, ?)")
    .run(req.channel.id, title, String(req.body.description || "").trim(), url, poster);
  res.status(201).json(db.prepare("SELECT * FROM youtube_programs WHERE id = ?").get(result.lastInsertRowid));
});
app.delete("/api/youtube-programs/:id", (req, res) => {
  const program = db.prepare("SELECT y.id FROM youtube_programs y JOIN channels c ON c.id = y.channel_id WHERE y.id = ? AND c.organization_id = ?").get(req.params.id, req.user.organization_id);
  if (!program) return res.status(404).json({ error: "Program not found." });
  db.prepare("DELETE FROM youtube_programs WHERE id = ?").run(program.id);
  res.status(204).end();
});

app.get("/api/channels/:id/schedule", ownsChannel, (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, a.original_name, a.kind FROM schedule s
    JOIN assets a ON a.id = s.asset_id WHERE s.channel_id = ?
    ORDER BY s.start_at
  `).all(req.params.id));
});
app.post("/api/channels/:id/schedule", ownsChannel, (req, res) => {
  const { asset_id, title, start_at, end_at } = req.body;
  if (!asset_id || !start_at || !end_at || new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: "Choose a video and a valid start/end time." });
  }
  const result = db.prepare(`
    INSERT INTO schedule (channel_id, asset_id, title, start_at, end_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, asset_id, title || "Scheduled program", new Date(start_at).toISOString(), new Date(end_at).toISOString());
  res.status(201).json(db.prepare("SELECT * FROM schedule WHERE id = ?").get(result.lastInsertRowid));
});
app.delete("/api/schedule/:id", (req, res) => {
  db.prepare("DELETE FROM schedule WHERE id = ?").run(req.params.id);
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
