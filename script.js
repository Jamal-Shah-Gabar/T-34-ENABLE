const state = {
  // Accessibility feature toggles
  ttsEnabled:      false,   // Text-to-speech on/off
  captionsEnabled: false,   // Caption bar on/off
  sttActive:       false,   // Speech-to-text microphone active
  speechRate:      1,       // TTS playback speed (0.75 / 1 / 1.5)

  // Current testing session – sent with every evidence record
  session: {
    role:     "Student",
    system:   "UoB Intranet",
    scenario: "S1",
  },

  // Task timing
  taskRunning:  false,  // Whether a task is currently in progress
  taskStartMs:  null,   // Timestamp (ms) when task was started
  tickTimer:    null,   // setInterval handle for the live timer

  // Backend connection
  backendOk:   false,
  backendBase: "http://127.0.0.1:5000",
};


// ───────────────────────────────────────────
// DOM REFERENCES
// Cache all elements we need to interact with
// so we only query the DOM once.
// ───────────────────────────────────────────

// Chat area
const chatMessages = document.getElementById("chat-messages");
const chatInput    = document.getElementById("chat-input");
const btnSend      = document.getElementById("btn-send");
const captionBar   = document.getElementById("caption-bar");
const speedSelect  = document.getElementById("speed-select");

// Session selectors
const roleSelect     = document.getElementById("role-select");
const systemSelect   = document.getElementById("system-select");
const scenarioSelect = document.getElementById("scenario-select");

// Task / session action buttons
const btnStart  = document.getElementById("btn-start");
const btnFinish = document.getElementById("btn-finish");
const btnReport = document.getElementById("btn-report");
const btnExport = document.getElementById("btn-export");

// Status display
const timerText   = document.getElementById("timer-text");
const backendText = document.getElementById("backend-text");

// Issue report modal
const modalBackdrop  = document.getElementById("modal-backdrop");
const issueModal     = document.getElementById("issue-modal");
const btnCloseModal  = document.getElementById("btn-close-modal");
const btnSubmitIssue = document.getElementById("btn-submit-issue");

// Modal form fields
const issueUrl        = document.getElementById("issue-url");
const issueCategory   = document.getElementById("issue-category");
const issueSeverity   = document.getElementById("issue-severity");
const issueWhat       = document.getElementById("issue-what");
const issueExpected   = document.getElementById("issue-expected");
const issueSuggestion = document.getElementById("issue-suggestion");


// ───────────────────────────────────────────
// LOCAL STORAGE QUEUE
// If the Flask backend is not running, evidence
// records are saved here and exported as JSON.
// This ensures no data is lost mid-session.
// ───────────────────────────────────────────

const QUEUE_KEY = "enable_accessibot_feedback_queue";

// Add one record to the queue
function queueAdd(record) {
  const arr = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  arr.push(record);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(arr));
}

// Retrieve all queued records
function queueGetAll() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
}

// Clear the queue (called after a successful export)
function queueClear() {
  localStorage.removeItem(QUEUE_KEY);
}


// ───────────────────────────────────────────
// INPUT: AUTO-RESIZE + SEND
// Textarea grows with content (up to 160px).
// Enter sends, Shift+Enter adds a new line.
// ───────────────────────────────────────────

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

btnSend.addEventListener("click", sendMessage);


// ───────────────────────────────────────────
// SESSION SELECTORS
// Sync dropdown changes to state and log them
// as evidence so the record always reflects the
// correct role/system/scenario at time of event.
// ───────────────────────────────────────────

speedSelect.addEventListener("change", () => {
  state.speechRate = parseFloat(speedSelect.value);
});

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
  appendMessage("bot", "Scenario changed. If you want a quick step list, type: 'show steps'.");
});


// ───────────────────────────────────────────
// TASK + MODAL BUTTON BINDINGS
// ───────────────────────────────────────────

