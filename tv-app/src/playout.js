const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { db } = require("./db");
const { decrypt } = require("./credentials");

const root = path.resolve(__dirname, "..");

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error;
}

class PlayoutManager {
  constructor() {
    this.sessions = new Map();
    this.ffmpegAvailable = commandExists("ffmpeg");
    this.ytDlpAvailable = commandExists("yt-dlp");
    this.timer = setInterval(() => this.reconcile(), 5000);
    this.reconcile();
  }

  getSource(channelId) {
    const override = db.prepare(`
      SELECT o.*, a.filename, a.title AS asset_title
      FROM overrides o LEFT JOIN assets a ON a.id = o.asset_id
      WHERE o.channel_id = ? AND o.active = 1
      ORDER BY o.id DESC LIMIT 1
    `).get(channelId);
    if (override) {
      return override.type === "youtube"
        ? { key: `override:youtube:${override.id}`, type: "youtube", label: override.label, url: override.url }
        : { key: `override:asset:${override.asset_id}`, type: "asset", label: override.asset_title, filename: override.filename };
    }

    const now = new Date().toISOString();
    const youtubeScheduled = db.prepare(`
      SELECT s.id, s.title, y.youtube_url
      FROM youtube_schedule s JOIN youtube_programs y ON y.id = s.youtube_program_id
      WHERE s.channel_id = ? AND s.start_at <= ? AND s.end_at > ?
      ORDER BY s.start_at DESC LIMIT 1
    `).get(channelId, now, now);
    if (youtubeScheduled) {
      return { key: `youtube-schedule:${youtubeScheduled.id}`, type: "youtube", label: youtubeScheduled.title, url: youtubeScheduled.youtube_url };
    }
    const scheduled = db.prepare(`
      SELECT s.id, s.title, a.id AS asset_id, a.filename
      FROM schedule s JOIN assets a ON a.id = s.asset_id
      WHERE s.channel_id = ? AND s.start_at <= ? AND s.end_at > ?
      ORDER BY s.start_at DESC LIMIT 1
    `).get(channelId, now, now);
    if (scheduled) {
      return { key: `schedule:${scheduled.id}`, type: "asset", label: scheduled.title, filename: scheduled.filename };
    }

    const channel = db.prepare("SELECT auto_tv_enabled, auto_tv_slot_minutes FROM channels WHERE id = ?").get(channelId);
    if (channel?.auto_tv_enabled) {
      const youtubePrograms = db.prepare(`
        SELECT id, title, youtube_url, duration_seconds FROM youtube_programs
        WHERE channel_id = ? AND kind IN ('program', 'promo', 'ident')
        ORDER BY id
      `).all(channelId);
      if (youtubePrograms.length) {
        const fallbackSeconds = Math.max(60, (Number(channel.auto_tv_slot_minutes) || 5) * 60);
        const durations = youtubePrograms.map(program => Math.max(10, Number(program.duration_seconds) || fallbackSeconds));
        const cycleSeconds = durations.reduce((sum, duration) => sum + duration, 0);
        const clock = Math.floor(Date.now() / 1000);
        const cycle = Math.floor(clock / cycleSeconds);
        let position = clock % cycleSeconds;
        let index = 0;
        while (index < durations.length - 1 && position >= durations[index]) {
          position -= durations[index];
          index++;
        }
        const program = youtubePrograms[index];
        return {
          key: `auto-tv:${cycle}:${program.id}`,
          type: "youtube",
          label: program.title,
          url: program.youtube_url,
          startSeconds: position,
          durationSeconds: durations[index],
          autoTv: true
        };
      }
    }

    const fallback = db.prepare(`
      SELECT a.id, a.title, a.filename FROM channels c
      LEFT JOIN assets a ON a.id = c.fallback_asset_id
      WHERE c.id = ?
    `).get(channelId);
    return fallback?.id
      ? { key: `fallback:${fallback.id}`, type: "asset", label: fallback.title, filename: fallback.filename, loop: true }
      : { key: "off-air", type: "off-air", label: "Off air" };
  }

  status(channelId) {
    const source = this.getSource(channelId);
    const session = this.sessions.get(Number(channelId));
    const channel = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
    let streamKey = "";
    try { streamKey = channel ? decrypt(channel.stream_key_encrypted) : ""; } catch { streamKey = ""; }
    return {
      source,
      outputRequested: Boolean(channel?.output_enabled),
      starting: Boolean(session?.starting),
      streaming: Boolean(session?.ffmpeg && session.ffmpeg.exitCode === null && !session.ffmpeg.killed),
      ffmpegAvailable: this.ffmpegAvailable,
      ytDlpAvailable: this.ytDlpAvailable,
      streamKeyConfigured: Boolean(streamKey),
      lastError: session?.lastError || null,
      logs: session?.logs || []
    };
  }

  stop(channelId, preserve = false) {
    const id = Number(channelId);
    const session = this.sessions.get(id);
    if (session?.resolver && session.resolver.exitCode === null && !session.resolver.killed) session.resolver.kill("SIGTERM");
    if (session?.ffmpeg && session.ffmpeg.exitCode === null && !session.ffmpeg.killed) session.ffmpeg.kill("SIGTERM");
    if (session) {
      session.starting = false;
      session.retryAt = 0;
    }
    if (!preserve) this.sessions.delete(id);
  }

