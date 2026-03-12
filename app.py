import os
import json
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from dotenv import load_dotenv

# Load environment variables from .env (e.g. FEEDBACK_PATH)
load_dotenv()

app = Flask(__name__)
CORS(app)  # Allow cross-origin requests from the frontend (index.html)

# Path to the JSONL evidence log file – can be overridden via .env
FEEDBACK_PATH = os.getenv("FEEDBACK_PATH", "feedback.jsonl")


# ───────────────────────────────────────────
# UTILITIES
# Helper functions used across all routes
# ───────────────────────────────────────────

def utc_now_iso() -> str:
    """Return current UTC time in ISO 8601 format for evidence timestamps."""
    return datetime.now(timezone.utc).isoformat()

def safe_load_json(request_obj):
    """Safely parse JSON from a Flask request; return empty dict on failure."""
    try:
        return request_obj.get_json(force=True) or {}
    except Exception:
        return {}

def append_jsonl(path: str, record: dict) -> None:
    """
    Append one JSON record to the evidence log file (one record per line).
    Always stamps with a UTC timestamp if not already present.
    """
    record.setdefault("ts", utc_now_iso())
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# ───────────────────────────────────────────
# SCENARIO DEFINITIONS
# Four structured EPMS testing scenarios.
# Each has a title and a list of step-by-step
# instructions shown to the tester on request.
# ───────────────────────────────────────────

SCENARIOS = {
    "S1": {
        "title": "Find EPMS course/module information",
        "steps": [
            "Open the UoB intranet in another tab.",
            "Try to find a course/module page (EPMS).",
            "Test at 200% zoom. Check if menus and text still work.",
            "Try keyboard-only (Tab/Enter). Can you reach everything?",
            "If anything blocks you, click 'Report issue' and log it."
        ],
    },
    "S2": {
        "title": "Use intranet search to find a staff/contact page",
        "steps": [
            "Use search on the intranet to find a staff profile or contact info.",
            "Test high contrast mode.",
            "Check focus indicator: can you see where you are when tabbing?",
            "If results are confusing/misleading, log it as an issue (clarity)."
        ],
    },
    "S3": {
        "title": "Download a document (PDF) and check clarity",
        "steps": [
            "Find a document link (PDF) on the intranet.",
            "At 200% zoom, check if the link text is clear and descriptive.",
            "If the PDF is scanned or hard to read, log it (vision).",
            "If there's no alternative format, log it as a barrier."
        ],
    },
    "S4": {
        "title": "Complete a simple intranet task (navigation)",
        "steps": [
            "Pick a simple destination page (e.g., timetable, support, forms).",
            "Try to reach it with minimal steps.",
            "Check if labels are clear and not misleading.",
            "If you feel overloaded or lost, log it (neurodiversity/clarity)."
        ],
    },
}


# ───────────────────────────────────────────
# RULE-BASED KEYWORD REPLIES
# Simple keyword matching for common queries.
# No external AI is used in the current version.
# Hugging Face integration is planned for v2.
# ───────────────────────────────────────────

RULE_REPLIES = [
    (["hello", "hi", "hey"],
     "Hi 👋 Tell me what you're testing today (role + scenario), and I'll guide you."),

    (["bye", "goodbye"],
     "No problem — thanks for testing. If you spot more barriers, log them and we'll build a clear evidence list."),

    (["what is enable", "enable project"],
     "ENABLE is about collecting evidence and co-creating more accessible, relaxed learning software — starting with UoB systems like the intranet."),

    (["vision", "zoom", "contrast", "colour"],
     "For vision testing: try 200% zoom, high contrast, and check if layout breaks or text becomes hard to follow."),

    (["hearing", "captions"],
     "For hearing needs: check if videos/audio have captions or transcripts. If not, log it as a barrier."),

    (["neuro", "adhd", "autism", "dyslexia", "overwhelm"],
     "For neurodiversity: watch for overload (too much text, unclear labels, confusing navigation). Log what caused it and what would help."),
]


def offline_reply(message: str, session: dict | None = None) -> str:
    """
    Generate a guidance reply using offline rule-based logic.

    Priority order:
      1. If the message asks for scenario steps, return the step list.
      2. Check RULE_REPLIES for keyword matches.
      3. Fall back to a context-aware prompt asking the tester
         to describe what they are doing.

    No network calls are made. This is the current production behaviour.
    Hugging Face API integration is planned for the final version.
    """
    msg = (message or "").strip()
    low = msg.lower()

    # 1 – Return scenario steps if the tester asks for them
    scenario = (session or {}).get("scenario")
    if scenario and scenario in SCENARIOS and (
        "start" in low or "scenario" in low or "steps" in low
    ):
        sc = SCENARIOS[scenario]
        lines = [f"Scenario {scenario}: {sc['title']}", "", "Quick steps:"]
        for i, step in enumerate(sc["steps"], start=1):
            lines.append(f"{i}) {step}")
        lines.append("")
        lines.append(
            "When you find a barrier, click 'Report issue' and describe "
            "what happened + what you expected."
        )
        return "\n".join(lines)

    # 2 – Keyword match
    for keys, reply in RULE_REPLIES:
        if any(k in low for k in keys):
            return reply

    # 3 – Context-aware default prompt
    role = (session or {}).get("role", "tester")
    system = (session or {}).get("system", "UoB system")
    scenario_text = (
        scenario + " – " + SCENARIOS[scenario]["title"]
        if scenario in SCENARIOS
        else "a scenario"
    )
    return (
        f"Okay — you're acting as: {role}.\n"
        f"System under test: {system}.\n"
        f"Scenario: {scenario_text}.\n\n"
        "Tell me:\n"
        "- What page/task are you doing right now?\n"
        "- Are you testing zoom, contrast, keyboard-only, captions, or focus mode?\n"
        "- What felt restrictive or confusing?"
    )


