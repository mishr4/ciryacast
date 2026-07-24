const state = { user: null, activeOrganizationId: null, channels: [], channel: null, assets: [], youtubePrograms: [], organizations: [], schedule: [], status: null, day: new Date(), filter: "all", search: "" };
const BASE_PATH = location.pathname.startsWith("/tv") ? "/tv" : "";
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char]));

async function api(url, options = {}) {
  const response = await fetch(`${BASE_PATH}${url}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}
function toast(message, error = false) {
  const node = $("#toast"); node.textContent = message; node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = "toast", 2800);
}
function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function localInput(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date - offset).toISOString().slice(0, 16);
}
function go(view) {
  $$(".view").forEach(node => node.classList.toggle("active", node.id === `view-${view}`));
  $$(".nav-item").forEach(node => node.classList.toggle("active", node.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refresh() {
  if (state.user?.role === "platform_admin" && !state.organizations.length) {
    state.organizations = await api("/api/organizations");
  }
  if (!state.activeOrganizationId) state.activeOrganizationId = state.user.organization_id;
  $("#company-picker").classList.toggle("hidden", state.user.role !== "platform_admin");
  if (state.user.role === "platform_admin") {
    $("#company-select").innerHTML = state.organizations.map(org => `<option value="${org.id}">${escapeHtml(org.name)}</option>`).join("");
    $("#company-select").value = String(state.activeOrganizationId);
  }
  state.channels = await api(`/api/channels?organization_id=${state.activeOrganizationId}`);
  if (!state.channels.length) {
    state.channel = null;
    $("#channel-select").innerHTML = "";
    return renderEmptyCompany();
  }
  const previous = state.channel?.id;
  state.channel = state.channels.find(c => c.id === previous) || state.channels[0];
  $("#channel-select").innerHTML = state.channels.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  $("#channel-select").value = state.channel.id;
  [state.assets, state.youtubePrograms, state.schedule, state.status] = await Promise.all([
    api(`/api/channels/${state.channel.id}/assets`),
    api(`/api/channels/${state.channel.id}/youtube-programs`),
    api(`/api/channels/${state.channel.id}/schedule`),
    api(`/api/channels/${state.channel.id}/status`)
  ]);
  render();
}
function renderEmptyCompany() {
  $("#channel-title").textContent = "No channels yet";
  $("#output-state").textContent = "Not configured";
  $("#now-playing").textContent = "Off air";
  $("#next-program").textContent = "Nothing scheduled";
  $("#asset-count").textContent = "0 items";
  $("#monitor-title").textContent = "Create this company's first channel";
  $("#monitor-detail").textContent = "Use the plus button in the top bar";
  $("#server-status").textContent = "No channels";
  $$(".owner-only").forEach(node => node.classList.toggle("hidden", state.user.role !== "platform_admin"));
  lucide.createIcons();
}
function render() {
  const source = state.status.source;
  $("#channel-title").textContent = state.channel.name;
  $("#output-state").textContent = state.status.streaming ? "Live to YouTube" : state.status.outputRequested ? "Waiting for source" : "Stopped";
  $("#now-playing").textContent = source.label;
  const future = state.schedule.find(item => new Date(item.start_at) > new Date());
  $("#next-program").textContent = future?.title || "Nothing scheduled";
  $("#asset-count").textContent = `${state.assets.length} item${state.assets.length === 1 ? "" : "s"}`;
  $("#live-badge").textContent = state.status.streaming ? "LIVE" : "OFF AIR";
  $("#live-badge").classList.toggle("on", state.status.streaming);
  $("#monitor-title").textContent = source.label;
  $("#monitor-detail").textContent = source.type === "off-air" ? "Schedule a video or set a fallback" : state.status.streaming ? "Sending to YouTube" : "Ready in automation";
  $("#source-type").textContent = source.type === "youtube" ? "YouTube Live relay" : source.key.startsWith("override") || source.key.includes("override") ? "Manual override" : source.key.startsWith("fallback") ? "Fallback loop" : "Automation";
  renderRundown(); renderAssets(); renderSchedule(); renderSelectors(); renderOverride(); renderSettings(); renderOnDemand();
  const activeOrganization = state.organizations.find(org => org.id === state.activeOrganizationId);
  const catalogSlug = activeOrganization?.slug || state.user.organization_slug;
  $("#open-catalog").href = `${BASE_PATH}/?network=${encodeURIComponent(catalogSlug)}`;
  $$(".owner-only").forEach(node => node.classList.toggle("hidden", state.user.role !== "platform_admin"));
  $("#server-status").textContent = "Connected";
  lucide.createIcons();
}
function renderOnDemand() {
  const youtubeRows = state.youtubePrograms.map(p => `<div class="asset-row ondemand-row"><span class="media-icon"><span data-lucide="youtube"></span></span><div><strong>${escapeHtml(p.title)}</strong><small>YouTube-hosted on TMCPlay</small></div><span class="kind-tag">YouTube</span><button class="button secondary publish-button" data-delete-youtube-program="${p.id}">Remove</button></div>`);
  const uploadRows = state.assets.map(a => `<div class="asset-row ondemand-row"><span class="media-icon"><span data-lucide="film"></span></span><div><strong>${escapeHtml(a.title)}</strong><small>${a.on_demand ? "Visible in viewer catalog" : "Private media"}</small></div><span class="kind-tag">${a.kind}</span><button class="button ${a.on_demand ? "secondary" : "primary"} publish-button" data-publish="${a.id}">${a.on_demand ? "Unpublish" : "Publish"}</button></div>`);
  $("#ondemand-list").innerHTML = youtubeRows.length || uploadRows.length ? [...youtubeRows, ...uploadRows].join("") : `<div class="empty-state" style="min-height:180px">Add a YouTube program or upload a video to begin.</div>`;
  $$("[data-publish]").forEach(button => button.onclick = async () => {
    const asset = state.assets.find(a => a.id === Number(button.dataset.publish));
    await api(`/api/assets/${asset.id}/on-demand`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({on_demand:!asset.on_demand,title:asset.title,description:asset.description,poster_url:asset.poster_url})});
    toast(asset.on_demand ? "Video unpublished" : "Video published");
    await refresh();
  });
  $$("[data-delete-youtube-program]").forEach(button => button.onclick = async () => {
    await api(`/api/youtube-programs/${button.dataset.deleteYoutubeProgram}`, {method:"DELETE"});
    toast("Program removed from TMCPlay");
    await refresh();
  });
}
async function renderPartners() {
  if (state.user.role !== "platform_admin") return;
  const partners = await api("/api/partners");
  $("#partner-list").innerHTML = partners.map(p => `<div class="partner-row"><span class="media-icon"><span data-lucide="building-2"></span></span><div><strong>${escapeHtml(p.organization_name)}</strong><small>${escapeHtml(p.email)}</small></div><span>${p.channel_count} channel${p.channel_count===1?"":"s"}</span><div class="partner-actions"><button class="text-button" data-manage-company="${p.organization_id}">Manage</button><a class="text-button" target="_blank" href="${BASE_PATH}/?network=${encodeURIComponent(p.slug)}">TMCPlay</a></div></div>`).join("");
  $$("[data-manage-company]").forEach(button => button.onclick = async () => {
    state.activeOrganizationId = Number(button.dataset.manageCompany);
    state.channel = null;
    await refresh();
    go("overview");
    toast("Company workspace opened");
  });
  lucide.createIcons();
}
function renderRundown() {
  const upcoming = state.schedule.filter(item => new Date(item.end_at) > new Date()).slice(0, 5);
  $("#rundown").classList.toggle("empty-state", !upcoming.length);
  $("#rundown").innerHTML = upcoming.length ? upcoming.map(item => `<div class="rundown-item"><time>${new Date(item.start_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.original_name)}</small></div></div>`).join("") : "No programs scheduled yet.";
}
function renderAssets() {
  const items = state.assets.filter(a => (state.filter === "all" || a.kind === state.filter) && a.title.toLowerCase().includes(state.search.toLowerCase()));
  $("#asset-list").innerHTML = items.length ? items.map(a => `<div class="asset-row"><span class="media-icon"><span data-lucide="${a.mime_type.startsWith("audio") ? "audio-lines" : "film"}"></span></span><div><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.original_name)}</small></div><span class="kind-tag">${a.kind}</span><span class="size">${formatSize(a.size)}</span><button class="delete-button" data-delete-asset="${a.id}" title="Delete media"><span data-lucide="trash-2"></span></button></div>`).join("") : `<div class="empty-state" style="min-height:180px">No matching media.</div>`;
  $$("[data-delete-asset]").forEach(button => button.onclick = async () => {
    if (!confirm("Delete this media file and its scheduled events?")) return;
    await api(`/api/assets/${button.dataset.deleteAsset}`, { method:"DELETE" }); toast("Media deleted"); await refresh();
  });
}
function renderSchedule() {
  $("#schedule-day").textContent = state.day.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" });
  const items = state.schedule.filter(item => new Date(item.start_at).toDateString() === state.day.toDateString());
  $("#schedule-list").innerHTML = items.length ? items.map(item => `<div class="timeline-item"><time>${new Date(item.start_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} - ${new Date(item.end_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.original_name)}</small></div><button class="delete-button" data-delete-event="${item.id}" title="Remove event"><span data-lucide="trash-2"></span></button></div>`).join("") : `<div class="empty-state" style="min-height:260px">Nothing scheduled for this day.</div>`;
  $$("[data-delete-event]").forEach(button => button.onclick = async () => { await api(`/api/schedule/${button.dataset.deleteEvent}`, {method:"DELETE"}); toast("Program removed"); await refresh(); });
}
function renderSelectors() {
  const options = state.assets.map(a => `<option value="${a.id}">${escapeHtml(a.title)} (${a.kind})</option>`).join("");
  $("#override-asset").innerHTML = `<option value="">Choose a video...</option>${options}`;
  $("#event-asset").innerHTML = `<option value="">Choose a video...</option>${options}`;
  $("#fallback-asset").innerHTML = `<option value="">No fallback</option>${options}`;
}
function renderOverride() {
  const source = state.status.source;
  const active = source.key.includes("override");
  const node = $("#active-override");
  node.classList.toggle("hidden", !active);
  node.innerHTML = active ? `<div><p class="eyebrow">OVERRIDE ACTIVE</p><strong>${escapeHtml(source.label)}</strong></div><button class="button danger" id="stop-override"><span data-lucide="square"></span>Return to automation</button>` : "";
  if (active) $("#stop-override").onclick = async () => { await api(`/api/channels/${state.channel.id}/override`, {method:"DELETE"}); toast("Automation restored"); await refresh(); };
}
function renderSettings() {
  $("#rtmp-url").value = state.channel.rtmp_url || "";
  $("#public-live-url").value = state.channel.public_live_url || "";
  $("#channel-artwork-url").value = state.channel.artwork_url || "";
  $("#channel-watermark-url").value = state.channel.watermark_url || "";
  $("#channel-ident-url").value = state.channel.ident_youtube_url || "";
  $("#channel-ident-duration").value = state.channel.ident_duration_seconds || 6;
  $("#auto-tv-enabled").checked = Boolean(state.channel.auto_tv_enabled);
  $("#auto-tv-slot").value = String(state.channel.auto_tv_slot_minutes || 30);
  $("#youtube-stream-key").value = "";
  $("#stream-key-status").textContent = state.channel.stream_key_configured ? "A stream key is encrypted and saved for this channel." : "No stream key saved.";
  $("#remove-stream-key").disabled = !state.channel.stream_key_configured;
  $("#fallback-asset").value = state.channel.fallback_asset_id || "";
  const checks = [
    [state.status.ffmpegAvailable, "FFmpeg", state.status.ffmpegAvailable ? "Encoder is installed" : "Install FFmpeg on the server"],
    [state.status.ytDlpAvailable, "YouTube relay", state.status.ytDlpAvailable ? "yt-dlp is installed" : "Install yt-dlp to relay YouTube URLs"],
    [state.status.streamKeyConfigured, "Stream key", state.status.streamKeyConfigured ? "Encrypted credential is saved" : "Add this channel's key above"],
    [state.assets.length > 0, "Media library", state.assets.length ? `${state.assets.length} item(s) ready` : "Upload at least one video"]
  ];
  $("#readiness").innerHTML = checks.map(([ok,title,detail]) => `<div class="check-row ${ok ? "ok":"bad"}"><span data-lucide="${ok ? "circle-check":"circle-x"}"></span><div><strong>${title}</strong><small>${detail}</small></div></div>`).join("");
}
async function uploadFiles(files) {
  if (!files.length) return;
  const kind = prompt("Type: program, promo, ad, or ident", "program") || "program";
  const form = new FormData(); [...files].forEach(file => form.append("files", file)); form.append("kind", kind.toLowerCase());
  toast(`Uploading ${files.length} file(s)...`);
  await api(`/api/channels/${state.channel.id}/assets`, {method:"POST", body:form});
  toast("Upload complete"); await refresh();
}

$$(".nav-item").forEach(button => button.onclick = () => go(button.dataset.view));
$$(".nav-item").forEach(button => button.addEventListener("click", () => { if (button.dataset.view === "partners") renderPartners(); }));
$$("[data-go]").forEach(button => button.onclick = () => go(button.dataset.go));
$("#channel-select").onchange = async event => { state.channel = state.channels.find(c => c.id === Number(event.target.value)); await refresh(); };
$("#company-select").onchange = async event => {
  state.activeOrganizationId = Number(event.target.value);
  state.channel = null;
  await refresh();
};
$("#add-channel").onclick = () => {
  const field = $("#channel-company-field");
  field.classList.toggle("hidden", state.user.role !== "platform_admin");
  $("#new-channel-company").innerHTML = state.organizations.map(org => `<option value="${org.id}">${escapeHtml(org.name)}</option>`).join("");
  $("#new-channel-company").value = String(state.activeOrganizationId || state.user.organization_id);
  $("#channel-modal").classList.remove("hidden");
};
$("#open-help").onclick = () => $("#help-modal").classList.remove("hidden");
$$(".close-help").forEach(button => button.onclick = () => $("#help-modal").classList.add("hidden"));
$$(".close-channel").forEach(button => button.onclick = () => $("#channel-modal").classList.add("hidden"));
$("#channel-form").onsubmit = async event => {
  event.preventDefault();
  const organizationId = state.user.role === "platform_admin" ? Number($("#new-channel-company").value) : state.user.organization_id;
  const created = await api("/api/channels", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("#new-channel-name").value,organization_id:organizationId})});
  $("#channel-modal").classList.add("hidden");
  event.target.reset();
  state.activeOrganizationId = organizationId;
  state.channel = created;
  toast("Channel created for selected company");
  await refresh();
};
$("#upload-trigger").onclick = () => $("#file-input").click();
$("#file-input").onchange = event => uploadFiles(event.target.files);
$("#drop-zone").onclick = () => $("#file-input").click();
document.addEventListener("dragover", event => { event.preventDefault(); $("#drop-zone").classList.add("visible","dragging"); });
document.addEventListener("dragleave", event => { if (!event.relatedTarget) $("#drop-zone").classList.remove("dragging"); });
document.addEventListener("drop", event => { event.preventDefault(); $("#drop-zone").classList.remove("dragging"); uploadFiles(event.dataTransfer.files); });
$("#asset-search").oninput = event => { state.search = event.target.value; renderAssets(); lucide.createIcons(); };
$$("[data-kind]").forEach(button => button.onclick = () => { state.filter = button.dataset.kind; $$("[data-kind]").forEach(b => b.classList.toggle("active", b === button)); renderAssets(); lucide.createIcons(); });
$("#new-event").onclick = () => { const start = new Date(); start.setMinutes(Math.ceil(start.getMinutes()/15)*15,0,0); const end = new Date(start.getTime()+3600000); $("#event-start").value=localInput(start); $("#event-end").value=localInput(end); $("#event-modal").classList.remove("hidden"); };
$$(".close-modal").forEach(button => button.onclick = () => $("#event-modal").classList.add("hidden"));
$("#event-form").onsubmit = async event => { event.preventDefault(); await api(`/api/channels/${state.channel.id}/schedule`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({asset_id:Number($("#event-asset").value),title:$("#event-title").value,start_at:$("#event-start").value,end_at:$("#event-end").value})}); $("#event-modal").classList.add("hidden"); event.target.reset(); toast("Program scheduled"); await refresh(); };
$("#previous-day").onclick = () => { state.day.setDate(state.day.getDate()-1); state.day=new Date(state.day); renderSchedule(); lucide.createIcons(); };
$("#next-day").onclick = () => { state.day.setDate(state.day.getDate()+1); state.day=new Date(state.day); renderSchedule(); lucide.createIcons(); };
$("#today-button").onclick = () => { state.day=new Date(); renderSchedule(); lucide.createIcons(); };
$("#start-asset-override").onclick = async () => { if (!$("#override-asset").value) return toast("Choose a video first",true); await api(`/api/channels/${state.channel.id}/override`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"asset",asset_id:Number($("#override-asset").value)})}); toast("Video override is active"); await refresh(); };
$("#start-youtube-override").onclick = async () => { try { await api(`/api/channels/${state.channel.id}/override`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"youtube",url:$("#youtube-url").value,label:$("#youtube-label").value})}); toast("YouTube Live override is active"); await refresh(); } catch(error){ toast(error.message,true); } };
$("#start-output").onclick = async () => { const result=await api(`/api/channels/${state.channel.id}/output/start`,{method:"POST"}); if(!result.ffmpegAvailable) toast("Install FFmpeg before starting output",true); else if(!result.streamKeyConfigured) toast("Add the stream key environment variable first",true); else toast("Output started"); await refresh(); };
$("#stop-output").onclick = async () => { await api(`/api/channels/${state.channel.id}/output/stop`,{method:"POST"}); toast("Output stopped"); await refresh(); };
$("#save-settings").onclick = async () => {
  const streamKey = $("#youtube-stream-key").value.trim();
  try {
    if (streamKey) {
      await api(`/api/channels/${state.channel.id}/youtube-credentials`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({rtmp_url:$("#rtmp-url").value,stream_key:streamKey})});
    }
    await api(`/api/channels/${state.channel.id}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({rtmp_url:$("#rtmp-url").value,public_live_url:$("#public-live-url").value,artwork_url:$("#channel-artwork-url").value,watermark_url:$("#channel-watermark-url").value,ident_youtube_url:$("#channel-ident-url").value,ident_duration_seconds:Number($("#channel-ident-duration").value)||6,auto_tv_enabled:$("#auto-tv-enabled").checked,auto_tv_slot_minutes:Number($("#auto-tv-slot").value)||30,fallback_asset_id:Number($("#fallback-asset").value)||null})});
    toast(streamKey ? "YouTube credentials encrypted and saved" : "Output settings saved");
    await refresh();
  } catch (error) { toast(error.message, true); }
};
$("#remove-stream-key").onclick = async () => {
  if (!confirm("Remove this channel's saved YouTube stream key?")) return;
  await api(`/api/channels/${state.channel.id}/youtube-credentials`, {method:"DELETE"});
  toast("YouTube stream key removed");
  await refresh();
};
$("#new-partner").onclick = () => $("#partner-modal").classList.remove("hidden");
$$(".close-partner").forEach(button => button.onclick = () => $("#partner-modal").classList.add("hidden"));
$("#partner-form").onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await api("/api/partners", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company_name:$("#partner-company").value,contact_name:$("#partner-contact").value,email:$("#partner-email").value,password:$("#partner-password").value})});
    $("#partner-modal").classList.add("hidden");
    event.target.reset();
    toast(`Partner created: /watch/${result.slug}`);
    await renderPartners();
  } catch (error) { toast(error.message, true); }
};
$("#add-youtube-program").onclick = () => $("#youtube-program-modal").classList.remove("hidden");
$$(".close-youtube-program").forEach(button => button.onclick = () => $("#youtube-program-modal").classList.add("hidden"));
$("#youtube-program-form").onsubmit = async event => {
  event.preventDefault();
  try {
    await api(`/api/channels/${state.channel.id}/youtube-programs`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({youtube_url:$("#program-youtube-url").value,title:$("#program-youtube-title").value,description:$("#program-youtube-description").value,poster_url:$("#program-youtube-poster").value})});
    $("#youtube-program-modal").classList.add("hidden");
    event.target.reset();
    toast("Program published to TMCPlay");
    await refresh();
  } catch (error) { toast(error.message, true); }
};

