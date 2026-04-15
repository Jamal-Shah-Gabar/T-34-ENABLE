/*
  ENABLE AccessiBot — Frontend Logic
  Co-created with Claude (Anthropic, 2025). Available at: https://claude.ai

  Reference:
    Anthropic (2025) Claude [Large language model]. Available at:
    https://claude.ai (Accessed: April 2026).

  Web Speech API reference:
    Mozilla Developer Network (2024) Web Speech API. Available at:
    https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
    (Accessed: April 2026).
*/

// ── Application state ─────────────────────────────────────────────────────
const state = {
  ttsEnabled:    false,
  captionsEnabled: false,
  sttActive:     false,
  speechRate:    1,

  session: {
    role:     "Student",
    system:   "UoB Intranet",
    scenario: "S1",
  },

  history:      [],   // multi-turn AI conversation history
  taskRunning:  false,
  taskStartMs:  null,
  tickTimer:    null,
  backendOk:    false,
  backendAiMode: false,

  // Auto-detects the server origin — works locally and on Render
  backendBase: window.location.origin,
};

// ── DOM references ────────────────────────────────────────────────────────
const chatMessages  = document.getElementById("chat-messages");
const chatInput     = document.getElementById("chat-input");
const btnSend       = document.getElementById("btn-send");
const captionBar    = document.getElementById("caption-bar");
const speedSelect   = document.getElementById("speed-select");
const roleSelect    = document.getElementById("role-select");
const systemSelect  = document.getElementById("system-select");
const scenarioSelect = document.getElementById("scenario-select");
const btnStart      = document.getElementById("btn-start");
const btnFinish     = document.getElementById("btn-finish");
const btnReport     = document.getElementById("btn-report");
const btnExport     = document.getElementById("btn-export");
const timerText     = document.getElementById("timer-text");
const backendText   = document.getElementById("backend-text");
const modalBackdrop = document.getElementById("modal-backdrop");
const issueModal    = document.getElementById("issue-modal");
const btnCloseModal = document.getElementById("btn-close-modal");
const btnSubmitIssue = document.getElementById("btn-submit-issue");
const issueUrl      = document.getElementById("issue-url");
const issueCategory = document.getElementById("issue-category");
const issueSeverity = document.getElementById("issue-severity");
const issueWhat     = document.getElementById("issue-what");
const issueExpected = document.getElementById("issue-expected");
const issueSuggestion = document.getElementById("issue-suggestion");

// ── Offline localStorage queue ────────────────────────────────────────────
const QUEUE_KEY = "enable_accessibot_queue";

function queueAdd(record) {
  const arr = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  arr.push(record);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(arr));
}

function queueGetAll() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
}

// ── Input events ──────────────────────────────────────────────────────────
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + "px";
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

btnSend.addEventListener("click", sendMessage);
speedSelect.addEventListener("change", () => { state.speechRate = parseFloat(speedSelect.value); });

// ── Session selector events ───────────────────────────────────────────────
roleSelect.addEventListener("change", () => {
  state.session.role = roleSelect.value;
  logEvent("scenario_change", { field: "role", value: state.session.role });
});

systemSelect.addEventListener("change", () => {
  state.session.system = systemSelect.value;
  logEvent("scenario_change", { field: "system", value: state.session.system });
});

scenarioSelect.addEventListener("change", () => {
  state.session.scenario = scenarioSelect.value;
  state.history = [];
  logEvent("scenario_change", { field: "scenario", value: state.session.scenario });
  appendMessage("bot", "Scenario changed — ask me anything about it, or click Start for guidance.");
});

// ── Button bindings ───────────────────────────────────────────────────────
btnStart.addEventListener("click", startTask);
btnFinish.addEventListener("click", finishTask);
btnReport.addEventListener("click", openModal);
btnExport.addEventListener("click", exportEvidence);
btnCloseModal.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", closeModal);
btnSubmitIssue.addEventListener("click", submitIssue);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !issueModal.hidden) closeModal(); });

// ── Backend health check — runs on load then every 30 seconds ─────────────
(async function init() {
  await checkBackend();
  setInterval(checkBackend, 30000);
})();

async function checkBackend() {
  try {
    const res  = await fetch(state.backendBase + "/health");
    if (!res.ok) throw new Error();
    const data = await res.json();
    state.backendOk      = true;
    state.backendAiMode  = data.mode === "ai";
    backendText.textContent = state.backendAiMode
      ? "Backend: connected ✦ AI (Llama 3)"
      : "Backend: connected (offline mode — check GROQ_API_KEY)";
  } catch {
    state.backendOk = false;
    backendText.textContent = "Backend: not reachable";
  }
}

