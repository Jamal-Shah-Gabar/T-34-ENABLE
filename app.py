"""
ENABLE AccessiBot – Evidence-led Testing Assistant (Offline)

Purpose:
- Guide human testers (students, teaching staff, IT staff) through accessibility + neurodiversity checks
  on UoB systems (starting with UoB Intranet / EPMS context).
- Collect structured + unstructured evidence (issues, feedback, task start/finish, scenario changes).
- NO paid AI required. Works fully offline.

How it fits P7 ENABLE:
- Empower actors: roles + co-creation suggestions captured as evidence
- Diversity & inclusion: first-hand testing + multiple needs (vision, hearing, motor, neurodiversity)
- Innovation: testers lead their own challenges and report
- Co-creation: evidence supports redesign proposals for existing HE systems
"""

import os
import json
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

FEEDBACK_PATH = os.getenv("FEEDBACK_PATH", "feedback.jsonl")


# ─────────────────────────────────────────────
# Utilities
# ─────────────────────────────────────────────

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def safe_load_json(request_obj):
    try:
        return request_obj.get_json(force=True) or {}
    except Exception:
        return {}

def append_jsonl(path: str, record: dict) -> None:
    # Make sure we always log with timestamp
    record.setdefault("ts", utc_now_iso())
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# ─────────────────────────────────────────────
# Offline “Guidance” replies (simple, human)
# ─────────────────────────────────────────────

SCENARIOS = {
    "S1": {
        "title": "Find EPMS course/module information",
        "steps": [
            "Open the UoB intranet in another tab.",
            "Try to find a course/module page (EPMS).",
            "Test at 200% zoom. Check if menus and text still work.",
            "Try keyboard-only (Tab/Enter). Can you reach everything?",
            "If anything blocks you, click “Report issue” and log it."
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
            "If there’s no alternative format, log it as a barrier."
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

RULE_REPLIES = [
    (["hello", "hi", "hey"], "Hi 👋 Tell me what you’re testing today (role + scenario), and I’ll guide you."),
    (["bye", "goodbye"], "No problem — thanks for testing. If you spot more barriers, log them and we’ll build a clear evidence list."),
    (["what is enable", "enable project"], "ENABLE is about collecting evidence and co-creating more accessible, relaxed learning software — starting with UoB systems like the intranet."),
    (["vision", "zoom", "contrast", "colour"], "For vision testing: try 200% zoom, high contrast, and check if layout breaks or text becomes hard to follow."),
    (["hearing", "captions"], "For hearing needs: check if videos/audio have captions or transcripts. If not, log it as a barrier."),
    (["neuro", "adhd", "autism", "dyslexia", "overwhelm"], "For neurodiversity: watch for overload (too much text, unclear labels, confusing navigation). Log what caused it and what would help."),
]

def offline_reply(message: str, session: dict | None = None) -> str:
    msg = (message or "").strip()
    low = msg.lower()

    # scenario hint if present
    scenario = (session or {}).get("scenario")
    if scenario and scenario in SCENARIOS and ("start" in low or "scenario" in low or "steps" in low):
        sc = SCENARIOS[scenario]
        lines = [f"Scenario {scenario}: {sc['title']}", "", "Quick steps:"]
        for i, step in enumerate(sc["steps"], start=1):
            lines.append(f"{i}) {step}")
        lines.append("")
        lines.append("When you find a barrier, click “Report issue” and describe what happened + what you expected.")
        return "\n".join(lines)

    # rule replies
    for keys, reply in RULE_REPLIES:
        if any(k in low for k in keys):
            return reply

    # default guidance
    role = (session or {}).get("role", "tester")
    system = (session or {}).get("system", "UoB system")
    scenario_text = (scenario + " – " + SCENARIOS[scenario]["title"]) if scenario in SCENARIOS else "a scenario"
    return (
        f"Okay — you’re acting as: {role}.\n"
        f"System under test: {system}.\n"
        f"Scenario: {scenario_text}.\n\n"
        "Tell me:\n"
        "- What page/task are you doing right now?\n"
        "- Are you testing zoom, contrast, keyboard-only, captions, or focus mode?\n"
        "- What felt restrictive or confusing?"
    )


# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "mode": "offline", "feedback_path": FEEDBACK_PATH})

@app.route("/chat", methods=["POST"])
def chat():
    data = safe_load_json(request)
    message = (data.get("message") or "").strip()
    session = data.get("session") or {}

    if not message:
        return jsonify({"reply": "I didn’t catch that — can you type it again?"})

    # Fully offline reply
    reply = offline_reply(message, session=session)

    # Optional: log chat as evidence (lightweight)
    try:
        append_jsonl(FEEDBACK_PATH, {
            "type": "chat_message",
            "session": session,
            "message": message,
            "reply": reply,
        })
    except Exception:
        # If logging fails, still respond.
        pass

    return jsonify({"reply": reply})

@app.route("/feedback", methods=["POST"])
def feedback():
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

            t = obj.get("type", "unknown")
            summary["by_type"][t] = summary["by_type"].get(t, 0) + 1

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
    # Simple download for reporting (optional feature)
    if not os.path.exists(FEEDBACK_PATH):
        # Create empty file so the endpoint doesn't error
        open(FEEDBACK_PATH, "a", encoding="utf-8").close()
    return send_file(FEEDBACK_PATH, as_attachment=True, download_name=os.path.basename(FEEDBACK_PATH))

if __name__ == "__main__":
    print("\n✅ ENABLE AccessiBot backend running at http://127.0.0.1:5000")
    print("Open index.html in your browser to use the testing tool.\n")
    app.run(debug=True, port=5000)