"""
ENABLE AccessiBot — Flask Backend
Co-created with Claude (Anthropic, 2025). Available at: https://claude.ai

Reference:
  Anthropic (2025) Claude [Large language model]. Available at:
  https://claude.ai (Accessed: April 2026).

AI model: Groq API — Llama 3.3 70B Versatile (free tier).
Groq (2025) Groq API Documentation. Available at:
  https://console.groq.com/docs (Accessed: April 2026).
"""

import os
import json
from datetime import datetime, timezone
from flask import Flask, request, jsonify, send_file, Response, stream_with_context, render_template
from flask_cors import CORS
from dotenv import load_dotenv
from groq import Groq

load_dotenv()

app = Flask(__name__)
CORS(app)

FEEDBACK_PATH = os.getenv("FEEDBACK_PATH", "feedback.jsonl")
GROQ_API_KEY  = os.getenv("GROQ_API_KEY", "")

try:
    client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
except Exception:
    client = None

# ── System prompt — defines the AI's full ENABLE context ──────────────────

ENABLE_SYSTEM_PROMPT = """You are ENABLE AccessiBot, a warm and knowledgeable AI accessibility testing assistant for the ENABLE project at the University of Bradford (UoB).

ENABLE stands for: Empowering Neurodiverse and Accessible Breakthroughs in Learning Environments.

Your purpose is to guide testers (students, teaching staff, IT staff) through structured accessibility and neurodiversity testing of UoB digital systems — primarily the UoB Intranet and EPMS (Engineering, Physical and Mathematical Sciences) platform. Evidence collected feeds into redesign proposals delivered to the AIRE (AI Research) group.

== PROJECT OBJECTIVES ==
1. Empowering all software actors (students, teaching and IT staff) through creative skills, inner understanding and communication of challenges.
2. Diversity & inclusion: being first-hand users and co-creators while sharing challenges, expectations and skills.
3. Innovation: all team members enjoy the roles of creators and leaders of their own challenges.
4. Co-creation: editing solutions to improve existing HE IT systems, refining approaches to EDI (Equality, Diversity and Inclusion) challenges.

== TESTING SCENARIOS ==
You know the following four scenarios in detail and can guide testers through any of them dynamically:

S1 — Find EPMS course/module information:
Guide the tester to find a course or module page on the UoB intranet. Ask them to test at 200% browser zoom and check if menus, text and layout still work. Ask them to try keyboard-only navigation using Tab and Enter. Help them notice if anything breaks, disappears or becomes hard to reach.

S2 — Use intranet search to find a staff or contact page:
Guide the tester to use the intranet search to find a staff profile or contact info. Ask them to enable high contrast mode in their OS or browser. Help them check the focus indicator — when tabbing through the page, can they clearly see which element is focused? Note any confusing or misleading search results.

S3 — Download a document (PDF) and check clarity:
Guide the tester to find a PDF document link on the intranet. At 200% zoom, is the link text clear and descriptive (e.g. "2024 Module Guide PDF" vs just "click here")? If the PDF is scanned/image-based, it won't work with screen readers — log that. Check if alternative formats (Word, HTML) are offered.

S4 — Complete a simple intranet navigation task:
Guide the tester to navigate to a simple destination (e.g. timetable, student support, forms) using as few steps as possible. Pay attention to: confusing labels, too many options at once, inconsistent navigation, anything that causes mental overload. This scenario focuses on neurodiversity — cognitive load, clarity, predictability.

== ACCESSIBILITY DIMENSIONS ==
Help testers notice and report issues across four areas:
- Vision: zoom behaviour, contrast, colour blindness, screen reader support
- Hearing: missing captions, missing transcripts, no audio alternatives
- Motor: keyboard-only navigation, click target sizes, focus indicators
- Neurodiversity: cognitive overload, unclear language, unpredictable layouts, ADHD/dyslexia/autism considerations

== HOW TO RESPOND ==
- Be warm, encouraging and patient. Testers may themselves have the accessibility needs they are testing for.
- Use plain, clear language. Avoid jargon unless you explain it.
- Keep responses focused and concise — testers are working in a second browser tab simultaneously.
- When a tester asks for steps or guidance for a scenario, give them clear numbered steps tailored to their role and the system they are testing.
- When a tester reports an issue, help them: categorise it (Vision/Hearing/Motor/Neurodiversity), assess its severity (Minor/Major/Blocker), describe what happened vs what was expected, and suggest a concrete improvement.
- If a tester seems confused or overwhelmed, simplify your response.
- Always frame your guidance in the context of the ENABLE project — collecting evidence to drive real change in HE accessibility.
"""


