/* ═══════════════════════════════════════════
   ENABLE AccessiBot – script.js

   Purpose:
   - Guide human testers through scenarios
   - Capture evidence (structured + unstructured)
   - No paid AI required (backend is offline guidance)
═══════════════════════════════════════════ */

// ── State ──────────────────────────────────
const state = {
  ttsEnabled: false,
  captionsEnabled: false,
  sttActive: false,
  speechRate: 1,

  // testing session
  session: {
    role: "Student",
    system: "UoB Intranet",
    scenario: "S1",
  },

  // task timing
  taskRunning: false,
  taskStartMs: null,
  tickTimer: null,

  // backend
  backendOk: false,
  backendBase: "http://127.0.0.1:5000",
};

// ── DOM refs ───────────────────────────────
const chatMessages = document.getElementById("chat-messages");
const chatInput    = document.getElementById("chat-input");
const btnSend      = document.getElementById("btn-send");
const captionBar   = document.getElementById("caption-bar");
const speedSelect  = document.getElementById("speed-select");

const roleSelect     = document.getElementById("role-select");
const systemSelect   = document.getElementById("system-select");
const scenarioSelect = document.getElementById("scenario-select");

const btnStart  = document.getElementById("btn-start");
const btnFinish = document.getElementById("btn-finish");
const btnReport = document.getElementById("btn-report");
const btnExport = document.getElementById("btn-export");

const timerText   = document.getElementById("timer-text");
const backendText = document.getElementById("backend-text");

// modal
const modalBackdrop = document.getElementById("modal-backdrop");
const issueModal = document.getElementById("issue-modal");
const btnCloseModal = document.getElementById("btn-close-modal");
const btnSubmitIssue = document.getElementById("btn-submit-issue");

const issueUrl = document.getElementById("issue-url");
const issueCategory = document.getElementById("issue-category");
const issueSeverity = document.getElementById("issue-severity");
const issueWhat = document.getElementById("issue-what");
const issueExpected = document.getElementById("issue-expected");
const issueSuggestion = document.getElementById("issue-suggestion");

// ── Local storage queue (fallback if backend not running) ──
const QUEUE_KEY = "enable_accessibot_feedback_queue";

function queueAdd(record) {
  const arr = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  arr.push(record);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(arr));
}

function queueGetAll() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
}

function queueClear() {
  localStorage.removeItem(QUEUE_KEY);
}

// ── Auto-resize textarea ───────────────────
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});

// ── Send on Enter (Shift+Enter newline) ──
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
btnSend.addEventListener("click", sendMessage);

// ── Speech speed ───────────────────────────
speedSelect.addEventListener("change", () => {
  state.speechRate = parseFloat(speedSelect.value);
});

// ── Session selectors ──────────────────────
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
  logEvent("scenario_change", { field: "scenario", value: state.session.scenario });

  appendMessage("bot",
    "Scenario changed. If you want a quick step list, type: “show steps”."
  );
});

// ── Task buttons ───────────────────────────
btnStart.addEventListener("click", startTask);
btnFinish.addEventListener("click", finishTask);
btnReport.addEventListener("click", openModal);
btnExport.addEventListener("click", exportEvidence);

// ── Modal buttons ──────────────────────────
btnCloseModal.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", closeModal);
btnSubmitIssue.addEventListener("click", submitIssue);

// ── Check backend ──────────────────────────
(async function init() {
  await checkBackend();
})();

async function checkBackend() {
  try {
    const res = await fetch(state.backendBase + "/health");
    if (!res.ok) throw new Error("health not ok");
    state.backendOk = true;
    backendText.textContent = "Backend: connected";
  } catch (e) {
    state.backendOk = false;
    backendText.textContent = "Backend: not running (local evidence queue active)";
  }
}

// ═══════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage("user", text);
  chatInput.value = "";
  chatInput.style.height = "auto";

  const typingId = showTyping();

  try {
    const reply = await fetchReply(text);
    removeTyping(typingId);
    appendMessage("bot", reply, true);

    if (state.ttsEnabled) speak(reply);
    if (state.captionsEnabled) showCaption(reply);

  } catch (err) {
    removeTyping(typingId);

    // fallback reply (no backend)
    const fallback = localFallback(text);
    appendMessage("bot", fallback, true);

    if (state.ttsEnabled) speak(fallback);
    if (state.captionsEnabled) showCaption(fallback);
  }
}

// backend reply
async function fetchReply(message) {
  const res = await fetch(state.backendBase + "/chat", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ message, session: state.session }),
  });

  if (!res.ok) throw new Error("Backend error");
  const data = await res.json();
  return data.reply;
}

