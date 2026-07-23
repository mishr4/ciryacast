const parts = location.pathname.split("/").filter(Boolean);
const baseOffset = parts[0] === "tv" ? 1 : 0;
const basePath = baseOffset ? "/tv" : "";
const slug = parts[baseOffset + 1];
const selectedId = parts[baseOffset + 2];
const esc = value => String(value || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function loadCatalog() {
  const response = await fetch(`${basePath}/api/watch/${encodeURIComponent(slug)}`);
  if (!response.ok) return document.querySelector("#watch-title").textContent = "Catalog not found";
  const data = await response.json();
  document.title = `${data.organization.name} On Demand`;
  document.querySelector("#watch-brand").textContent = data.organization.name;
  document.querySelector("#watch-title").textContent = `${data.organization.name} On Demand`;
  document.querySelector("#watch-grid").innerHTML = data.assets.length ? data.assets.map(item => `<a class="watch-card" href="${basePath}/watch/${encodeURIComponent(slug)}/${item.id}"><div class="watch-poster"${item.poster_url ? ` style="background-image:url('${esc(item.poster_url)}')"` : ""}><span>PLAY</span></div><strong>${esc(item.title)}</strong><small>${esc(item.channel_name)}</small></a>`).join("") : `<p class="empty-state">No videos have been published yet.</p>`;
  if (selectedId) {
    const detail = await fetch(`${basePath}/api/watch/${encodeURIComponent(slug)}/${encodeURIComponent(selectedId)}`).then(r => r.ok ? r.json() : null);
    if (detail) {
      const player = document.querySelector("#watch-player"); player.classList.remove("hidden");
      player.innerHTML = `<video controls autoplay playsinline poster="${esc(detail.poster_url)}" src="${basePath}${esc(detail.playback_url)}"></video><div><h2>${esc(detail.title)}</h2><p>${esc(detail.description)}</p><small>${esc(detail.channel_name)}</small></div>`;
      player.scrollIntoView({behavior:"smooth"});
    }
  }
}
loadCatalog();