// ── Send a message ────────────────────────────────────────────────────────
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage("user", text);
  chatInput.value = "";
  chatInput.style.height = "auto";
  state.history.push({ role: "user", content: text });

  const typingId = showTyping();

  try {
    const reply = await fetchReply(text);
    removeTyping(typingId);
    state.history.push({ role: "assistant", content: reply });
    if (state.history.length > 20) state.history = state.history.slice(-20);
    appendMessage("bot", reply, true);
    if (state.ttsEnabled)       speak(reply);
    if (state.captionsEnabled)  showCaption(reply);
  } catch {
    removeTyping(typingId);
    appendMessage("bot", "I couldn't reach the server. Please check your connection and try again.", false);
  }
}

async function fetchReply(message) {
  const res = await fetch(state.backendBase + "/chat", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session: state.session,
      history: state.history.slice(0, -1),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.reply;
}

// ── Evidence logging ──────────────────────────────────────────────────────
async function logEvent(type, payload) {
  const record = {
    type,
    session: { ...state.session },
    payload: payload || {},
    ts: new Date().toISOString(),
  };

  if (!state.backendOk) { queueAdd(record); return; }

  try {
    await fetch(state.backendBase + "/feedback", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(record),
    });
  } catch {
    state.backendOk = false;
    queueAdd(record);
  }
}

// ── Task timing ───────────────────────────────────────────────────────────
function startTask() {
  if (state.taskRunning) {
    appendMessage("bot", "Task is already running — press Finish when you're done.", false);
    return;
  }

  state.taskRunning = true;
  state.taskStartMs = Date.now();
  timerText.textContent = "Running… 00:00";
  btnStart.classList.add("active");
  logEvent("task_start", { scenario: state.session.scenario });

  chatInput.value = `I've just started scenario ${state.session.scenario} as a ${state.session.role} testing the ${state.session.system}. Please give me step-by-step guidance for this scenario.`;
  sendMessage();

  state.tickTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - state.taskStartMs) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    timerText.textContent = `Running… ${m}:${s}`;
  }, 1000);
}

function finishTask() {
  if (!state.taskRunning) {
    appendMessage("bot", "No task is running — click Start to begin.", false);
    return;
  }

  const sec = Math.floor((Date.now() - state.taskStartMs) / 1000);
  clearInterval(state.tickTimer);
  state.taskRunning = false;
  btnStart.classList.remove("active");
  timerText.textContent = `Finished in ${sec}s`;
  logEvent("task_finish", { scenario: state.session.scenario, duration_sec: sec });

  chatInput.value = `I've finished the scenario. It took ${sec} seconds. Can you give me a brief summary of the key things I should have checked, and any common issues testers find in this scenario?`;
  sendMessage();
}

// ── Issue modal ───────────────────────────────────────────────────────────
function openModal() {
  modalBackdrop.hidden = false;
  issueModal.hidden    = false;
  setTimeout(() => issueUrl.focus(), 50);
}

function closeModal() {
  modalBackdrop.hidden = true;
  issueModal.hidden    = true;
}

async function submitIssue() {
  const payload = {
    url:        issueUrl.value.trim(),
    category:   issueCategory.value,
    severity:   issueSeverity.value,
    what:       issueWhat.value.trim(),
    expected:   issueExpected.value.trim(),
    suggestion: issueSuggestion.value.trim(),
    scenario:   state.session.scenario,
  };

  if (!payload.what) {
    alert("Please describe what happened before submitting.");
    return;
  }

  await logEvent("accessibility_issue", payload);
  closeModal();

  issueUrl.value = "";
  issueWhat.value = "";
  issueExpected.value = "";
  issueSuggestion.value = "";

  chatInput.value = `I just reported a ${payload.severity} ${payload.category} issue: "${payload.what}". What they expected: "${payload.expected || "not specified"}". Can you suggest a brief improvement recommendation for the ENABLE evidence report?`;
  sendMessage();
}

