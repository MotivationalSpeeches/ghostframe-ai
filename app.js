const API_BASE_URL = String(window.GHOSTFRAME_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");

const state = {
  view: "studio",
  seconds: 30,
  template: "Kinetic",
  playing: false,
  elapsed: 0,
  timer: null,
  queue: JSON.parse(localStorage.getItem("ghostframe-queue") || "null") || [
    { id: 1, title: "Why your brain loves unfinished stories", niche: "Facts & curiosity", duration: 30, status: "Scheduled · Tue 7:30 PM", scheduled: true, platforms: ["TikTok", "YouTube"] },
    { id: 2, title: "The 2-minute rule that beats procrastination", niche: "Motivation", duration: 45, status: "Draft", scheduled: false, platforms: ["TikTok"] }
  ]
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const viewMeta = {
  studio: ["CREATE", "Build your next short"],
  queue: ["PUBLISH", "Plan every post"],
  connections: ["SETUP", "Connect your channels"]
};

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setView(view) {
  state.view = view;
  $$(".nav-item").forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle("active", active);
    active ? item.setAttribute("aria-current", "page") : item.removeAttribute("aria-current");
  });
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  $("#viewEyebrow").textContent = viewMeta[view][0];
  $("#viewTitle").textContent = viewMeta[view][1];
  location.hash = view;
  if (view === "queue") renderQueue();
}

function persistQueue() {
  localStorage.setItem("ghostframe-queue", JSON.stringify(state.queue));
  $("#queueCount").textContent = state.queue.length;
}

function platformBadges(platforms) {
  return platforms.map((platform) => `<span class="platform-icon ${platform.toLowerCase()}">${platform === "TikTok" ? "♪" : "▶"}</span>`).join("");
}

