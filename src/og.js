// Social share card (Open Graph image) for the player page.
// Left: album cover + now-playing. Right: CiryaCast logo + "Listen on the web".
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

async function renderShareCard({ coverBuf, logoBuf, stationName, title, artist }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0e0b1a';
  ctx.fillRect(0, 0, W, H);
  // faint top accent wash (flat radial, subtle)
  const glow = ctx.createRadialGradient(300, -120, 50, 300, -120, 700);
  glow.addColorStop(0, 'rgba(124,77,255,0.22)');
  glow.addColorStop(1, 'rgba(124,77,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ── Left: cover art ──
  const COVER = 400, CX = 80, CY = 115;
  let coverImg = null;
  if (coverBuf) { try { coverImg = await loadImage(coverBuf); } catch {} }
  // soft shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 50; ctx.shadowOffsetY = 20;
  roundRectPath(ctx, CX, CY, COVER, COVER, 28);
  ctx.fillStyle = '#1c1830';
  ctx.fill();
  ctx.restore();
  if (coverImg) {
    drawCover(ctx, coverImg, CX, CY, COVER, 28);
  } else {
    // placeholder music note
    ctx.fillStyle = '#3a3357';
    ctx.font = `120px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('♪', CX + COVER / 2, CY + COVER / 2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // Track title + artist under the cover
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `34px ${FONT}`;
  const tLines = wrapText(ctx, title || 'Live Radio', COVER, 1);
  ctx.fillText(tLines[0], CX, CY + COVER + 52);
  if (artist) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `26px ${FONT}`;
    const aLine = wrapText(ctx, artist, COVER, 1);
    ctx.fillText(aLine[0], CX, CY + COVER + 90);
  }

  // ── Right: brand + call to action ──
  const RX = 560;
  // logo
  if (logoBuf) {
    try {
      const logo = await loadImage(logoBuf);
      ctx.save();
      roundRectPath(ctx, RX, 95, 64, 64, 14);
      ctx.clip();
      ctx.drawImage(logo, RX, 95, 64, 64);
      ctx.restore();
    } catch {}
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = `40px ${FONT}`;
  ctx.fillText('CiryaCast', RX + 80, 140);

  // NOW PLAYING ON
  ctx.fillStyle = ACCENT;
  ctx.font = `22px ${FONT}`;
  ctx.fillText('● LIVE RADIO', RX, 250);

  // Station name (big)
  ctx.fillStyle = '#ffffff';
  ctx.font = `64px ${FONT}`;
  const sLines = wrapText(ctx, stationName || 'CiryaCast', W - RX - 70, 2);
  let sy = 320;
  for (const l of sLines) { ctx.fillText(l, RX, sy); sy += 72; }

  // CTA pill
  const pillY = Math.max(sy + 24, 470);
  const pillText = 'Listen on the CiryaCast website';
  ctx.font = `28px ${FONT}`;
  const pillW = ctx.measureText(pillText).width + 96;
  ctx.fillStyle = ACCENT;
  roundRectPath(ctx, RX, pillY, pillW, 64, 32);
  ctx.fill();
  // play triangle
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(RX + 32, pillY + 22);
  ctx.lineTo(RX + 32, pillY + 42);
  ctx.lineTo(RX + 50, pillY + 32);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `28px ${FONT}`;
  ctx.fillText(pillText, RX + 66, pillY + 41);

  // url
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `24px ${FONT}`;
  ctx.fillText('cast.tmc.gg', RX, pillY + 110);

  return canvas.encode('png');
}

module.exports = { renderShareCard };
