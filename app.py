"""
ENABLE AccessiBot – Evidence-led Testing Assistant (Groq-Powered)
Uses Groq's free API with Llama 3 — no local downloads, no payment needed.
"""

import os
import json
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
from dotenv import load_dotenv
from groq import Groq
from flask import render_template

load_dotenv()

# ── Single Flask app instance ──────────────
app = Flask(__name__)
CORS(app)

FEEDBACK_PATH = os.getenv("FEEDBACK_PATH", "feedback.jsonl")
GROQ_API_KEY  = os.getenv("GROQ_API_KEY", "")

try:
    client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
except Exception:
    client = None

# ─────────────────────────────────────────────
# ENABLE System Prompt
# ─────────────────────────────────────────────

ENABLE_SYSTEM_PROMPT = """You are ENABLE AccessiBot, an AI accessibility testing assistant for the ENABLE project at the University of Bradford (UoB).

ENABLE stands for: Empowering Neurodiverse and Accessible Breakthroughs in Learning Environments.

Your purpose is to guide testers (students, teaching staff, IT staff) through structured accessibility and neurodiversity testing of UoB systems — primarily the UoB Intranet and EPMS (Engineering, Physical and Mathematical Sciences) systems. Evidence collected feeds into proposals delivered to the AIRE (AI Research) group.

The four ENABLE project objectives are:
1. Empowering all software actors through student inner understanding, creative skills, abilities and communication of challenges.
2. Diversity & inclusion: being first-hand users and co-creators while sharing challenges, expectations and skills.
3. Innovation: all team members enjoy the roles of creators and leaders of their own challenges.
4. Co-creation: editing solutions for improving existing HE IT systems, refining approaches to EDI challenges.

Testing scenarios you support:
- S1: Find EPMS course/module information — test at 200% zoom, keyboard-only navigation, menu/text clarity
- S2: Use intranet search to find a staff/contact page — test high contrast mode, focus indicators
- S3: Download a document (PDF) — check link text clarity, alternative formats, vision barriers
- S4: Complete a simple intranet navigation task — check for neuro-overload, unclear labels, misleading navigation

Accessibility dimensions you help test:
- Vision: zoom (200%), high contrast, colour blindness, screen reader compatibility
- Hearing: captions, transcripts, audio alternatives
- Motor: keyboard-only navigation, target sizes, focus indicators
- Neurodiversity: cognitive load, clarity of language, layout overload, predictability, ADHD/dyslexia/autism considerations

Always be warm, supportive, and encouraging. Use plain, clear language. Keep responses concise — testers are working in parallel tabs.
When asked for scenario steps, give clearly numbered, actionable steps.
"""

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

# ─────────────────────────────────────────────
# Utilities
# ─────────────────────────────────────────────

def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()

def safe_load_json(request_obj):
    try:
        return request_obj.get_json(force=True) or {}
    except Exception:
        return {}

def append_jsonl(path, record):
    record.setdefault("ts", utc_now_iso())
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

def offline_reply(message, session=None):
    low = (message or "").lower()
    scenario = (session or {}).get("scenario", "S1")
    if scenario in SCENARIOS and any(k in low for k in ["start", "steps", "guide", "how", "what do i"]):
        sc = SCENARIOS[scenario]
        lines = [f"Scenario {scenario}: {sc['title']}", "", "Quick steps:"]
        for i, step in enumerate(sc["steps"], start=1):
            lines.append(f"{i}) {step}")
        lines.append("\nWhen you find a barrier, click 'Report issue' and describe what happened.")
        return "\n".join(lines)
    role = (session or {}).get("role", "tester")
    return (
        f"Hi {role}! I'm running in offline mode (no API key found in .env).\n"
        "Tell me:\n"
        "- What page/task are you doing right now?\n"
        "- Which accessibility check are you using?\n"
        "- What felt restrictive or confusing?"
    )

def build_user_message(message, session):
    scenario_id    = session.get("scenario", "S1")
    scenario_title = SCENARIOS.get(scenario_id, {}).get("title", scenario_id)
    return (
        f"[Tester context]\n"
        f"Role: {session.get('role', 'Unknown')}\n"
        f"System under test: {session.get('system', 'UoB Intranet')}\n"
        f"Scenario: {scenario_id} – {scenario_title}\n\n"
        f"[Tester message]\n{message}"
    )