function renderQueue() {
  const root = $("#queueList");
  if (!state.queue.length) {
    root.innerHTML = `<div class="security-note"><strong>No videos yet</strong><p>Create your first draft in Studio.</p></div>`;
    return;
  }
  root.innerHTML = state.queue.map((item) => `
    <article class="queue-item">
      <div class="queue-thumb">${item.duration}s</div>
      <div class="queue-title"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.niche)} · Vertical 9:16</p></div>
      <div class="queue-platforms">${platformBadges(item.platforms)}</div>
      <div class="queue-actions">
        <span class="queue-status ${item.scheduled ? "scheduled" : ""}">${escapeHtml(item.status)}</span>
        <button class="queue-publish" type="button" data-publish-id="${item.id}">${item.scheduled ? "View" : "Post now"}</button>
      </div>
    </article>
  `).join("");
  $$('[data-publish-id]', root).forEach((button) => button.addEventListener("click", () => publishDraft(Number(button.dataset.publishId))));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function updateDuration(seconds) {
  state.seconds = Number(seconds);
  $$("#lengthOptions button").forEach((button) => button.classList.toggle("active", Number(button.dataset.seconds) === state.seconds));
  $("#durationBadge").textContent = `00:${String(state.seconds).padStart(2, "0")}`;
  $("#previewTime").nextElementSibling.textContent = `/ 0:${String(state.seconds).padStart(2, "0")}`;
  resetPreview();
}

function resetPreview() {
  clearInterval(state.timer);
  state.playing = false;
  state.elapsed = 0;
  $("#playButton").textContent = "▶";
  $("#previewTime").textContent = "0:00";
  $("#previewProgress").style.width = "0%";
}

function togglePreview() {
  if (state.playing) {
    clearInterval(state.timer);
    state.playing = false;
    $("#playButton").textContent = "▶";
    return;
  }
  state.playing = true;
  $("#playButton").textContent = "Ⅱ";
  state.timer = setInterval(() => {
    state.elapsed += 0.1;
    if (state.elapsed >= state.seconds) state.elapsed = 0;
    $("#previewTime").textContent = `0:${String(Math.floor(state.elapsed)).padStart(2, "0")}`;
    $("#previewProgress").style.width = `${(state.elapsed / state.seconds) * 100}%`;
  }, 100);
}

function buildCaption(topic) {
  const words = topic.trim().replace(/^\d+\s*/, "").split(/\s+/).filter(Boolean).slice(0, 6);
  return (words.length ? words : ["YOUR", "NEXT", "STORY"]).join(" ").toUpperCase();
}

async function generateDraft() {
  const topic = $("#topicInput").value.trim();
  if (topic.length < 8) {
    showToast("Add a little more detail to your topic first.");
    $("#topicInput").focus();
    return;
  }
  const platforms = [$("#tiktokCheck").checked && "TikTok", $("#youtubeCheck").checked && "YouTube"].filter(Boolean);
  if (!platforms.length) {
    showToast("Choose at least one publishing platform.");
    return;
  }

  const button = $("#generateButton");
  const original = button.innerHTML;
  button.disabled = true;
  let runwayTaskId = null;
  if (API_BASE_URL) {
    button.innerHTML = "<span>Starting Runway render…</span>";
    try {
      runwayTaskId = await startRunwayGeneration(topic);
    } catch (error) {
      button.disabled = false;
      button.innerHTML = original;
      showToast(error.message || "Runway could not start this render.");
      return;
    }
  } else {
    button.innerHTML = "<span>Writing hook…</span>";
    await wait(700);
    button.innerHTML = "<span>Building scenes…</span>";
    await wait(850);
    button.innerHTML = "<span>Adding voice + captions…</span>";
    await wait(800);
  }

  const draft = {
    id: Date.now(),
    title: topic,
    niche: $("#nicheSelect").value,
    duration: state.seconds,
    status: runwayTaskId ? "Runway · queued" : "Draft",
    scheduled: false,
    platforms,
    runwayTaskId
  };
  state.queue.unshift(draft);
  persistQueue();
  $("#previewCaption").textContent = buildCaption(topic);
  button.disabled = false;
  button.innerHTML = original;
  showToast(runwayTaskId ? "Runway render started. You can track it in Publishing." : "Draft created and added to your publishing queue.");
  resetPreview();
  if (runwayTaskId) void trackRunwayTask(runwayTaskId, draft.id);
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function runwayPrompt(topic) {
  const style = state.template.toLowerCase();
  const tone = $("#toneSelect").value.toLowerCase();
  return `Vertical 9:16 faceless short-form video visual about ${topic}. ${tone} pacing, ${style} visual direction, cinematic lighting, strong movement, no visible presenter, no logos, no watermarks, no on-screen text.`;
}

async function startRunwayGeneration(topic) {
  const response = await fetch(`${API_BASE_URL}/api/videos/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      promptText: runwayPrompt(topic),
      duration: Math.min(10, Math.max(5, state.seconds))
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Runway rejected the generation request.");
  return data.taskId;
}

async function trackRunwayTask(taskId, draftId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(5000);
    try {
      const response = await fetch(`${API_BASE_URL}/api/videos/${encodeURIComponent(taskId)}/status`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Status check failed");
      const draft = state.queue.find((item) => item.id === draftId);
      if (!draft) return;
      const normalized = String(data.status || "RUNNING").toUpperCase();
      draft.status = normalized === "SUCCEEDED" ? "Runway · ready" : `Runway · ${normalized.toLowerCase()}`;
      if (normalized === "SUCCEEDED") {
        draft.outputUrl = data.output?.[0] || "";
        persistQueue();
        renderQueue();
        if (draft.outputUrl) loadGeneratedVideo(draft.outputUrl);
        showToast("Your Runway video clip is ready.");
        return;
      }
      if (["FAILED", "CANCELLED"].includes(normalized)) {
        draft.status = "Runway · failed";
        persistQueue();
        renderQueue();
        showToast("Runway could not complete this clip.");
        return;
      }
      persistQueue();
      if (state.view === "queue") renderQueue();
    } catch {
      if (attempt > 4) return;
    }
  }
}

function loadGeneratedVideo(url) {
  const video = $("#renderedVideo");
  video.src = url;
  $("#videoPreview").classList.add("has-render");
  video.play().catch(() => {});
}

function openConnectDialog(platform) {
  const dialog = $("#connectDialog");
  $("#dialogTitle").textContent = `Connect ${platform}`;
  $("#dialogCopy").innerHTML = API_BASE_URL
    ? `Continue to ${platform} to authorize publishing for this workspace.`
    : `Add the secure backend URL in <code>app.js</code>. This button will then start the official ${platform} OAuth flow.`;
  if (API_BASE_URL) {
    window.location.href = `${API_BASE_URL}/auth/${platform.toLowerCase()}`;
    return;
  }
  dialog.showModal();
}

async function checkRunwayConnection() {
  if (!API_BASE_URL) {
    $("#dialogTitle").textContent = "Configure Runway";
    $("#dialogCopy").innerHTML = "Deploy the included <code>backend</code> folder, save your Runway key as <code>RUNWAYML_API_SECRET</code>, then add the backend URL to <code>config.js</code>.";
    $("#connectDialog").showModal();
    return;
  }
  const button = $("#runwayTestButton");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (!response.ok) throw new Error();
    $("#runwayStatus").textContent = "Ready";
    $("#modePill").lastChild.textContent = " Runway ready";
    showToast("Runway backend is reachable.");
  } catch {
    $("#runwayStatus").textContent = "Needs attention";
    showToast("The Runway backend could not be reached.");
  } finally {
    button.disabled = false;
    button.textContent = "Check Runway";
  }
}

async function publishDraft(id) {
  const item = state.queue.find((video) => video.id === id);
  if (!item) return;
  if (item.scheduled) {
    showToast(`${item.title} is ${item.status.toLowerCase()}.`);
    return;
  }
  if (!API_BASE_URL) {
    setView("connections");
    showToast("Connect a secure publishing service before posting.");
    return;
  }
  if (item.runwayTaskId && !item.outputUrl) {
    showToast("Wait for the Runway render to finish before publishing.");
    return;
  }
  const response = await fetch(`${API_BASE_URL}/api/videos/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id: item.id, videoUrl: item.outputUrl, platforms: item.platforms })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(data.error || "Connect TikTok or YouTube before publishing.");
    return;
  }
  item.status = "Publishing";
  item.scheduled = true;
  persistQueue();
  renderQueue();
  showToast("Publishing started.");
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const topicSchema = {
    type: "object",
    properties: {
      topic: { type: "string", minLength: 8, maxLength: 240 },
      duration: { type: "number", enum: [15, 30, 45, 60] }
    },
    required: ["topic"],
    additionalProperties: false
  };
  context.registerTool({
    name: "create_video_draft",
    title: "Create video draft",
    description: "Create a new faceless short-video draft in GhostFrame's visible publishing queue.",
    inputSchema: topicSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || typeof input.topic !== "string" || input.topic.trim().length < 8) throw new Error("A topic of at least 8 characters is required.");
      $("#topicInput").value = input.topic.trim();
      if (input.duration) updateDuration(input.duration);
      await generateDraft();
      return { status: "drafted", topic: input.topic.trim(), duration: state.seconds };
    }
  });
}

