import json, os, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-real")
RESULT = os.path.join(SCRATCH, "p0a_real_result.json")
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3203"

env = dict(os.environ, PORT="3203", HOST="127.0.0.1", DATA_DIR=DATA)
proc = subprocess.Popen(
    ["node", "src/server.mjs"], cwd=WORKSPACE, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
)

checks = []
report = {}

def check(name, cond, extra=None):
    checks.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name)
    if extra is not None:
        report[name] = extra

def call(method, path, body=None):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(ROOT + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8", "replace")
            try: return r.status, json.loads(raw)
            except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

try:
    health = None
    for _ in range(60):
        try:
            st, health = call("GET", "/api/health")
            if st == 200: break
        except Exception:
            time.sleep(0.25)
    check("service started", health is not None and health.get("ok") is True)
    report["health"] = health
    check("real model selected (not mock)", health and health.get("model") == "deepseek", health and health.get("model"))

    st, bot = call("POST", "/api/bots", {"name": "真实模型Bot", "job": "帮我整理工作周报"})
    bot_id = bot.get("id", "")
    check("bot created", st == 201 and bot_id.startswith("bot_"))

    prompt = "把本周工作周报写成 Markdown 文件交付给我，内容包含本周完成事项和下周计划"
    st, sent = call("POST", f"/api/bots/{bot_id}/messages", {"text": prompt, "clientNonce": "real-1"})
    turn_id = sent.get("turnId", "")
    check("message accepted (202)", st == 202 and sent.get("accepted") is True)

    status = "unknown"
    approved = 0
    for _ in range(150):
        st, turn = call("GET", f"/api/turns/{turn_id}")
        status = turn.get("status", "unknown") if isinstance(turn, dict) else "unknown"
        if status == "waiting_approval":
            st2, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
            for e in tr.get("items", []):
                if e.get("kind") == "card" and e.get("approvalId"):
                    call("POST", f"/api/approvals/{e['approvalId']}", {"approve": True})
                    approved += 1
        if status in ("completed", "failed", "interrupted", "denied"):
            break
        time.sleep(1)
    report["turn_status"] = status
    report["auto_approved_cards"] = approved
    check("turn reached terminal state", status in ("completed", "failed", "interrupted", "denied"), status)
    check("turn completed", status == "completed", status)

    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    items = tr.get("items", []) if isinstance(tr, dict) else []
    report["entry_kinds"] = [e.get("kind") for e in items]
    errors = [e for e in items if e.get("kind") == "error"]
    report["errors"] = [{"code": e.get("code"), "title": e.get("title"), "detail": e.get("detail")} for e in errors]
    check("no model/transport error in transcript", len(errors) == 0, report["errors"])

    replies = [e.get("text", "") for e in items if e.get("kind") == "assistant/message"]
    report["reply_preview"] = replies[-1][:600] if replies else ""
    check("real assistant reply present", any(r.strip() for r in replies))
    mock_phrase = "这件事我接着往下做"
    check("reply is NOT the mock template", not any(mock_phrase in r for r in replies))

    arts = [e for e in items if e.get("kind") == "artifact"]
    check("artifact produced", len(arts) > 0, len(arts))
    if arts:
        st, content = call("GET", arts[-1]["url"])
        report["artifact_filename"] = arts[-1].get("filename")
        report["artifact_chars"] = len(str(content))
        report["artifact_preview"] = str(content)[:400]
        check("artifact downloadable", st == 200 and len(str(content)) > 0)

finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
    report["server_log"] = (out or "").strip()[:600]
    report["checks"] = [{"name": n, "ok": ok} for n, ok in checks]
    with open(RESULT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\n--- server log ---")
    print((out or "").strip()[:600])

failed = [n for n, ok in checks if not ok]
print(f"\nSUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