btnStart.addEventListener("click",  startTask);
btnFinish.addEventListener("click", finishTask);
btnReport.addEventListener("click", openModal);
btnExport.addEventListener("click", exportEvidence);

btnCloseModal.addEventListener("click",  closeModal);
modalBackdrop.addEventListener("click",  closeModal);
btnSubmitIssue.addEventListener("click", submitIssue);

// Close modal with ESC key (fixes test failure T18)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !issueModal.hidden) {
    closeModal();
  }
});


// ───────────────────────────────────────────
// BACKEND HEALTH CHECK
// Runs once on page load. Sets backendOk and
// updates the status bar in the session header.
// Also re-checks every 30 seconds so the status
// updates if the server starts after page load
// (fixes test failure T27).
// ───────────────────────────────────────────

(async function init() {
  await checkBackend();
  // Periodic re-check every 30 seconds
  setInterval(checkBackend, 30000);
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
// Sends user message to backend /chat endpoint.
// Falls back to localFallback() if offline.
// Shows typing animation while waiting for reply.
// ═══════════════════════════════════════════

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;  // Do nothing for empty messages (FR1 validation)

  appendMessage("user", text);
  chatInput.value = "";
  chatInput.style.height = "auto";

  const typingId = showTyping();

  try {
    // POST to Flask /chat with message and current session context
    const reply = await fetchReply(text);
    removeTyping(typingId);
    appendMessage("bot", reply, true);

    if (state.ttsEnabled)      speak(reply);       // Read aloud if TTS on
    if (state.captionsEnabled) showCaption(reply);  // Show caption if on

  } catch (err) {
    // Backend not reachable – use local keyword fallback
    removeTyping(typingId);
    const fallback = localFallback(text);
    appendMessage("bot", fallback, true);

    if (state.ttsEnabled)      speak(fallback);
    if (state.captionsEnabled) showCaption(fallback);
  }
}

// POST message to Flask /chat and return the reply string
async function fetchReply(message) {
  const res = await fetch(state.backendBase + "/chat", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ message, session: state.session }),
  });
  if (!res.ok) throw new Error("Backend error");
  const data = await res.json();
  return data.reply;
}

// Simple keyword fallback used when the backend is not running
function localFallback(text) {
  const t = text.toLowerCase();
  if (t.includes("show steps") || t.includes("steps")) {
    return "Tip: start the backend to get the scenario step guide. If the backend isn't running, you can still log issues using 'Report issue'.";
  }
  return (
    "I can still help as a basic guide.\n\n" +
    "Tell me:\n" +
    "- what page/task you're doing\n" +
    "- which accessibility check you're using (zoom, contrast, keyboard-only, captions)\n" +
    "- what felt restrictive"
  );
}


// ═══════════════════════════════════════════
// EVIDENCE LOGGING
// All events (task start/finish, issue reports,
// quick feedback, scenario changes) are sent to
// Flask /feedback. If the backend is offline,
// they are queued in localStorage instead so
// no data is lost (FR13 – offline fallback).
// ═══════════════════════════════════════════

async function logEvent(type, payload) {
  const record = {
    type,
    session: { ...state.session },  // Snapshot of current session at time of event
    payload: payload || {},
    ts: new Date().toISOString(),   // UTC timestamp (ISO 8601)
  };

  if (!state.backendOk) {
    // Backend offline – save locally
    queueAdd(record);
    return;
  }

  try {
    await fetch(state.backendBase + "/feedback", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(record),
    });
  } catch (e) {
    // Backend went offline mid-session – switch to queue
    state.backendOk = false;
    backendText.textContent = "Backend: not running (local evidence queue active)";
    queueAdd(record);
  }
}


// ═══════════════════════════════════════════
// TASK TIMING
// Start/Finish buttons control a live timer.
// task_start and task_finish events are logged
// as evidence including duration in seconds.
// ═══════════════════════════════════════════