$("#login-form").onsubmit = async event => {
  event.preventDefault();
  try {
    if ($("#setup-fields").classList.contains("hidden")) {
      const result = await api("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("#login-email").value,password:$("#login-password").value})});
      if (result.setup_required) {
        $("#login-fields").classList.add("hidden");
        $("#setup-fields").classList.remove("hidden");
        $("#setup-password").required = true;
        $("#setup-password-confirm").required = true;
        $("#login-submit").textContent = "Create password";
        $("#login-note").textContent = `Secure ${result.email} with a password of at least 10 characters.`;
        $("#setup-password").focus();
        return;
      }
      state.user = result;
    } else {
      const password = $("#setup-password").value;
      if (password !== $("#setup-password-confirm").value) throw new Error("Passwords do not match.");
      state.user = await api("/api/auth/setup-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});
    }
    $("#login-screen").classList.add("hidden");
    await refresh();
  } catch(error) { toast(error.message,true); }
};
async function bootstrap() {
  try { state.user=await api("/api/auth/me"); $("#login-screen").classList.add("hidden"); await refresh(); }
  catch { $("#login-screen").classList.remove("hidden"); lucide.createIcons(); }
}
bootstrap();
setInterval(async () => {
  if (!state.channel) return;
  state.status = await api(`/api/channels/${state.channel.id}/status`);
  render();
}, 10000);