// small offline fallback
function localFallback(text) {
  const t = text.toLowerCase();
  if (t.includes("show steps") || t.includes("steps")) {
    return "Tip: start the backend to get the scenario step guide. If the backend isn’t running, you can still log issues using “Report issue”.";
  }
  return (
    "I can still help as a basic guide.\n\n" +
    "Tell me:\n" +
    "- what page/task you’re doing\n" +
    "- which accessibility check you’re using (zoom, contrast, keyboard-only, captions)\n" +
    "- what felt restrictive"
  );
}

// ═══════════════════════════════════════════
// Evidence logging
// ═══════════════════════════════════════════
async function logEvent(type, payload) {
  const record = {
    type,
    session: {...state.session},
    payload: payload || {},
    ts: new Date().toISOString(),
  };

  if (!state.backendOk) {
    queueAdd(record);
    return;
  }

  try {
    await fetch(state.backendBase + "/feedback", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(record),
    });
  } catch (e) {
    // backend failed mid-session: fall back
    state.backendOk = false;
    backendText.textContent = "Backend: not running (local evidence queue active)";
    queueAdd(record);
  }
}

// ═══════════════════════════════════════════
// Task timing
// ═══════════════════════════════════════════
function startTask() {
  if (state.taskRunning) {
    appendMessage("bot", "Task already started. When you’re done, press Finish.", false);
    return;
  }

  state.taskRunning = true;
  state.taskStartMs = Date.now();
  timerText.textContent = "Running… 00:00";
  btnStart.classList.add("active");

  logEvent("task_start", {
    scenario: state.session.scenario,
    note: "Task started by tester",
  });

  appendMessage("bot",
    "Task started ✅\n\nNow do the scenario on the UoB intranet in another tab.\nIf you hit a barrier, click “Report issue”.\nIf you want a quick guide, type: “show steps”.",
    false
  );

  state.tickTimer = setInterval(updateTimer, 1000);
}

