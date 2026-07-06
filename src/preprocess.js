//! preprocess.js — offline per-track audio processing + cache.
//!
//! Processing audio LIVE in the stream path stalls/starves on a CPU-constrained box, so
//! instead we bake the Spectra chain into a CACHED COPY of each track and let AutoDJ
//! stream that copy. Zero live ffmpeg in the audio path → no stalls, no starving, no dead
//! air. Originals in media/ are never touched; the cache is keyed by a hash of the
//! settings, so changing the preset transparently re-processes into a new cache dir and
//! AutoDJ keeps streaming the old (or the untouched original) until the new one is ready.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { buildFilterGraph } = require('./airchain');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const MEDIA_DIR = VOLUME ? path.join(VOLUME, 'media') : path.join(__dirname, '..', 'media');
const PROCESSED_DIR = VOLUME ? path.join(VOLUME, 'media_processed') : path.join(__dirname, '..', 'media_processed');

/** Stable short hash of the audio-affecting settings — identical settings reuse the cache. */
function presetHash(settings) {
  const s = settings || {};
  const key = JSON.stringify({ q: s.quickTweak, c: s.clipper, f: s.freq, w: s.wideband, o: s.outputGainDb, p: s.preampDb });
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

const stationCacheDir = (stationId, hash) => path.join(PROCESSED_DIR, stationId, hash);

/** Where the processed variant of `filename` lives for this station + preset. */
function processedPathFor(stationId, filename, settings) {
  return path.join(stationCacheDir(stationId, presetHash(settings)), filename);
}

/** The processed file path if it EXISTS and processing is enabled, else null (→ use original). */
function resolveProcessed(stationId, filename, settings) {
  if (!settings || !settings.enabled) return null;
  const p = processedPathFor(stationId, filename, settings);
  try { if (fs.existsSync(p) && fs.statSync(p).size > 1024) return p; } catch {}
  return null;
}

/** Process one file (src → dest) through the offline (fuller) chain. Atomic + non-destructive. */
async function processFile(srcPath, destPath, settings) {
  const graph = buildFilterGraph(settings, { offline: true });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + '.tmp.mp3';
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', srcPath,
    '-af', graph, '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2', tmp,
  ], { timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  fs.renameSync(tmp, destPath); // atomic swap — AutoDJ never opens a half-written file
}

// ── Background batch: process a station's whole library for the current preset ──
const jobs = new Map(); // stationId -> { total, done, running, hash, startedAt }
const getJob = (stationId) => jobs.get(stationId) || null;

/**
 * Process every track in `mediaRows` ([{filename}]) for the station, sequentially (one
 * ffmpeg at a time so it never floods the CPU). Skips already-processed files, so it's
 * cheap to re-run. AutoDJ streams originals until each processed file lands.
 */
async function processLibrary(stationId, settings, mediaRows, broadcast) {
  if (!settings || !settings.enabled) return;
  const hash = presetHash(settings);
  const existing = jobs.get(stationId);
  if (existing && existing.running && existing.hash === hash) return; // already running for this preset

  const job = { total: mediaRows.length, done: 0, running: true, hash, startedAt: Date.now() };
  jobs.set(stationId, job);
  cleanupOtherHashes(stationId, hash);
  console.log(`  ⚙ Pre-processing ${mediaRows.length} tracks for ${stationId} (${hash})`);

  for (const m of mediaRows) {
    const cur = jobs.get(stationId);
    if (!cur || cur.hash !== hash) break; // superseded by a newer preset
    const src = path.join(MEDIA_DIR, m.filename);
    const dest = processedPathFor(stationId, m.filename, settings);
    try {
      let have = false;
      try { have = fs.existsSync(dest) && fs.statSync(dest).size > 1024; } catch {}
      if (!have && fs.existsSync(src)) await processFile(src, dest, settings);
    } catch (e) { console.log(`  ⚠ preprocess ${m.filename}: ${(e.message || '').split('\n')[0]}`); }
    job.done++;
    if (broadcast && job.done % 3 === 0) broadcast('processing_progress', { stationId, done: job.done, total: job.total });
  }
  job.running = false;
  if (broadcast) broadcast('processing_progress', { stationId, done: job.done, total: job.total, complete: true });
  console.log(`  ✓ Pre-processing complete for ${stationId}: ${job.done}/${job.total}`);
}

/** Delete stale preset caches for a station, keeping only the current hash (bounds disk). */
function cleanupOtherHashes(stationId, keepHash) {
  try {
    const base = path.join(PROCESSED_DIR, stationId);
    if (!fs.existsSync(base)) return;
    for (const d of fs.readdirSync(base)) {
      if (d !== keepHash) fs.rmSync(path.join(base, d), { recursive: true, force: true });
    }
  } catch {}
}

/** Remove ALL processed cache for a station (on disable / delete). */
function clearStation(stationId) {
  try { fs.rmSync(path.join(PROCESSED_DIR, stationId), { recursive: true, force: true }); } catch {}
  jobs.delete(stationId);
}

module.exports = { presetHash, processedPathFor, resolveProcessed, processFile, processLibrary, getJob, clearStation, PROCESSED_DIR, MEDIA_DIR };