# ───────────────────────────────────────────
# ROUTES
# ───────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    """
    Health check endpoint.
    The frontend polls this on load to confirm the backend is running.
    Returns: JSON { status, mode, feedback_path }
    """
    return jsonify({
        "status": "ok",
        "mode": "offline",
        "feedback_path": FEEDBACK_PATH
    })


@app.route("/chat", methods=["POST"])
def chat():
    """
    Chat endpoint – receives a tester message and returns an offline reply.

    Expected JSON body:
      { "message": "...", "session": { "role": "...", "system": "...", "scenario": "..." } }

    Also appends a chat_message record to the evidence log.
    Returns: JSON { reply: "..." }
    """
    data = safe_load_json(request)
    message = (data.get("message") or "").strip()
    session = data.get("session") or {}

    # Reject empty messages
    if not message:
        return jsonify({"reply": "I didn't catch that — can you type it again?"})

    # Generate offline reply (rule-based, no external API)
    reply = offline_reply(message, session=session)

    # Log the chat exchange as evidence (non-critical – failure is silent)
    try:
        append_jsonl(FEEDBACK_PATH, {
            "type": "chat_message",
            "session": session,
            "message": message,
            "reply": reply,
        })
    except Exception:
        pass  # Still respond even if logging fails

    return jsonify({"reply": reply})


@app.route("/feedback", methods=["POST"])
def feedback():
    """
    Evidence logging endpoint.
    Receives any structured event from the frontend and appends it to the
    JSONL log. Supported event types:
      task_start | task_finish | issue_report | quick_feedback | scenario_change

    Expected JSON body:
      { "type": "...", "session": {...}, "payload": {...} }

    Returns: JSON { ok: true }
    """
    data = safe_load_json(request)
    record_type = (data.get("type") or "feedback").strip()

    record = {
        "type": record_type,
        "session": data.get("session") or {},
        "payload": data.get("payload") or {},
        "ts": utc_now_iso(),
    }

    append_jsonl(FEEDBACK_PATH, record)
    return jsonify({"ok": True})


@app.route("/feedback/summary", methods=["GET"])
def feedback_summary():
    """
    Summary endpoint – reads the JSONL log and returns aggregate counts.
    Grouped by: event type, issue category, and severity level.
    Used for quick analysis of collected evidence.

    Returns: JSON {
      total, by_type: {...}, by_category: {...}, by_severity: {...}
    }
    """
    summary = {
        "total": 0,
        "by_type": {},
        "by_category": {},
        "by_severity": {},
    }

    if not os.path.exists(FEEDBACK_PATH):
        return jsonify(summary)

    with open(FEEDBACK_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            summary["total"] += 1
            try:
                obj = json.loads(line)
            except Exception:
                continue

            # Count by event type
            t = obj.get("type", "unknown")
            summary["by_type"][t] = summary["by_type"].get(t, 0) + 1

            # Count by issue category and severity (from issue_report payloads)
            payload = obj.get("payload") or {}
            cat = payload.get("category")
            sev = payload.get("severity")

            if cat:
                summary["by_category"][cat] = summary["by_category"].get(cat, 0) + 1
            if sev:
                summary["by_severity"][sev] = summary["by_severity"].get(sev, 0) + 1

    return jsonify(summary)


@app.route("/feedback/download", methods=["GET"])
def feedback_download():
    """
    Download endpoint – serves the full JSONL evidence log as a file attachment.
    If the file does not exist yet, an empty file is created first.
    Used by the frontend Export Evidence button when the backend is running.
    """
    if not os.path.exists(FEEDBACK_PATH):
        # Create empty file so the endpoint does not error
        open(FEEDBACK_PATH, "a", encoding="utf-8").close()

    return send_file(
        FEEDBACK_PATH,
        as_attachment=True,
        download_name=os.path.basename(FEEDBACK_PATH)
    )


# ───────────────────────────────────────────
# ENTRY POINT
# Run with: python app.py
# Then open index.html in Chrome or Edge.
# ───────────────────────────────────────────

if __name__ == "__main__":
    print("\n✅ ENABLE AccessiBot backend running at http://127.0.0.1:5000")
    print("Open index.html in your browser to use the testing tool.\n")
    app.run(debug=True, port=5000)