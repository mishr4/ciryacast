const state = { user: null, activeOrganizationId: null, channels: [], channel: null, assets: [], youtubePrograms: [], organizations: [], schedule: [], status: null, day: new Date(), filter: "all", search: "" };
const BASE_PATH = location.pathname.startsWith("/tv") ? "/tv" : "";
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[char]));
let refreshVersion = 0;

async function api(url, options = {}) {
  const response = await fetch(`${BASE_PATH}${url}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      state.user = null;
      $("#login-password").value = "";
      $("#login-note").textContent = "Your session expired. Sign in again to continue.";
      $("#login-screen").classList.remove("hidden");
      $("#login-password").focus();
      throw new Error("Your session expired. Sign in again.");
    }
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}
function toast(message, error = false) {
  const node = $("#toast"); node.textContent = message; node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = "toast", 2800);
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
  const version = ++refreshVersion;
  if (state.user?.role === "platform_admin" && !state.organizations.length) {
    state.organizations = await api("/api/organizations");
    if (version !== refreshVersion) return;
  }
  if (!state.activeOrganizationId) state.activeOrganizationId = state.user.organization_id;
  $("#company-picker").classList.toggle("hidden", state.user.role !== "platform_admin");
  if (state.user.role === "platform_admin") {
    $("#company-select").innerHTML = state.organizations.map(org => `<option value="${org.id}">${escapeHtml(org.name)}</option>`).join("");
    $("#company-select").value = String(state.activeOrganizationId);
  }
  const organizationId = state.activeOrganizationId;
  const channels = await api(`/api/channels?organization_id=${organizationId}`);
  if (version !== refreshVersion || organizationId !== state.activeOrganizationId) return;
  state.channels = channels;
  if (!state.channels.length) {
    state.channel = null;
    $("#channel-select").innerHTML = "";
    return renderEmptyCompany();
  }
  const previous = state.channel?.id;
  state.channel = state.channels.find(c => c.id === previous) || state.channels[0];
  $("#channel-select").innerHTML = state.channels.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  $("#channel-select").value = state.channel.id;
  const details = await Promise.all([
    api(`/api/channels/${state.channel.id}/youtube-programs`),
    api(`/api/channels/${state.channel.id}/schedule`),
    api(`/api/channels/${state.channel.id}/status`)
  ]);
  if (version !== refreshVersion || organizationId !== state.activeOrganizationId) return;
  [state.youtubePrograms, state.schedule, state.status] = details;
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
  $("#output-state").textContent = state.status.streaming
    ? "Live to YouTube"
    : state.status.starting
      ? "Starting YouTube broadcast"
      : state.status.outputRequested
        ? state.status.lastError ? "YouTube broadcast error" : "Retrying YouTube broadcast"
        : source.autoTv ? "YouTube broadcast stopped" : "Stopped";
  $("#now-playing").textContent = source.label;
  const future = state.schedule.find(item => new Date(item.start_at) > new Date());
  $("#next-program").textContent = future?.title || "Nothing scheduled";
  $("#asset-count").textContent = `${state.youtubePrograms.length} item${state.youtubePrograms.length === 1 ? "" : "s"}`;
  $("#live-badge").textContent = state.status.streaming ? "LIVE" : state.status.starting ? "STARTING" : state.status.outputRequested && state.status.lastError ? "ERROR" : "OFF AIR";
  $("#live-badge").classList.toggle("on", state.status.streaming);
  $("#monitor-title").textContent = source.label;
  $("#monitor-detail").textContent = source.type === "off-air"
    ? "Schedule a video or enable Auto TV"
    : state.status.streaming
      ? "Sending to YouTube Live"
      : state.status.starting
        ? "Resolving the source and connecting to YouTube"
        : state.status.outputRequested
          ? state.status.lastError || "Waiting to retry the YouTube connection"
          : source.autoTv ? "Live on TMCPlay; YouTube rebroadcast is stopped" : "Ready in automation";
  $("#start-output").disabled = Boolean(state.status.outputRequested);
  $("#stop-output").disabled = !state.status.outputRequested;
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
  const rows = state.youtubePrograms.map(p => `<div class="asset-row ondemand-row"><span class="media-icon"><span data-lucide="youtube"></span></span><div><strong>${escapeHtml(p.title)}</strong><small>${p.on_demand ? "Visible in the TMCPlay catalog" : "Hidden from the viewer catalog"}</small></div><span class="kind-tag">${p.kind}</span><button class="button ${p.on_demand ? "secondary" : "primary"} publish-button" data-publish-youtube="${p.id}">${p.on_demand ? "Unpublish" : "Publish"}</button></div>`);
  $("#ondemand-list").innerHTML = rows.length ? rows.join("") : `<div class="empty-state" style="min-height:180px">Add a YouTube video to begin.</div>`;
  $$("[data-publish-youtube]").forEach(button => button.onclick = async () => {
    const program = state.youtubePrograms.find(item => item.id === Number(button.dataset.publishYoutube));
    await api(`/api/youtube-programs/${program.id}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({on_demand:!program.on_demand})});
    toast(program.on_demand ? "Video unpublished" : "Video published");
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
  const items = state.youtubePrograms.filter(item => (state.filter === "all" || item.kind === state.filter) && item.title.toLowerCase().includes(state.search.toLowerCase()));
  $("#asset-list").innerHTML = items.length ? items.map(item => `<div class="asset-row"><span class="media-icon"><span data-lucide="youtube"></span></span><div><strong>${escapeHtml(item.title)}</strong><small>YouTube hosted${item.on_demand ? " · On demand" : ""}</small></div><span class="kind-tag">${item.kind}</span><span class="size">No storage</span><button class="delete-button" data-delete-youtube-program="${item.id}" title="Remove media"><span data-lucide="trash-2"></span></button></div>`).join("") : `<div class="empty-state" style="min-height:180px">No matching YouTube media.</div>`;
  $$("[data-delete-youtube-program]").forEach(button => button.onclick = async () => {
    if (!confirm("Remove this YouTube video and its scheduled events?")) return;
    await api(`/api/youtube-programs/${button.dataset.deleteYoutubeProgram}`, { method:"DELETE" }); toast("YouTube media removed"); await refresh();
  });
}
function renderSchedule() {
  $("#schedule-day").textContent = state.day.toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" });
  const items = state.schedule.filter(item => new Date(item.start_at).toDateString() === state.day.toDateString());
  $("#schedule-list").innerHTML = items.length ? items.map(item => `<div class="timeline-item"><time>${new Date(item.start_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} - ${new Date(item.end_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.original_name)}</small></div><button class="delete-button" data-delete-event="${item.schedule_key || item.id}" title="Remove event"><span data-lucide="trash-2"></span></button></div>`).join("") : `<div class="empty-state" style="min-height:260px">Nothing scheduled for this day.</div>`;
  $$("[data-delete-event]").forEach(button => button.onclick = async () => { await api(`/api/schedule/${button.dataset.deleteEvent}`, {method:"DELETE"}); toast("Program removed"); await refresh(); });
}
function renderSelectors() {
  const options = state.youtubePrograms.map(item => `<option value="${item.id}">${escapeHtml(item.title)} (${item.kind})</option>`).join("");
  $("#override-asset").innerHTML = `<option value="">Choose a video...</option>${options}`;
  $("#event-asset").innerHTML = `<option value="">Choose a video...</option>${options}`;
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
  $("#youtube-channel-url").value = state.channel.youtube_channel_url || "";
  $("#youtube-sync-status").textContent = state.channel.youtube_last_synced_at
    ? `Last synced ${new Date(state.channel.youtube_last_synced_at).toLocaleString()}`
    : "Assign a YouTube channel to import its public videos into On Demand and Auto TV.";
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
  const checks = [
    [state.youtubePrograms.length > 0 && Boolean(state.channel.auto_tv_enabled), "TMCPlay Auto TV", state.channel.auto_tv_enabled ? `${state.youtubePrograms.length} YouTube item(s) available without a stream key` : "Enable Auto TV to run the TMCPlay channel"],
    [state.status.ffmpegAvailable, "FFmpeg", state.status.ffmpegAvailable ? "Encoder is installed" : "Install FFmpeg on the server"],
    [state.status.ytDlpAvailable, "YouTube relay", state.status.ytDlpAvailable ? "yt-dlp is installed" : "Install yt-dlp to relay YouTube URLs"],
    [state.status.streamKeyConfigured, "YouTube broadcast", state.status.streamKeyConfigured ? "Stream key saved; rebroadcast is available" : "Optional: add a stream key to broadcast Auto TV to YouTube Live"],
    [state.youtubePrograms.length > 0, "YouTube library", state.youtubePrograms.length ? `${state.youtubePrograms.length} item(s) ready` : "Add at least one YouTube video"]
  ];
  if (state.status.lastError) checks.push([false, "Broadcast error", state.status.lastError]);
  $("#readiness").innerHTML = checks.map(([ok,title,detail]) => `<div class="check-row ${ok ? "ok":"bad"}"><span data-lucide="${ok ? "circle-check":"circle-x"}"></span><div><strong>${title}</strong><small>${detail}</small></div></div>`).join("");
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
  try {
    const organizationId = state.user.role === "platform_admin" ? Number($("#new-channel-company").value) : state.user.organization_id;
    const created = await api("/api/channels", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("#new-channel-name").value,organization_id:organizationId,youtube_channel_url:$("#new-channel-youtube").value})});
    $("#channel-modal").classList.add("hidden");
    event.target.reset();
    state.activeOrganizationId = organizationId;
    state.channel = created;
    await refresh();
    toast(created.sync ? `Channel created with ${created.sync.added} YouTube videos` : created.sync_error || "Channel created and ready to configure", Boolean(created.sync_error));
  } catch (error) {
    toast(error.message, true);
  }
};
$("#add-youtube-media").onclick = () => $("#youtube-program-modal").classList.remove("hidden");
$("#asset-search").oninput = event => { state.search = event.target.value; renderAssets(); lucide.createIcons(); };
$$("[data-kind]").forEach(button => button.onclick = () => { state.filter = button.dataset.kind; $$("[data-kind]").forEach(b => b.classList.toggle("active", b === button)); renderAssets(); lucide.createIcons(); });
$("#new-event").onclick = () => { const start = new Date(); start.setMinutes(Math.ceil(start.getMinutes()/15)*15,0,0); const end = new Date(start.getTime()+3600000); $("#event-start").value=localInput(start); $("#event-end").value=localInput(end); $("#event-modal").classList.remove("hidden"); };
$$(".close-modal").forEach(button => button.onclick = () => $("#event-modal").classList.add("hidden"));
$("#event-form").onsubmit = async event => { event.preventDefault(); await api(`/api/channels/${state.channel.id}/schedule`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({youtube_program_id:Number($("#event-asset").value),title:$("#event-title").value,start_at:$("#event-start").value,end_at:$("#event-end").value})}); $("#event-modal").classList.add("hidden"); event.target.reset(); toast("YouTube program scheduled"); await refresh(); };
$("#previous-day").onclick = () => { state.day.setDate(state.day.getDate()-1); state.day=new Date(state.day); renderSchedule(); lucide.createIcons(); };
$("#next-day").onclick = () => { state.day.setDate(state.day.getDate()+1); state.day=new Date(state.day); renderSchedule(); lucide.createIcons(); };
$("#today-button").onclick = () => { state.day=new Date(); renderSchedule(); lucide.createIcons(); };
$("#start-asset-override").onclick = async () => { const program=state.youtubePrograms.find(item=>item.id===Number($("#override-asset").value)); if (!program) return toast("Choose a video first",true); await api(`/api/channels/${state.channel.id}/override`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"youtube",url:program.youtube_url,label:program.title})}); toast("YouTube library override is active"); await refresh(); };
$("#start-youtube-override").onclick = async () => { try { await api(`/api/channels/${state.channel.id}/override`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"youtube",url:$("#youtube-url").value,label:$("#youtube-label").value})}); toast("YouTube Live override is active"); await refresh(); } catch(error){ toast(error.message,true); } };
$("#start-output").onclick = async () => { const result=await api(`/api/channels/${state.channel.id}/output/start`,{method:"POST"}); if(!result.ffmpegAvailable) toast("Install FFmpeg before starting the YouTube broadcast",true); else if(!result.streamKeyConfigured) toast("Open Output settings and save this channel's YouTube stream key",true); else toast("Starting the YouTube broadcast..."); await refresh(); };
$("#stop-output").onclick = async () => { await api(`/api/channels/${state.channel.id}/output/stop`,{method:"POST"}); toast("YouTube broadcast stopped"); await refresh(); };
$("#upload-branding").onclick = async () => {
  const artwork = $("#channel-artwork-file").files[0];
  const watermark = $("#channel-watermark-file").files[0];
  if (!artwork && !watermark) return toast("Choose an artwork or watermark image first", true);
  const form = new FormData();
  if (artwork) form.append("artwork", artwork);
  if (watermark) form.append("watermark", watermark);
  const button = $("#upload-branding");
  button.disabled = true;
  try {
    const result = await api(`/api/channels/${state.channel.id}/branding`, {method:"POST",body:form});
    $("#channel-artwork-url").value = result.artwork_url || "";
    $("#channel-watermark-url").value = result.watermark_url || "";
    $("#channel-artwork-file").value = "";
    $("#channel-watermark-file").value = "";
    toast("Branding images uploaded");
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
};
$("#sync-youtube-channel").onclick = async () => {
  const button = $("#sync-youtube-channel");
  button.disabled = true;
  try {
    toast("Syncing the YouTube channel...");
    const result = await api(`/api/channels/${state.channel.id}/youtube-sync`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({youtube_channel_url:$("#youtube-channel-url").value})});
    toast(`${result.channelTitle}: ${result.added} added, ${result.updated} updated`);
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
};
$("#save-settings").onclick = async () => {
  const streamKey = $("#youtube-stream-key").value.trim();
  try {
    if (streamKey) {
      await api(`/api/channels/${state.channel.id}/youtube-credentials`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({rtmp_url:$("#rtmp-url").value,stream_key:streamKey})});
    }
    await api(`/api/channels/${state.channel.id}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({rtmp_url:$("#rtmp-url").value,public_live_url:$("#public-live-url").value,artwork_url:$("#channel-artwork-url").value,watermark_url:$("#channel-watermark-url").value,ident_youtube_url:$("#channel-ident-url").value,ident_duration_seconds:Number($("#channel-ident-duration").value)||6,auto_tv_enabled:$("#auto-tv-enabled").checked,auto_tv_slot_minutes:Number($("#auto-tv-slot").value)||30})});
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
    await api(`/api/channels/${state.channel.id}/youtube-programs`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({youtube_url:$("#program-youtube-url").value,title:$("#program-youtube-title").value,description:$("#program-youtube-description").value,poster_url:$("#program-youtube-poster").value,kind:$("#program-youtube-kind").value,on_demand:$("#program-youtube-on-demand").checked})});
    $("#youtube-program-modal").classList.add("hidden");
    event.target.reset();
    toast("YouTube media added");
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
  try {
    state.status = await api(`/api/channels/${state.channel.id}/status`);
    render();
  } catch {}
}, 10000);
