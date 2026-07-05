//! airchain.js — build an ffmpeg audio filtergraph from Spectra `ProcessorSettings`.
//!
//! TMCast streams pre-encoded MP3, so the live "air chain" is an ffmpeg process that
//! decodes → filters → re-encodes each station's audio in real time (see StreamEngine).
//! This module maps the SUBSET of ProcessorSettings that ffmpeg's stock filters can honor:
//!   preamp · input HPF/LPF · wideband leveling (AGC) · the QuickTweak tone/dynamics/
//!   loudness/width macros · final ceiling · output gain.
//! The richer Spectra stages (per-band multiband AGC, dyn-EQ, the "Edge" bass-clipper
//! character, exciters, sub-harmonic, the named enhancers) need the full Rust Spectra
//! engine and are intentionally ignored here — the GUI still stores them so a future
//! Spectra engine can consume the same payload.

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+x) ? +x : lo));
// A QuickTweak macro is 0..10, neutral 5 → map to a -1..+1 deviation around neutral.
const dev = v => clamp((Number(v ?? 5) - 5) / 5, -1, 1);

/**
 * @param {object} s  a ProcessorSettings object (from the Spectra GUI)
 * @returns {string}  an ffmpeg `-af` filterchain, or "" for a true bypass
 */
function buildFilterGraph(s = {}) {
  const qt = s.quickTweak || {};
  const F = [];

  // 1) Pre-amp
  const pre = clamp(s.preampDb || 0, -24, 24);
  if (Math.abs(pre) > 0.05) F.push(`volume=${pre.toFixed(2)}dB`);

  // 2) Subsonic / input band-pass
  let hp = 30;
  if (s.freq && s.freq.inputFilter && s.freq.highpassHz) hp = clamp(s.freq.highpassHz, 10, 300);
  F.push(`highpass=f=${Math.round(hp)}`);
  if (s.freq && s.freq.inputFilter && s.freq.lowpassHz && s.freq.lowpassHz > 1000)
    F.push(`lowpass=f=${Math.round(clamp(s.freq.lowpassHz, 3000, 20000))}`);

  // 3) Wideband leveler (slow AGC) — dynaudnorm lifts quiet passages toward a steady level
  if (!s.wideband || s.wideband.enabled !== false) {
    const maxg = clamp(Math.pow(10, (s.wideband?.maxGainDb ?? 12) / 20), 1.5, 30);
    F.push(`dynaudnorm=f=250:g=31:p=0.95:m=${maxg.toFixed(1)}:r=0.0`);
  }

  // 4) Tone — QuickTweak bass / mid / treble macros as parametric bands
  const eq = (f, w, g) => { if (Math.abs(g) > 0.15) F.push(`equalizer=f=${f}:width_type=q:w=${w}:g=${g.toFixed(2)}`); };
  eq(45,    1.2, dev(qt.subBass) * 7);          // sub
  eq(80,    1.0, dev(qt.bassThump) * 6);        // thump
  eq(120,   0.8, dev(qt.bassOverall) * 6);      // low body
  eq(200,   1.2, dev(qt.bassGrowl) * 5);        // growl
  eq(900,   1.0, dev(qt.midOverall) * 5);       // mids
  eq(3000,  1.4, dev(qt.treblePresence) * 5);   // presence
  eq(6500,  1.0, dev(qt.trebleBrightness) * 5); // brightness
  eq(10000, 1.0, dev(qt.trebleSparkle) * 5);    // sparkle
  eq(14000, 0.8, dev(qt.airBand) * 5);          // air
  // Warmth — low-mid body up, a touch of harshness down
  const warm = dev(qt.warm);
  if (Math.abs(warm) > 0.15) {
    F.push(`equalizer=f=250:width_type=q:w=1.2:g=${(warm * 4).toFixed(2)}`);
    if (warm > 0) F.push(`equalizer=f=3500:width_type=q:w=2:g=${(-warm * 2).toFixed(2)}`);
  }

  // 5) Compression — density (ratio/threshold) + punch (attack shaping) + phat glue
  const density = dev(qt.density), punch = dev(qt.punch), phat = dev(qt.phat);
  if (density > -0.6 || phat > 0.15) {
    const ratio = clamp(2 + density * 3 + Math.max(0, phat) * 1.5, 1.2, 8);
    const thr   = clamp(-12 - density * 10, -30, -6);
    const atk   = clamp(20 - punch * 15, 3, 40);   // punchier → slower attack keeps transients
    const rel   = clamp(180 + punch * 120, 60, 400);
    const mk    = clamp(density * 3 + 1, 0, 8);
    F.push(`acompressor=threshold=${thr.toFixed(1)}dB:ratio=${ratio.toFixed(1)}:attack=${atk.toFixed(0)}:release=${rel.toFixed(0)}:makeup=${mk.toFixed(1)}dB:knee=6`);
  }

  // 6) Stereo width (5→1.0 normal, 10→1.8 wide, 0→0.2 near-mono)
  const width = clamp(1 + dev(qt.stereoWidth) * 0.8, 0, 2);
  if (Math.abs(width - 1) > 0.03) F.push(`stereotools=mlev=1:slev=${width.toFixed(2)}`);

  // 7) Loudness drive → true-peak brickwall. Driving into the limiter is the "loud radio"
  //    lever — loudnessOverall plus the FM-clip / limiter-drive macros push harder.
  const drive = clamp(dev(qt.loudnessOverall) * 9 + Math.max(0, dev(qt.fmClipDrive)) * 4 + Math.max(0, dev(qt.limDrive)) * 3, -6, 15);
  if (Math.abs(drive) > 0.1) F.push(`volume=${drive.toFixed(2)}dB`);
  const ceil = clamp(Math.pow(10, (s.clipper?.ceilingDb ?? -1) / 20), 0.3, 0.999);
  F.push(`alimiter=limit=${ceil.toFixed(4)}:attack=5:release=50:level=disabled:asc=1`);

  // 8) Output make-up gain
  const out = clamp(s.outputGainDb || 0, -24, 24);
  if (Math.abs(out) > 0.05) F.push(`volume=${out.toFixed(2)}dB`);

  // Safety brickwall so nothing ever leaves above full scale
  F.push('alimiter=limit=0.995:attack=1:release=20:level=disabled');

  return F.join(',');
}

module.exports = { buildFilterGraph };