  start(channel, source) {
    let streamKey = "";
    try { streamKey = decrypt(channel.stream_key_encrypted); } catch { return; }
    if (!this.ffmpegAvailable || !streamKey || source.type === "off-air") return;

    const baseOutput = channel.rtmp_url || process.env.YOUTUBE_RTMP_URL || "rtmps://a.rtmps.youtube.com/live2";
    const output = `${baseOutput.replace(/\/$/, "")}/${streamKey}`;
    const session = { sourceKey: source.key, ffmpeg: null, resolver: null, logs: [], lastError: null, starting: true, retryAt: 0 };
    const record = chunk => {
      const line = String(chunk).trim();
      if (line) session.logs = [...session.logs.slice(-7), line.slice(-400)];
    };
    this.sessions.set(channel.id, session);

    const startFfmpeg = inputArgs => {
      if (this.sessions.get(channel.id) !== session) return;
      const args = [
        "-hide_banner", "-loglevel", "warning", ...inputArgs,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-pix_fmt", "yuv420p", "-r", "30", "-g", "60",
        "-b:v", "4500k", "-maxrate", "4500k", "-bufsize", "9000k",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
        "-f", "flv", output
      ];
      session.ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      session.starting = false;
      session.ffmpeg.stderr.on("data", record);
      session.ffmpeg.on("error", error => {
        session.lastError = error.message;
        session.retryAt = Date.now() + 30000;
      });
      session.ffmpeg.on("exit", code => {
        if (code && code !== 143) session.lastError = `FFmpeg exited with code ${code}. ${session.logs.at(-1) || ""}`.trim();
        session.retryAt = Date.now() + 30000;
      });
    };

    if (source.type !== "youtube") {
      const file = path.join(root, "media", source.filename);
      return startFfmpeg([...(source.loop ? ["-stream_loop", "-1"] : []), "-re", "-i", file]);
    }
    if (!this.ytDlpAvailable) {
      session.starting = false;
      session.lastError = "yt-dlp is not installed.";
      return;
    }

    const projectRoot = path.resolve(root, "..");
    const attempts = [
      { name: "embedded", args: ["--extractor-args", "youtube:player_client=web_embedded"] },
      { name: "HLS", args: ["--extractor-args", "youtube:player_client=web_safari"] },
      {
        name: "PO token",
        args: [
          "--plugin-dirs", path.join(projectRoot, ".bgutil-ytdlp-pot-provider.zip"),
          "--extractor-args", "youtube:player_client=mweb",
          "--extractor-args", `youtubepot-bgutilscript:server_home=${path.join(projectRoot, ".bgutil-provider", "server")}`
        ]
      }
    ];
    const resolveAttempt = index => {
      if (this.sessions.get(channel.id) !== session) return;
      const attempt = attempts[index];
      let resolved = "";
      session.logs = [...session.logs, `Trying YouTube ${attempt.name} resolver...`].slice(-8);
      session.resolver = spawn("yt-dlp", [
        "--no-playlist", "--no-warnings", "-f", "best[ext=mp4]/best", "-g",
        ...attempt.args, source.url
      ], { stdio: ["ignore", "pipe", "pipe"] });
      session.resolver.stdout.on("data", chunk => { resolved += String(chunk); });
      session.resolver.stderr.on("data", record);
      session.resolver.on("error", error => {
        session.starting = false;
        session.lastError = `YouTube resolver failed: ${error.message}`;
        session.retryAt = Date.now() + 30000;
      });
      session.resolver.on("exit", code => {
        if (this.sessions.get(channel.id) !== session) return;
        const directUrl = resolved.split(/\r?\n/).find(Boolean);
        if ((code || !directUrl) && index < attempts.length - 1) return resolveAttempt(index + 1);
        if (code || !directUrl) {
          session.starting = false;
          session.lastError = `All YouTube resolvers failed. ${session.logs.at(-1) || ""}`.trim();
          session.retryAt = Date.now() + 30000;
          return;
        }
        const seek = Math.max(0, Math.floor(Number(source.startSeconds) || 0));
        startFfmpeg(["-re", ...(seek ? ["-ss", String(seek)] : []), "-i", directUrl]);
      });
    };
    resolveAttempt(0);
  }

  reconcile() {
    for (const channel of db.prepare("SELECT * FROM channels").all()) {
      const source = this.getSource(channel.id);
      const session = this.sessions.get(channel.id);
      if (!channel.output_enabled || source.type === "off-air") {
        if (session?.ffmpeg || session?.resolver) this.stop(channel.id, true);
        continue;
      }
      const running = session?.ffmpeg && session.ffmpeg.exitCode === null && !session.ffmpeg.killed;
      if (!session || session.sourceKey !== source.key) {
        this.stop(channel.id);
        this.start(channel, source);
      } else if (!session.starting && !running && Date.now() >= (session.retryAt || 0)) {
        this.stop(channel.id);
        this.start(channel, source);
      }
    }
  }
}

module.exports = new PlayoutManager();