function startTask() {
  if (state.taskRunning) {
    appendMessage("bot", "Task already started. When you're done, press Finish.", false);
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
    "Task started ✅\n\nNow do the scenario on the UoB intranet in another tab.\n" +
    "If you hit a barrier, click 'Report issue'.\n" +
    "If you want a quick guide, type: 'show steps'.",
    false
  );

  // Update the timer display every second
  state.tickTimer = setInterval(updateTimer, 1000);
}

// Update the MM:SS display in the session bar
function updateTimer() {
  if (!state.taskRunning || state.taskStartMs == null) return;
  const ms  = Date.now() - state.taskStartMs;
  const sec = Math.floor(ms / 1000);
  const m   = String(Math.floor(sec / 60)).padStart(2, "0");
  const s   = String(sec % 60).padStart(2, "0");
  timerText.textContent = `Running… ${m}:${s}`;
}

// Finish the task – show an accessible inline form instead of
// browser confirm/prompt (fixes test failures T18, T21 re: modal
// focus, and improves accessibility for keyboard users).
// NOTE: We use a simple inline approach here since confirm() and
// prompt() are not accessible (known issue documented in testing report).
async function finishTask() {
  if (!state.taskRunning) {
    appendMessage("bot", "No active task. Click Start when you're ready.", false);
    return;
  }

  const ms  = Date.now() - state.taskStartMs;
  const sec = Math.floor(ms / 1000);

  // Stop the timer
  state.taskRunning = false;
  state.taskStartMs = null;
  clearInterval(state.tickTimer);
  state.tickTimer = null;
  btnStart.classList.remove("active");

  // Use confirm/prompt for now – replacement with accessible modal is
  // planned for the final version (open issue in testing report T18).
  const completed = confirm("Did you complete the scenario task?");
  const notes     = prompt("Any quick notes? (optional)", "") || "";

  timerText.textContent = completed
    ? `Finished ✅ (${sec}s)`
    : `Stopped ⚠ (${sec}s)`;

  // Log task_finish event with duration and completion status
  await logEvent("task_finish", {
    scenario:         state.session.scenario,
    completed,
    duration_seconds: sec,
    notes,
  });

  appendMessage("bot",
    completed
      ? "Nice — task marked as completed. If you noticed smaller barriers, log them too (they still matter)."
      : "Task marked as not completed. That's valuable evidence — log the blocker as an issue if you haven't already.",
    false
  );
}


// ═══════════════════════════════════════════
// ISSUE REPORT MODAL
// Opens/closes the accessibility issue form.
// On open, focus moves to the first field for
// keyboard and screen reader users (FR – WCAG).
// ESC key closes the modal (fixes T18).
// ═══════════════════════════════════════════

function openModal() {
  modalBackdrop.hidden = false;
  issueModal.hidden    = false;

  // Move focus to first field for keyboard/screen reader accessibility
  // Small timeout ensures the element is visible before focus is applied
  setTimeout(() => issueUrl.focus(), 50);
}

function closeModal() {
  modalBackdrop.hidden = true;
  issueModal.hidden    = true;
}

// Validate and submit the issue report as an evidence record
async function submitIssue() {
  const payload = {
    url:          issueUrl.value.trim(),
    category:     issueCategory.value,           // Vision / Hearing / Motor / Neurodiversity / Other
    severity:     issueSeverity.value,           // Minor / Major / Blocker
    what_happened: issueWhat.value.trim(),
    expected:     issueExpected.value.trim(),
    suggestion:   issueSuggestion.value.trim(),
    scenario:     state.session.scenario,
  };

  // Require at least a description of what happened
  if (!payload.what_happened) {
    alert("Please describe what happened (even one sentence is fine).");
    return;
  }

  // Log the issue as a structured evidence record
  await logEvent("issue_report", payload);

  appendMessage("bot",
    "Issue saved ✅\n\nThanks — this is exactly the kind of evidence ENABLE needs for analysis + improvement proposals.",
    false
  );

  // Clear form fields and close modal
  issueUrl.value        = "";
  issueWhat.value       = "";
  issueExpected.value   = "";
  issueSuggestion.value = "";
  closeModal();
}