def build_messages(history, message, session):
    """Build the full message list for Groq."""
    msgs = [{"role": "system", "content": ENABLE_SYSTEM_PROMPT}]
    for turn in history[-10:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            msgs.append({"role": turn["role"], "content": turn["content"]})
    msgs.append({"role": "user", "content": build_user_message(message, session)})
    return msgs

# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────

@app.route("/")
def home():
    return "✅ ENABLE AccessiBot server is running. Open index.html to use the chatbot."


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "mode": "ai" if client else "offline",
        "model": "llama3-8b-8192 (Groq)" if client else "none",
        "feedback_path": FEEDBACK_PATH
    })


@app.route("/chat", methods=["POST"])
def chat():
    data    = safe_load_json(request)
    message = (data.get("message") or "").strip()
    session = data.get("session") or {}
    history = data.get("history") or []

    if not message:
        return jsonify({"reply": "I didn't catch that — can you type it again?"})

    if client:
        try:
            response = client.chat.completions.create(
                model="llama3-8b-8192",
                max_tokens=600,
                messages=build_messages(history, message, session),
            )
            reply = response.choices[0].message.content.strip()
        except Exception as e:
            reply = offline_reply(message, session=session)
            reply += f"\n\n(AI temporarily unavailable: {str(e)[:80]})"
    else:
        reply = offline_reply(message, session=session)

    try:
        append_jsonl(FEEDBACK_PATH, {
            "type": "chat_message",
            "session": session,
            "message": message,
            "reply": reply,
        })
    except Exception:
        pass

    return jsonify({"reply": reply})


@app.route("/chat/stream", methods=["POST"])
def chat_stream():
    data    = safe_load_json(request)
    message = (data.get("message") or "").strip()
    session = data.get("session") or {}
    history = data.get("history") or []

    if not message:
        def err():
            yield "data: " + json.dumps({"token": "I didn't catch that."}) + "\n\n"
            yield "data: " + json.dumps({"done": True}) + "\n\n"
        return Response(stream_with_context(err()), content_type="text/event-stream")

    msgs = build_messages(history, message, session)

    def generate():
        full_reply = ""

        if client:
            try:
                stream = client.chat.completions.create(
                    model="llama3-8b-8192",
                    max_tokens=600,
                    messages=msgs,
                    stream=True,
                )
                for chunk in stream:
                    token = chunk.choices[0].delta.content or ""
                    if token:
                        full_reply_local = token  # noqa — just for reference
                        full_reply += token
                        yield "data: " + json.dumps({"token": token}) + "\n\n"
            except Exception as e:
                fallback = offline_reply(message, session=session)
                full_reply = fallback
                yield "data: " + json.dumps({"token": fallback}) + "\n\n"
        else:
            fallback = offline_reply(message, session=session)
            full_reply = fallback
            yield "data: " + json.dumps({"token": fallback}) + "\n\n"

        # Signal stream end
        yield "data: " + json.dumps({"done": True}) + "\n\n"

        # Log evidence
        try:
            append_jsonl(FEEDBACK_PATH, {
                "type": "chat_message",
                "session": session,
                "message": message,
                "reply": full_reply,
            })
        except Exception:
            pass

    return Response(stream_with_context(generate()), content_type="text/event-stream")


@app.route("/feedback", methods=["POST"])
def feedback():
    data = safe_load_json(request)
    record = {
        "type": (data.get("type") or "feedback").strip(),
        "session": data.get("session") or {},
        "payload": data.get("payload") or {},
        "ts": utc_now_iso(),
    }
    append_jsonl(FEEDBACK_PATH, record)
    return jsonify({"ok": True})


@app.route("/feedback/summary", methods=["GET"])
def feedback_summary():
    summary = {"total": 0, "by_type": {}, "by_category": {}, "by_severity": {}}
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
    if not os.path.exists(FEEDBACK_PATH):
        open(FEEDBACK_PATH, "a", encoding="utf-8").close()
    return send_file(FEEDBACK_PATH, as_attachment=True, download_name=os.path.basename(FEEDBACK_PATH))


if __name__ == "__main__":
    mode = "AI — llama3-8b-8192 via Groq ✦" if client else "OFFLINE (add GROQ_API_KEY to .env)"
    port = int(os.environ.get("PORT", 10000))

    print(f"\n✅ ENABLE AccessiBot running on port {port}")
    print(f"   Mode: {mode}\n")

    app.run(host="0.0.0.0", port=port)
