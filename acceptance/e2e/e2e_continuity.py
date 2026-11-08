"""Service-level proof of the two continuity seams.

A controllable local OpenAI-compatible stub stands in for the model so both
scenarios are deterministic:

  A) save a skill -> next turn's planning input actually contains it, plus the
     previous turn's correction/answer read from the timeline.
  B) transient failure while planning -> the turn is NOT declared dead; it is
     paused with a resume-offer card, and "接着做" continues it to completion.

No external network, no real key. Link structure only, not generation quality.
"""
import http.server, json, os, shutil, socketserver, subprocess, sys, threading, time
import urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-continuity-e2e")
REPORT = os.path.join(SCRATCH, "continuity_e2e_report.txt")
ROOT = "http://127.0.0.1:3212"
STUB_PORT = 3213

shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)

lock = threading.Lock()
seen = []
fail_mode = [False]
checks = []


def check(name, cond, extra=""):
    checks.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + str(extra)) if extra else ""))


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        with lock:
            seen.append(body)
            n = len(seen)
            failing = fail_mode[0]
        if failing:
            payload = json.dumps({"error": {"message": "fetch failed: upstream unreachable"}}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        actions = [{"kind": "reply", "text": f"办好了（第 {n} 次规划）"}]
        if n == 2:
            # A turn with a real (non-reply) step, so the followup/skill card
            # is actually offered and we can save the skill through the UI path.
            actions.insert(0, {"kind": "browse", "query": "任意", "summary": "检索一下"})
        content = json.dumps({"actions": actions}, ensure_ascii=False)
        payload = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ThreadedStub(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


stub = ThreadedStub(("127.0.0.1", STUB_PORT), Stub)
threading.Thread(target=stub.serve_forever, daemon=True).start()

env = dict(os.environ,
           PORT="3212", HOST="127.0.0.1", DATA_DIR=DATA,
           DEEPSEEK_API_KEY="E2E_LOCAL_ONLY_NOT_A_SECRET",
           DEEPSEEK_BASE_URL=f"http://127.0.0.1:{STUB_PORT}/v1",
           DEEPSEEK_MODEL="e2e-stub", OBSERVER_MODE="off")
env.pop("EXECUTOR_PROVIDER", None)
proc = subprocess.Popen(
    ["node", "src/server.mjs"], cwd=WORKSPACE, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    encoding="utf-8", errors="replace",
)


def call(method, path, body=None, timeout=15):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(ROOT + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def transcript(bot_id):
    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")
    return tr.get("items", []) if isinstance(tr, dict) else []


server_log = ""
try:
    health = None
    for _ in range(80):
        try:
            st, health = call("GET", "/api/health", timeout=5)
            if st == 200:
                break
        except Exception:
            time.sleep(0.25)
    check("service started", health and health.get("ok") is True)

    st, bot = call("POST", "/api/bots", {"name": "它"})
    bot_id = bot.get("id", "")

    # --- A: teach once, reuse on the next turn -----------------------------
    # A correction on the timeline BEFORE any task, so it is a real journal
    # entry that the next planning call must read back.
    st, _ = call("POST", f"/api/bots/{bot_id}/messages",
                 {"text": "别只说做完了，把内容给我", "clientNonce": "cont-a0"})
    time.sleep(0.6)
    st, r1 = call("POST", f"/api/bots/{bot_id}/messages",
                  {"text": "整理一下发布清单", "clientNonce": "cont-a1"})
    turn1 = r1.get("turnId", "")
    for _ in range(40):
        st, t = call("GET", f"/api/turns/{turn1}")
        if isinstance(t, dict) and t.get("status") in ("completed", "failed", "interrupted"):
            break
        time.sleep(0.2)
    check("first turn completed", isinstance(t, dict) and t.get("status") == "completed", t.get("status"))

    items = transcript(bot_id)
    card = next((e for e in items if e.get("kind") == "card" and e.get("cardType") == "followup-offer"), None)
    check("followup card offered", card is not None)
    if card:
        st, acted = call("POST", f"/api/cards/{card['cardId']}/act", {"action": "save-skill"})
        check("save-skill action accepted", st == 200 and acted.get("status") == "saved")
    st, skills = call("GET", "/api/skills")
    check("one skill saved", isinstance(skills, dict) and len(skills.get("items", [])) == 1,
          skills.get("items") if isinstance(skills, dict) else skills)

    st, r2 = call("POST", f"/api/bots/{bot_id}/messages",
                  {"text": "照上次那样", "clientNonce": "cont-a2"})
    turn2 = r2.get("turnId", "")
    for _ in range(40):
        st, t2 = call("GET", f"/api/turns/{turn2}")
        if isinstance(t2, dict) and t2.get("status") in ("completed", "failed", "interrupted"):
            break
        time.sleep(0.2)
    check("second turn completed", isinstance(t2, dict) and t2.get("status") == "completed", t2.get("status"))

    with lock:
        last_user = json.loads(seen[-1]["messages"][1]["content"]) if seen else {}
    check("saved skill is visible in next planning input",
          any(s.get("name") for s in last_user.get("skills", [])), last_user.get("skills"))
    check("previous correction is read back from the timeline",
          any("别只说做完了" in str(m.get("text", "")) for m in last_user.get("memory", [])),
          [m.get("kind") for m in last_user.get("memory", [])])
    check("previous answer is read back from the timeline",
          any(m.get("kind") == "assistant" for m in last_user.get("memory", [])))

    # --- B: transient failure pauses, does not kill ------------------------
    with lock:
        before = len(seen)
        fail_mode[0] = True
    st, r3 = call("POST", f"/api/bots/{bot_id}/messages",
                  {"text": "再整理一次", "clientNonce": "cont-b1"})
    turn3 = r3.get("turnId", "")
    st3 = "unknown"
    for _ in range(60):
        st, t3 = call("GET", f"/api/turns/{turn3}")
        st3 = t3.get("status") if isinstance(t3, dict) else "unknown"
        if st3 in ("completed", "failed", "interrupted"):
            break
        time.sleep(0.2)
    check("transient failure pauses instead of killing the turn", st3 == "interrupted", st3)

    items_b = transcript(bot_id)
    err = next((e for e in items_b if e.get("kind") == "error"), None)
    check("timeline says it could not reach the model (not an internal code dump)",
          err is not None and "没连上模型" in str(err.get("title", "")),
          err.get("title") if err else None)
    resume_card = next((e for e in items_b if e.get("kind") == "card" and e.get("cardType") == "resume-offer"), None)
    check("resume-offer card is presented", resume_card is not None)
    if resume_card:
        check("card names the step it stopped at",
              "还没来得及规划" in str(resume_card.get("summary", "")) or "停在第" in str(resume_card.get("summary", "")),
              resume_card.get("summary"))

    with lock:
        failed_attempts = len(seen) - before
        fail_mode[0] = False
    check("planning retried with a bounded cap", 1 < failed_attempts <= 3, failed_attempts)

    if resume_card:
        st, acted2 = call("POST", f"/api/cards/{resume_card['cardId']}/act", {"action": "resume"})
        check("接着做 accepted", st == 200 and acted2.get("status") == "saved")
        for _ in range(60):
            st, t4 = call("GET", f"/api/turns/{turn3}")
            if isinstance(t4, dict) and t4.get("status") in ("completed", "failed", "interrupted"):
                break
            time.sleep(0.2)
        check("turn continues to completion after resume",
              isinstance(t4, dict) and t4.get("status") == "completed", t4.get("status") if isinstance(t4, dict) else None)
        final_items = transcript(bot_id)
        check("timeline records the resume", any(e.get("kind") == "resume" for e in final_items))
        closes = [e for e in final_items if e.get("kind") == "task/done" and e.get("turnId") == turn3]
        check("resumed turn closes strictly per phase (interrupted + completed)",
              len(closes) == 2 and closes[-1].get("status") == "completed",
              [c.get("status") for c in closes])

finally:
    proc.terminate()
    try:
        server_log = proc.communicate(timeout=8)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        server_log = proc.communicate()[0]
    print("\n--- server log ---")
    print((server_log or "").strip()[:600])

failed = [n for n, ok in checks if not ok]
with open(REPORT, "w", encoding="utf-8") as f:
    f.write("连续性端到端实测（可控桩，服务级）\n")
    f.write("=" * 92 + "\n")
    for n, ok in checks:
        f.write(f"{'PASS' if ok else 'FAIL'}  {n}\n")
    f.write("-" * 92 + "\n")
    f.write((server_log or "").strip()[:600] + "\n")

print(f"\nreport -> {REPORT}")
print(f"SUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