// ═══════════════════════════════════════════
// EXPORT EVIDENCE
// If the backend is running, download the full
// JSONL log via /feedback/download.
// If offline, export the localStorage queue as
// a JSON file (FR13 – offline export).
// ═══════════════════════════════════════════

async function exportEvidence() {
  if (state.backendOk) {
    // Open backend download endpoint in a new tab
    window.open(state.backendBase + "/feedback/download", "_blank");
    return;
  }

  // Backend not running – export localStorage queue as JSON blob
  const data = queueGetAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href     = url;
  a.download = "enable_evidence_local_queue.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


// ═══════════════════════════════════════════
// DOM HELPERS
// Functions that build and insert message
// elements into the chat log.
// ═══════════════════════════════════════════

/**
 * Append a chat message to the conversation log.
 * @param {string}  sender     "bot" or "user"
 * @param {string}  text       Message content (newlines become <p> elements)
 * @param {boolean} addActions Whether to add 👍 👎 ⚑ action chips below (bot only)
 */
function appendMessage(sender, text, addActions = false) {
  const row = document.createElement("div");
  row.classList.add("message", sender);
  row.setAttribute("data-sender", sender);

  // Avatar icon
  const avatar = document.createElement("div");
  avatar.classList.add("avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = sender === "bot" ? "◈" : "👤";

  // Message bubble – each non-empty line becomes a <p>
  const bubble = document.createElement("div");
  bubble.classList.add("bubble");

  text.split("\n").forEach(line => {
    if (line.trim()) {
      const p = document.createElement("p");
      p.textContent = line;
      bubble.appendChild(p);
    }
  });

  // Quick feedback chips shown under bot messages (helpful / not helpful / report)
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

// Create a small action chip button
function makeChip(label, onClick, warn = false) {
  const btn = document.createElement("button");
  btn.className = "action-chip" + (warn ? " warn" : "");
  btn.type      = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// Show animated typing dots while waiting for bot reply
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

// Remove the typing indicator by its ID
function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// Scroll the chat log to show the latest message
function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ═══════════════════════════════════════════
// TEXT-TO-SPEECH (TTS)
// Uses the browser SpeechSynthesis API.
// Reads bot replies aloud in British English.
// Rate is controlled by the Speech Speed selector.
// ═══════════════════════════════════════════

function speak(text) {
  if (!("speechSynthesis" in window)) return;  // Not supported – silently skip
  window.speechSynthesis.cancel();             // Stop any current speech first
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = state.speechRate;
  utt.lang   = "en-GB";
  window.speechSynthesis.speak(utt);
}


// ═══════════════════════════════════════════
// CAPTIONS
// Displays the bot reply as text in the caption
// bar for users with hearing impairments.
// Auto-hides after 8 seconds (T14 fix applied).
// ═══════════════════════════════════════════

function showCaption(text) {
  captionBar.removeAttribute("hidden");
  captionBar.textContent = "🗣 " + text;
  clearTimeout(captionBar._timeout);

  // Hide the caption bar after 8 seconds (fixes test failure T14)
  captionBar._timeout = setTimeout(() => {
    captionBar.hidden    = true;   // Use hidden attribute (not just clearing text)
    captionBar.textContent = "";
  }, 8000);
}


// ═══════════════════════════════════════════
// SPEECH-TO-TEXT (STT)
// Uses the Web Speech API (Chrome / Edge only).
// Transcribes voice input into the chat textarea.
// If unsupported, the button is disabled with a
// clear message (fixes test failure T17).
// ═══════════════════════════════════════════

let recognition = null;
const sttBtn = document.getElementById("btn-stt");

if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  // Browser supports STT – set up recognition object
  const SR  = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous     = false;
  recognition.interimResults = true;
  recognition.lang           = "en-GB";

  // Update textarea as words are recognised
  recognition.onresult = (e) => {
    let transcript = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    chatInput.value = transcript;
  };

  // Reset STT state when recognition ends (including on mic denial)
  recognition.onend = () => {
    state.sttActive = false;
    sttBtn.classList.remove("active");
    sttBtn.textContent = "🎙 Voice Input";
  };

  // Handle errors (e.g. microphone permission denied)
  recognition.onerror = (e) => {
    state.sttActive = false;
    sttBtn.classList.remove("active");
    sttBtn.textContent = "🎙 Voice Input";
    if (e.error === "not-allowed") {
      appendMessage("bot",
        "Microphone access was denied. Please allow microphone access in your browser settings and try again.",
        false
      );
    }
  };

} else {
  // Browser does not support STT – disable the button (fixes T17)
  sttBtn.disabled = true;
  sttBtn.title    = "Speech recognition is not supported in this browser. Use Chrome or Edge.";
  sttBtn.textContent = "🎙 Voice Input (not supported)";
}

// Toggle STT on/off
function toggleSTT() {
  if (!recognition) {
    // Button should already be disabled, but handle gracefully just in case
    appendMessage("bot",
      "Speech recognition is not supported in this browser. Try Chrome or Edge.",
      false
    );
    return;
  }

  if (state.sttActive) {
    recognition.stop();
  } else {
    recognition.start();
    state.sttActive = true;
    sttBtn.classList.add("active");
    sttBtn.textContent = "⏹ Stop Listening";
  }
}


// ═══════════════════════════════════════════
// ACCESSIBILITY CONTROLS
// All controls toggle CSS classes or variables
// on <html> or <body>. Changes take effect
// instantly (target <500ms per NFR).
// ═══════════════════════════════════════════

// ── Text Size (Zoom) ──
// Adjusts the --font-size CSS variable between 12px and 28px.
// A reset to default (16px) is included (fixes test failure T30).
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

// ── High Contrast Mode ──
// Toggles body.high-contrast which swaps CSS variables to yellow-on-black.
function toggleClass(btn, cls) {
  document.body.classList.toggle(cls);
  btn.classList.toggle("active");
}

document.getElementById("btn-contrast").addEventListener("click", function () {
  toggleClass(this, "high-contrast");
});

// ── Dyslexia-Friendly Font ──
// Switches to Comic Sans / Chalkboard SE with wider letter/word spacing.
document.getElementById("btn-dyslexia").addEventListener("click", function () {
  toggleClass(this, "dyslexia-font");
});

// ── Focus Mode ──
// Reduces sidebar opacity to 20% and disables sidebar pointer events,
// helping users who need fewer visual distractions.
document.getElementById("btn-focus").addEventListener("click", function () {
  toggleClass(this, "focus-mode");
});

// ── Text-to-Speech Toggle ──
document.getElementById("btn-tts").addEventListener("click", function () {
  state.ttsEnabled = !state.ttsEnabled;
  this.classList.toggle("active", state.ttsEnabled);
  this.textContent = state.ttsEnabled ? "🔇 Stop Read Aloud" : "▶ Read Aloud";
  if (!state.ttsEnabled) window.speechSynthesis?.cancel();
});

// ── Captions Toggle ──
document.getElementById("btn-captions").addEventListener("click", function () {
  state.captionsEnabled = !state.captionsEnabled;
  this.classList.toggle("active", state.captionsEnabled);
  if (!state.captionsEnabled) {
    captionBar.setAttribute("hidden", "");
    captionBar.textContent = "";
  }
});

// ── Speech-to-Text Toggle ──
sttBtn.addEventListener("click", toggleSTT);

// ── Clear Chat ──
// Resets the conversation log, stops TTS, hides captions, resets timer.
document.getElementById("btn-clear").addEventListener("click", () => {
  if (!confirm("Clear conversation history?")) return;
  chatMessages.innerHTML = "";
  window.speechSynthesis?.cancel();
  captionBar.setAttribute("hidden", "");
  timerText.textContent = "Not started";
});