# ── Utility functions ─────────────────────────────────────────────────────

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


def offline_reply(session=None):
    role     = (session or {}).get("role", "tester")
    scenario = (session or {}).get("scenario", "S1")
    return (
        f"Hi {role}! I'm in offline mode right now — no AI connection found.\n\n"
        f"You've selected scenario {scenario}. "
        "To get full AI guidance, please make sure the GROQ_API_KEY environment variable is set on the server.\n\n"
        "You can still log accessibility issues using the 'Report issue' button."
    )


def build_messages(history, message, session):
    """Assemble the full message list with ENABLE context for Groq."""
    scenario_labels = {
        "S1": "S1 – Find EPMS course/module information",
        "S2": "S2 – Use intranet search to find a staff/contact page",
        "S3": "S3 – Download a document (PDF) and check clarity",
        "S4": "S4 – Complete a simple intranet navigation task",
    }
    scenario_id    = session.get("scenario", "S1")
    scenario_label = scenario_labels.get(scenario_id, scenario_id)

    contextualised = (
        f"[Session context]\n"
        f"My role: {session.get('role', 'Student')}\n"
        f"System I am testing: {session.get('system', 'UoB Intranet')}\n"
        f"Current scenario: {scenario_label}\n\n"
        f"[My message]\n{message}"
    )

    msgs = [{"role": "system", "content": ENABLE_SYSTEM_PROMPT}]
    for turn in history[-10:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            msgs.append({"role": turn["role"], "content": turn["content"]})
    msgs.append({"role": "user", "content": contextualised})
    return msgs


# ── Routes ────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "mode": "ai" if client else "offline",
        "model": "llama-3.3-70b-versatile (Groq)" if client else "none",
        "ai_ready": client is not None,
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
                model="llama-3.3-70b-versatile",
                max_tokens=600,
                messages=build_messages(history, message, session),
            )
            reply = response.choices[0].message.content.strip()
            print(f"[AI] ok, {len(reply)} chars", flush=True)
        except Exception as e:
            print(f"[AI ERROR] {e}", flush=True)
            reply = offline_reply(session=session)
            reply += f"\n\n(AI error: {str(e)[:120]})"
    else:
        print("[WARN] GROQ_API_KEY not set", flush=True)
        reply = offline_reply(session=session)

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
                    model="llama-3.3-70b-versatile",
                    max_tokens=600,
                    messages=msgs,
                    stream=True,
                )
                for chunk in stream:
                    token = chunk.choices[0].delta.content or ""
                    if token:
                        full_reply += token
                        yield "data: " + json.dumps({"token": token}) + "\n\n"
            except Exception as e:
                print(f"[STREAM ERROR] {e}", flush=True)
                fallback = offline_reply(session=session)
                full_reply = fallback
                yield "data: " + json.dumps({"token": fallback}) + "\n\n"
        else:
            fallback = offline_reply(session=session)
            full_reply = fallback
            yield "data: " + json.dumps({"token": fallback}) + "\n\n"

        yield "data: " + json.dumps({"done": True}) + "\n\n"

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
    return send_file(FEEDBACK_PATH, as_attachment=True, download_name="enable_evidence.jsonl")


if __name__ == "__main__":
    mode = "AI — llama-3.3-70b-versatile via Groq" if client else "OFFLINE (GROQ_API_KEY not set)"
    port = int(os.environ.get("PORT", 10000))
    print(f"\n✅ ENABLE AccessiBot — port {port}  |  {mode}\n", flush=True)
    app.run(host="0.0.0.0", port=port)
