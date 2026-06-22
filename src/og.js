// Social share card (Open Graph image) for the player page.
// Left: album cover + now-playing. Right: TMCast logo + "Listen on the web".
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// Bundle a font so text renders on minimal containers (no system fonts)
try { GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'fonts', 'Inter-SemiBold.ttf'), 'Inter'); } catch {}
const FONT = GlobalFonts.has && GlobalFonts.has('Inter') ? 'Inter' : 'sans-serif';

const W = 1200, H = 630;
const ACCENT = '#7C4DFF';

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line); line = w;
      if (lines.length === maxLines - 1) break;
    } else { line = test; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // ellipsize the last line if there's overflow
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(last + '…').width > maxWidth && last.length > 1) last = last.slice(0, -1);
    if (last !== lines[maxLines - 1]) lines[maxLines - 1] = last + '…';
  }
  return lines;
}

// Draw an image cropped to cover a square box
function drawCover(ctx, img, x, y, size, radius) {
  ctx.save();
  roundRectPath(ctx, x, y, size, size, radius);
  ctx.clip();
  const scale = Math.max(size / img.width, size / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
  ctx.restore();
}

async function renderShareCard({ coverBuf, logoBuf, stationName, title, artist, genre, url }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  let coverImg = null;
  if (coverBuf) { try { coverImg = await loadImage(coverBuf); } catch {} }

  // ── Background: art as a soft, blurred texture under a deep-purple wash ──
  ctx.fillStyle = '#0c0918';
  ctx.fillRect(0, 0, W, H);
  if (coverImg) {
    ctx.save();
    try { ctx.filter = 'blur(60px)'; } catch {}
    const scale = Math.max(W / coverImg.width, H / coverImg.height) * 1.2;
    const dw = coverImg.width * scale, dh = coverImg.height * scale;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(coverImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  }
  // Deep purple gradient overlay so the brand colour always dominates
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, 'rgba(26,11,46,0.86)');
  grad.addColorStop(0.55, 'rgba(14,11,26,0.92)');
  grad.addColorStop(1, 'rgba(8,6,18,0.97)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // accent glow
  const glow = ctx.createRadialGradient(260, 120, 40, 260, 120, 720);
  glow.addColorStop(0, 'rgba(124,77,255,0.30)');
  glow.addColorStop(1, 'rgba(124,77,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ── Left: crisp album cover ──
  const COVER = 380, CX = 80, CY = 125;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 60; ctx.shadowOffsetY = 24;
  roundRectPath(ctx, CX, CY, COVER, COVER, 30);
  ctx.fillStyle = '#1c1830';
  ctx.fill();
  ctx.restore();
  if (coverImg) {
    drawCover(ctx, coverImg, CX, CY, COVER, 30);
  } else {
    // Draw a simple music-note glyph with paths (the bundled font has no ♪)
    const mx = CX + COVER / 2, my = CY + COVER / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(mx - 26, my + 34); ctx.lineTo(mx - 26, my - 44); ctx.stroke(); // left stem
    ctx.beginPath(); ctx.moveTo(mx + 40, my + 22); ctx.lineTo(mx + 40, my - 56); ctx.stroke(); // right stem
    ctx.beginPath(); ctx.moveTo(mx - 26, my - 44); ctx.lineTo(mx + 40, my - 56); ctx.stroke(); // beam
    ctx.beginPath(); ctx.ellipse(mx - 38, my + 34, 18, 13, -0.3, 0, Math.PI * 2); ctx.fill(); // left head
    ctx.beginPath(); ctx.ellipse(mx + 28, my + 22, 18, 13, -0.3, 0, Math.PI * 2); ctx.fill(); // right head
    ctx.restore();
  }
  // subtle inner border on the cover
  ctx.save();
  roundRectPath(ctx, CX, CY, COVER, COVER, 30);
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.stroke();
  ctx.restore();

  // ── Right column ──
  const RX = 540;
  ctx.textAlign = 'left';

  // brand row (logo + wordmark)
  if (logoBuf) {
    try {
      const logo = await loadImage(logoBuf);
      ctx.save();
      roundRectPath(ctx, RX, 92, 52, 52, 13);
      ctx.clip();
      ctx.drawImage(logo, RX, 92, 52, 52);
      ctx.restore();
    } catch {}
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `32px ${FONT}`;
  ctx.fillText('TMCast', RX + 66, 127);

  // LIVE RADIO label + mini equaliser bars
  ctx.fillStyle = ACCENT;
  ctx.font = `22px ${FONT}`;
  ctx.fillText('LIVE RADIO', RX + 26, 246);
  const barH = [16, 26, 12, 22];
  barH.forEach((h, i) => { ctx.fillRect(RX + i * 7, 238 - h + 14, 4, h); });

  // Station name — the hero (stays correct even when a platform caches the card)
  ctx.fillStyle = '#ffffff';
  ctx.font = `66px ${FONT}`;
  const sLines = wrapText(ctx, stationName || 'TMCast', W - RX - 70, 2);
  let sy = 322;
  for (const l of sLines) { ctx.fillText(l, RX, sy); sy += 74; }

  // tagline / genre
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `26px ${FONT}`;
  ctx.fillText(genre ? `${genre} · streaming now` : 'Streaming now on TMCast', RX, sy + 6);

  // CTA pill
  const pillY = 470;
  const pillText = 'Listen on the TMCast website';
  ctx.font = `27px ${FONT}`;
  const pillW = ctx.measureText(pillText).width + 92;
  ctx.save();
  ctx.shadowColor = 'rgba(124,77,255,0.5)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 8;
  ctx.fillStyle = ACCENT;
  roundRectPath(ctx, RX, pillY, pillW, 62, 31);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(RX + 30, pillY + 21); ctx.lineTo(RX + 30, pillY + 41); ctx.lineTo(RX + 48, pillY + 31);
  ctx.closePath(); ctx.fill();
  ctx.font = `27px ${FONT}`;
  ctx.fillText(pillText, RX + 62, pillY + 40);

  // url
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `23px ${FONT}`;
  ctx.fillText(url || 'cast.tmc.gg', RX, pillY + 106);

  return canvas.encode('png');
}

module.exports = { renderShareCard };