// ── Export evidence ───────────────────────────────────────────────────────
async function exportEvidence() {
  if (state.backendOk) {
    window.open(state.backendBase + "/feedback/download", "_blank");
    return;
  }
  const data = queueGetAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = "enable_evidence_local.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── DOM helpers ───────────────────────────────────────────────────────────
function appendMessage(sender, text, addActions = false) {
  const row = document.createElement("div");
  row.classList.add("message", sender);
  row.setAttribute("data-sender", sender);

  const avatar = document.createElement("div");
  avatar.classList.add("avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = sender === "bot" ? "◈" : "👤";

  const bubble = document.createElement("div");
  bubble.classList.add("bubble");

  text.split("\n").forEach(line => {
    if (line.trim()) {
      const p = document.createElement("p");
      p.textContent = line;
      bubble.appendChild(p);
    }
  });

  if (sender === "bot" && addActions) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const btnUp = makeChip("👍 Helpful", async () => {
      await logEvent("quick_feedback", { helpful: true });
      btnUp.textContent = "👍 Saved";
      btnUp.disabled = true;
    });
    const btnDown = makeChip("👎 Not helpful", async () => {
      await logEvent("quick_feedback", { helpful: false });
      btnDown.textContent = "👎 Saved";
      btnDown.disabled = true;
    });
    const btnIssue = makeChip("⚑ Report issue", () => openModal(), true);

    actions.appendChild(btnUp);
    actions.appendChild(btnDown);
    actions.appendChild(btnIssue);
    bubble.appendChild(actions);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollToBottom();
}

function makeChip(label, onClick, warn = false) {
  const btn = document.createElement("button");
  btn.className = "action-chip" + (warn ? " warn" : "");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

let typingCounter = 0;
function showTyping() {
  const id  = "typing-" + (++typingCounter);
  const row = document.createElement("div");
  row.classList.add("message", "bot");
  row.id = id;

  const avatar = document.createElement("div");
  avatar.classList.add("avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "◈";

  const bubble = document.createElement("div");
  bubble.classList.add("bubble");
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

  row.appendChild(avatar);
  row.appendChild(bubble);
  chatMessages.appendChild(row);
  scrollToBottom();
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Text-to-speech ────────────────────────────────────────────────────────
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate  = state.speechRate;
  utt.lang  = "en-GB";
  window.speechSynthesis.speak(utt);
}

// ── Caption bar ───────────────────────────────────────────────────────────
function showCaption(text) {
  captionBar.removeAttribute("hidden");
  captionBar.textContent = "🗣 " + text;
  clearTimeout(captionBar._timeout);
  captionBar._timeout = setTimeout(() => {
    captionBar.hidden      = true;
    captionBar.textContent = "";
  }, 8000);
}

// ── Speech-to-text ────────────────────────────────────────────────────────
let recognition = null;
const sttBtn = document.getElementById("btn-stt");

if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous     = false;
  recognition.interimResults = true;
  recognition.lang           = "en-GB";

  recognition.onresult = (e) => {
    let t = "";
    for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
    chatInput.value = t;
  };
  recognition.onend = () => {
    state.sttActive = false;
    sttBtn.classList.remove("active");
    sttBtn.textContent = "🎙 Voice input";
  };
  recognition.onerror = () => {
    state.sttActive = false;
    sttBtn.classList.remove("active");
    sttBtn.textContent = "🎙 Voice input";
  };
} else {
  sttBtn.disabled    = true;
  sttBtn.textContent = "🎙 Not supported";
}

function toggleSTT() {
  if (!recognition) return;
  if (state.sttActive) {
    recognition.stop();
  } else {
    recognition.start();
    state.sttActive = true;
    sttBtn.classList.add("active");
    sttBtn.textContent = "⏹ Stop listening";
  }
}

// ── Accessibility controls ────────────────────────────────────────────────
let fontSize = 16;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

document.getElementById("btn-zoom-in").addEventListener("click", () => {
  fontSize = clamp(fontSize + 2, 12, 30);
  document.documentElement.style.setProperty("--font-size", fontSize + "px");
});

document.getElementById("btn-zoom-out").addEventListener("click", () => {
  fontSize = clamp(fontSize - 2, 12, 30);
  document.documentElement.style.setProperty("--font-size", fontSize + "px");
});

function toggleBodyClass(btn, cls) {
  document.body.classList.toggle(cls);
  btn.classList.toggle("active");
}

document.getElementById("btn-contrast").addEventListener("click", function() { toggleBodyClass(this, "high-contrast"); });
document.getElementById("btn-dyslexia").addEventListener("click", function() { toggleBodyClass(this, "dyslexia-font"); });
document.getElementById("btn-focus").addEventListener("click",    function() { toggleBodyClass(this, "focus-mode"); });

document.getElementById("btn-tts").addEventListener("click", function() {
  state.ttsEnabled = !state.ttsEnabled;
  this.classList.toggle("active", state.ttsEnabled);
  this.textContent = state.ttsEnabled ? "🔇 Stop reading" : "▶ Read aloud";
  if (!state.ttsEnabled) window.speechSynthesis?.cancel();
});

document.getElementById("btn-captions").addEventListener("click", function() {
  state.captionsEnabled = !state.captionsEnabled;
  this.classList.toggle("active", state.captionsEnabled);
  if (!state.captionsEnabled) {
    captionBar.setAttribute("hidden", "");
    captionBar.textContent = "";
  }
});

sttBtn.addEventListener("click", toggleSTT);

document.getElementById("btn-clear").addEventListener("click", () => {
  if (!confirm("Clear all messages and start fresh?")) return;
  chatMessages.innerHTML = "";
  state.history = [];
  window.speechSynthesis?.cancel();
  captionBar.setAttribute("hidden", "");
  timerText.textContent = "Not started";
  fontSize = 16;
  document.documentElement.style.setProperty("--font-size", "16px");
});