function updateTimer() {
  if (!state.taskRunning || state.taskStartMs == null) return;
  const ms = Date.now() - state.taskStartMs;
  const sec = Math.floor(ms / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  timerText.textContent = `Running… ${m}:${s}`;
}

async function finishTask() {
  if (!state.taskRunning) {
    appendMessage("bot", "No active task. Click Start when you’re ready.", false);
    return;
  }

  const ms = Date.now() - state.taskStartMs;
  const sec = Math.floor(ms / 1000);

  const completed = confirm("Did you complete the scenario task?");
  let notes = prompt("Any quick notes? (optional)", "") || "";

  state.taskRunning = false;
  state.taskStartMs = null;
  clearInterval(state.tickTimer);
  state.tickTimer = null;
  btnStart.classList.remove("active");

  timerText.textContent = completed ? `Finished ✅ (${sec}s)` : `Stopped ⚠ (${sec}s)`;

  await logEvent("task_finish", {
    scenario: state.session.scenario,
    completed,
    duration_seconds: sec,
    notes,
  });

  appendMessage("bot",
    completed
      ? "Nice — task marked as completed. If you noticed smaller barriers, log them too (they still matter)."
      : "Task marked as not completed. That’s valuable evidence — log the blocker as an issue if you haven’t already.",
    false
  );
}

// ═══════════════════════════════════════════
// Issue modal
// ═══════════════════════════════════════════
function openModal() {
  modalBackdrop.hidden = false;
  issueModal.hidden = false;

  // focus first field for accessibility
  setTimeout(() => issueUrl.focus(), 50);
}

function closeModal() {
  modalBackdrop.hidden = true;
  issueModal.hidden = true;
}

async function submitIssue() {
  const payload = {
    url: issueUrl.value.trim(),
    category: issueCategory.value,
    severity: issueSeverity.value,
    what_happened: issueWhat.value.trim(),
    expected: issueExpected.value.trim(),
    suggestion: issueSuggestion.value.trim(),
    scenario: state.session.scenario,
  };

  if (!payload.what_happened) {
    alert("Please describe what happened (even one sentence is fine).");
    return;
  }

  await logEvent("issue_report", payload);

  appendMessage("bot",
    "Issue saved ✅\n\nThanks — this is exactly the kind of evidence ENABLE needs for analysis + improvement proposals.",
    false
  );

  // clear and close
  issueUrl.value = "";
  issueWhat.value = "";
  issueExpected.value = "";
  issueSuggestion.value = "";
  closeModal();
}

// ═══════════════════════════════════════════
// Export evidence
// ═══════════════════════════════════════════
async function exportEvidence() {
  // If backend running, we can simply open the download endpoint in a new tab.
  if (state.backendOk) {
    window.open(state.backendBase + "/feedback/download", "_blank");
    return;
  }

  // Otherwise export local queue as JSON
  const data = queueGetAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "enable_evidence_local_queue.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════
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

  // add quick feedback actions under bot messages
  if (sender === "bot" && addActions) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const btnUp = makeChip("👍 Helpful", async () => {
      await logEvent("quick_feedback", { helpful: true, note: "User marked helpful" });
      btnUp.textContent = "👍 Saved";
      btnUp.disabled = true;
    });

    const btnDown = makeChip("👎 Not helpful", async () => {
      await logEvent("quick_feedback", { helpful: false, note: "User marked not helpful" });
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
  const id = "typing-" + (++typingCounter);
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

// ═══════════════════════════════════════════
// TEXT-TO-SPEECH
// ═══════════════════════════════════════════
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = state.speechRate;
  utt.lang = "en-GB";
  window.speechSynthesis.speak(utt);
}

// ═══════════════════════════════════════════
// CAPTIONS
// ═══════════════════════════════════════════
function showCaption(text) {
  captionBar.removeAttribute("hidden");
  captionBar.textContent = "🗣 " + text;
  clearTimeout(captionBar._timeout);
  captionBar._timeout = setTimeout(() => {
    captionBar.textContent = "";
  }, 8000);
}

// ═══════════════════════════════════════════
// SPEECH-TO-TEXT
// ═══════════════════════════════════════════
let recognition = null;
if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-GB";

  recognition.onresult = (e) => {
    let transcript = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    chatInput.value = transcript;
  };

  recognition.onend = () => {
    state.sttActive = false;
    document.getElementById("btn-stt").classList.remove("active");
    document.getElementById("btn-stt").textContent = "🎙 Voice Input";
  };
}

function toggleSTT() {
  if (!recognition) {
    alert("Speech recognition is not supported in this browser. Try Chrome or Edge.");
    return;
  }
  if (state.sttActive) {
    recognition.stop();
  } else {
    recognition.start();
    state.sttActive = true;
    document.getElementById("btn-stt").classList.add("active");
    document.getElementById("btn-stt").textContent = "⏹ Stop Listening";
  }
}

// ═══════════════════════════════════════════
// ACCESSIBILITY CONTROLS
// ═══════════════════════════════════════════
let fontSize = 16;

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

document.getElementById("btn-zoom-in").addEventListener("click", () => {
  fontSize = clamp(fontSize + 2, 12, 28);
  document.documentElement.style.setProperty("--font-size", fontSize + "px");
});

document.getElementById("btn-zoom-out").addEventListener("click", () => {
  fontSize = clamp(fontSize - 2, 12, 28);
  document.documentElement.style.setProperty("--font-size", fontSize + "px");
});

function toggleClass(btn, cls) {
  document.body.classList.toggle(cls);
  btn.classList.toggle("active");
}

document.getElementById("btn-contrast").addEventListener("click", function () {
  toggleClass(this, "high-contrast");
});

document.getElementById("btn-dyslexia").addEventListener("click", function () {
  toggleClass(this, "dyslexia-font");
});

document.getElementById("btn-focus").addEventListener("click", function () {
  toggleClass(this, "focus-mode");
});

document.getElementById("btn-tts").addEventListener("click", function () {
  state.ttsEnabled = !state.ttsEnabled;
  this.classList.toggle("active", state.ttsEnabled);
  this.textContent = state.ttsEnabled ? "🔇 Stop Read Aloud" : "▶ Read Aloud";
  if (!state.ttsEnabled) window.speechSynthesis?.cancel();
});

document.getElementById("btn-captions").addEventListener("click", function () {
  state.captionsEnabled = !state.captionsEnabled;
  this.classList.toggle("active", state.captionsEnabled);
  if (!state.captionsEnabled) {
    captionBar.setAttribute("hidden", "");
    captionBar.textContent = "";
  }
});

document.getElementById("btn-stt").addEventListener("click", toggleSTT);

document.getElementById("btn-clear").addEventListener("click", () => {
  if (!confirm("Clear conversation history?")) return;
  chatMessages.innerHTML = "";
  window.speechSynthesis?.cancel();
  captionBar.setAttribute("hidden", "");
  timerText.textContent = "Not started";
});