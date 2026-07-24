const viewerState = { data: null };
const BASE_PATH = location.pathname.startsWith("/tv") ? "/tv" : "";
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value || "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));

function youtubeEmbed(url) {
  try {
    const parsed = new URL(url);
    const id = parsed.hostname.includes("youtu.be") ? parsed.pathname.slice(1) : parsed.searchParams.get("v");
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&rel=0&playsinline=1&modestbranding=1` : "";
  } catch { return ""; }
}
function synopsis(value, fallback = "") {
  const clean = String(value || fallback).replace(/https?:\/\/\S+/g, "").replace(/[#@][\w-]+/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= 320) return clean;
  const clipped = clean.slice(0, 320);
  const sentence = clipped.lastIndexOf(". ");
  return `${clipped.slice(0, sentence > 180 ? sentence + 1 : clipped.lastIndexOf(" "))}...`;
}
function openPlayer(item, live = false) {
  clearTimeout(openPlayer.identTimer);
  const source = live ? youtubeEmbed(item.playback_url) : item.playback_type === "youtube" ? youtubeEmbed(item.youtube_url) : `${BASE_PATH}${item.playback_url}`;
  const title = live ? item.name : item.title;
  const finalMedia = () => {
    const youtubeMedia = live || item.playback_type === "youtube";
    const player = youtubeMedia
      ? `<iframe src="${escapeHtml(source)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="${escapeHtml(title)}"></iframe>`
      : `<video src="${escapeHtml(source)}" poster="${escapeHtml(item.poster_url)}" controls autoplay playsinline></video>`;
    const watermark = item.watermark_url ? `<img class="player-watermark" src="${escapeHtml(item.watermark_url)}" alt="">` : "";
    $("#player-shell").innerHTML = player + watermark;
  };
  const identSource = youtubeEmbed(item.ident_youtube_url);
  if (identSource) {
    $("#player-shell").innerHTML = `<iframe src="${escapeHtml(identSource)}&controls=0" allow="autoplay; encrypted-media" title="Channel ident"></iframe>${item.watermark_url ? `<img class="player-watermark" src="${escapeHtml(item.watermark_url)}" alt="">` : ""}<span class="ident-label">TMCPlay presentation</span>`;
    openPlayer.identTimer = setTimeout(finalMedia, Math.max(1, Number(item.ident_duration_seconds) || 6) * 1000);
  } else {
    finalMedia();
  }
  $("#player-badge").textContent = live ? "LIVE" : "ON DEMAND";
  $("#player-title").textContent = live ? item.name : item.title;
  $("#player-description").textContent = synopsis(item.description, live ? item.now_playing : item.channel_name);
  $("#player-modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
}
function closePlayer() {
  clearTimeout(openPlayer.identTimer);
  $("#player-modal").classList.add("hidden");
  $("#player-shell").innerHTML = "";
  document.body.classList.remove("modal-open");
}
function render(data) {
  viewerState.data = data;
  const live = data.channels.filter(channel => channel.is_live);
  const featured = live[0] || data.channels[0] || data.programs[0];
  $("#live-count").textContent = `${live.length} live`;
  if (featured) {
    const isChannel = Object.hasOwn(featured, "public_live_url");
    $("#hero-title").textContent = isChannel ? featured.name : featured.title;
    $("#hero-copy").textContent = synopsis(featured.description, isChannel ? featured.now_playing : featured.channel_name);
    $("#hero-status").textContent = isChannel && featured.is_live ? "LIVE NOW" : "FEATURED";
    if (featured.artwork_url || featured.poster_url) $(".hero-art").style.backgroundImage = `url("${featured.artwork_url || featured.poster_url}")`;
    $("#hero-watch").disabled = isChannel ? !featured.playback_url : false;
    $("#hero-watch").onclick = () => openPlayer(featured, isChannel);
  } else {
    $("#hero-watch").disabled = true;
  }
  $("#live-grid").innerHTML = data.channels.length ? data.channels.map((channel, index) => `<button class="live-card" data-channel="${index}" ${channel.playback_url ? "" : "disabled"}><div class="channel-art"${channel.artwork_url ? ` style="background-image:url('${escapeHtml(channel.artwork_url)}')"` : ""}><span class="channel-play"><span data-lucide="play"></span></span>${channel.is_live ? `<span class="live-corner">${channel.playback_mode === "auto_tv" ? "AUTO TV" : "LIVE"}</span>` : ""}</div><strong>${escapeHtml(channel.name)}</strong><small>${escapeHtml(channel.is_live ? channel.now_playing : "Currently off air")}</small></button>`).join("") : `<p class="viewer-empty">No channels are available yet.</p>`;
  $("#program-grid").innerHTML = data.programs.length ? data.programs.map((program, index) => `<button class="program-card" data-program="${index}"><div class="program-art"${program.poster_url ? ` style="background-image:url('${escapeHtml(program.poster_url)}')"` : ""}><span class="duration-tag">PLAY</span></div><strong>${escapeHtml(program.title)}</strong><small>${escapeHtml(program.channel_name)}</small></button>`).join("") : `<p class="viewer-empty">New programs are coming soon.</p>`;
  document.querySelectorAll("[data-channel]").forEach(button => button.onclick = () => openPlayer(data.channels[Number(button.dataset.channel)], true));
  document.querySelectorAll("[data-program]").forEach(button => button.onclick = () => openPlayer(data.programs[Number(button.dataset.program)], false));
  lucide.createIcons();
}
async function loadViewer() {
  const network = new URLSearchParams(location.search).get("network") || "tmc-media";
  const response = await fetch(`${BASE_PATH}/api/viewer/${encodeURIComponent(network)}`);
  if (!response.ok) throw new Error("The viewer is temporarily unavailable.");
  render(await response.json());
}
$("#close-player").onclick = closePlayer;
$("#player-modal").onclick = event => { if (event.target === $("#player-modal")) closePlayer(); };
document.addEventListener("keydown", event => { if (event.key === "Escape") closePlayer(); });
loadViewer().catch(error => { $("#hero-title").textContent = error.message; $("#hero-watch").disabled = true; });
setInterval(() => {
  if ($("#player-modal").classList.contains("hidden")) loadViewer().catch(() => {});
}, 30000);
lucide.createIcons();