$$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$$('[data-go-studio]').forEach((button) => button.addEventListener("click", () => setView("studio")));
$("#topicInput").addEventListener("input", (event) => { $("#charCount").textContent = `${event.target.value.length} / 240`; });
$$("#lengthOptions button").forEach((button) => button.addEventListener("click", () => updateDuration(button.dataset.seconds)));
$$(".template").forEach((button) => button.addEventListener("click", () => {
  $$(".template").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.template = button.dataset.template;
  $("#videoPreview").dataset.template = state.template.toLowerCase();
}));
$("#generateButton").addEventListener("click", generateDraft);
$("#playButton").addEventListener("click", togglePreview);
$("#muteButton").addEventListener("click", (event) => {
  event.currentTarget.textContent = event.currentTarget.textContent === "⌕" ? "×" : "⌕";
  showToast(event.currentTarget.textContent === "×" ? "Preview muted" : "Preview sound on");
});
$("#themeButton").addEventListener("click", () => document.body.classList.toggle("high-contrast"));
$("#runwayTestButton").addEventListener("click", checkRunwayConnection);
$$(".connect-button").forEach((button) => button.addEventListener("click", () => openConnectDialog(button.dataset.platform)));
$(".dialog-close").addEventListener("click", () => $("#connectDialog").close());
$(".dialog-confirm").addEventListener("click", () => $("#connectDialog").close());

persistQueue();
renderQueue();
registerWebMcpTools();
if (API_BASE_URL) {
  $("#runwayStatus").textContent = "Configured";
  $("#modePill").lastChild.textContent = " Runway configured";
}
const initialView = location.hash.replace("#", "");
if (viewMeta[initialView]) setView(initialView);
