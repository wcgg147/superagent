"""HTTP-level proof of long-task visibility / interrupt / resume / watchdog.

A local slow OpenAI-compatible stub keeps a turn genuinely in flight while the
process is hard-killed, so the restart path (recover -> resume-offer card) is
exercised for real. No external network, no real API key.
"""
import http.server, json, os, shutil, socketserver, subprocess, sys, threading, time
import urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-watch-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3109"
STUB_PORT = 3110

lock = threading.Lock()
probe = {"calls": 0}
ACTIONS = [
    {"kind": "activity", "summary": "理解中"},
    {"kind": "browse", "query": "q", "summary": "检索"},
    {"kind": "write_artifact", "filename": "r.md", "content": "done", "summary": "起草"},
    {"kind": "reply", "text": "办好了"},
]


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with lock:
            probe["calls"] += 1
            n = probe["calls"]
        time.sleep(1.4 if n == 1 else 0.15)  # first turn is slow enough to be killed mid-plan
        content = json.dumps({"actions": ACTIONS}, ensure_ascii=False)
        payload = json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # the client was hard-killed on purpose

    def log_message(self, *args):
        pass


class ThreadedStub(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


stub = ThreadedStub(("127.0.0.1", STUB_PORT), Stub)
threading.Thread(target=stub.serve_forever, daemon=True).start()

env = dict(os.environ, PORT="3109", HOST="127.0.0.1", DATA_DIR=DATA,
           MAX_CONCURRENT_TURNS="2",
           WATCHDOG_INTERVAL_MS="2000", WATCHDOG_HEARTBEAT_MS="1000", WATCHDOG_STALL_MS="2000",
           DEEPSEEK_API_KEY="E2E_LOCAL_ONLY_NOT_A_SECRET",
           DEEPSEEK_BASE_URL=f"http://127.0.0.1:{STUB_PORT}/v1",
           DEEPSEEK_MODEL="e2e-mock", DEEPSEEK_REASONING_EFFORT="low")
for var in ("EXECUTOR_PROVIDER", "OBSERVER_MODE"):
    env.pop(var, None)

checks = []


def check(name, cond, extra=""):
    checks.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + str(extra)) if extra else ""))


def call(method, path, body=None):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(ROOT + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode("utf-8", "replace")
            try: return r.status, json.loads(raw)
            except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw


def start_server():
    p = subprocess.Popen(["node", "src/server.mjs"], cwd=WORKSPACE, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace")
    for _ in range(60):
        try:
            st, h = call("GET", "/api/health")
            if st == 200 and h.get("ok"): return p, h
        except Exception:
            time.sleep(0.25)
    return p, None


def kill(p):
    p.kill()
    try:
        p.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def transcript(bot_id):
    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")
    return tr.get("items", []) if isinstance(tr, dict) else []


def wait_turn(tid, timeout=15):
    deadline = time.time() + timeout
    status = ""
    while time.time() < deadline:
        status = call("GET", f"/api/turns/{tid}")[1].get("status")
        if status in ("completed", "failed", "denied"): return status
        time.sleep(0.1)
    return status


proc = None
try:
    proc, health = start_server()
    check("service started", health and health.get("ok") is True)
    st, bot = call("POST", "/api/bots", {"name": "它"})
    bot_id = bot.get("id", "")

    st, wd = call("GET", "/api/watchdog")
    check("watchdog reports a running resident loop",
          st == 200 and wd.get("running") is True and wd.get("stallMs", 0) > 0, wd)
    st, tick0 = call("POST", "/api/watchdog/tick", {})
    check("manual tick is harmless when nothing is running",
          st == 200 and tick0.get("inspected") == 0 and tick0.get("alerts") == 0
          and tick0.get("totalAlerts") == 0, tick0)

    st, sent = call("POST", f"/api/bots/{bot_id}/messages", {"text": "做一件长一点的事", "clientNonce": "w-1"})
    check("long task accepted with 202", st == 202 and sent.get("turnId"), sent.get("turnId"))
    first_turn = sent.get("turnId", "")
    time.sleep(0.35)
    st, live = call("GET", f"/api/turns/{first_turn}")
    check("turn is genuinely in flight before the kill", st == 200 and live.get("status") == "running",
          live.get("status"))

    # Hard-kill: no graceful interrupt, so the persisted turn stays non-terminal.
    kill(proc)
    proc, health2 = start_server()
    check("service restarted on the same data dir", health2 and health2.get("ok") is True)

    st, recovered_turn = call("GET", f"/api/turns/{first_turn}")
    check("restart marks the unfinished turn interrupted (never pretends success)",
          st == 200 and recovered_turn.get("status") == "interrupted", recovered_turn.get("status"))

    items = transcript(bot_id)
    check("recovery notice appears on the timeline", any(e.get("recovered") for e in items))
    closed = [e for e in items if e.get("kind") == "task/done" and e.get("turnId") == first_turn]
    check("hard-killed task row is closed on the timeline",
          len(closed) == 1 and closed[0].get("status") == "interrupted" and closed[0].get("recovered") is True,
          closed)
    check("task/task-done stay paired after a hard kill",
          len([e for e in items if e.get("kind") == "task"]) == len([e for e in items if e.get("kind") == "task/done"]))

    offer = next((e for e in items if e.get("kind") == "card" and e.get("cardType") == "resume-offer"), None)
    check("restart offers a resume card instead of auto-resuming", offer is not None)
    check("resume card offers resume / dismiss", offer and
          [a.get("id") for a in offer.get("actions", [])] == ["resume", "dismiss"])

    st, acted = call("POST", f"/api/cards/{offer['cardId']}/act", {"action": "resume"})
    check("clicking resume starts continuation, not a fresh message",
          st == 200 and acted.get("status") == "saved" and acted.get("resultKind") == "resume"
          and acted.get("result", {}).get("turnId") == first_turn, acted.get("resultKind"))
    check("continuation completes", wait_turn(first_turn) == "completed")

    items = transcript(bot_id)
    check("resume is a visible timeline event",
          any(e.get("kind") == "resume" and e.get("turnId") == first_turn for e in items))
    progress = [e for e in items if e.get("kind") == "progress" and e.get("turnId") == first_turn]
    check("every step emits a progress event",
          [e.get("step") for e in progress] == [1, 2, 3, 4], [e.get("step") for e in progress])
    check("progress carries total / summary / elapsed and the turnId",
          all(e.get("total") == 4 and e.get("summary") and isinstance(e.get("elapsedMs"), int)
              and e.get("turnId") == first_turn for e in progress))
    check("task rows remain paired after resume",
          len([e for e in items if e.get("kind") == "task"]) == 2
          and len([e for e in items if e.get("kind") == "task/done"]) == 2)

    st, tick1 = call("POST", "/api/watchdog/tick", {})
    check("watchdog does not inspect completed turns",
          st == 200 and tick1.get("inspected") == 0 and tick1.get("alerts") == 0, tick1)

    # Precise interrupt: stop one of two parallel turns, the other must finish.
    st, a = call("POST", f"/api/bots/{bot_id}/messages", {"text": "并行甲", "clientNonce": "w-2"})
    st, b = call("POST", f"/api/bots/{bot_id}/messages", {"text": "并行乙", "clientNonce": "w-3"})
    time.sleep(0.05)
    st, stopped = call("POST", f"/api/turns/{a['turnId']}/interrupt", {})
    check("one turn can be stopped without touching the other",
          st == 200 and stopped.get("status") == "interrupted")
    check("the sibling turn still completes", wait_turn(b["turnId"]) == "completed")
    time.sleep(0.3)
    check("stopped turn stays interrupted", call("GET", f"/api/turns/{a['turnId']}")[1].get("status") == "interrupted")

    st, resumed = call("POST", f"/api/turns/{a['turnId']}/resume", {})
    check("direct resume endpoint accepts the stopped turn",
          st == 202 and resumed.get("turnId") == a["turnId"] and "fromStep" in resumed, resumed)
    check("resumed turn completes", wait_turn(a["turnId"]) == "completed")
    st, bad = call("POST", f"/api/turns/{b['turnId']}/resume", {})
    check("resuming a completed turn is rejected", st == 400)

    items = transcript(bot_id)
    progress_turns = {e.get("turnId") for e in items if e.get("kind") == "progress"}
    check("parallel progress stays attributed to its own turn",
          a["turnId"] in progress_turns and b["turnId"] in progress_turns and first_turn in progress_turns)
    st, wd2 = call("GET", "/api/watchdog")
    check("watchdog loop is still alive at the end", st == 200 and wd2.get("running") is True)

finally:
    if proc and proc.poll() is None:
        kill(proc)
    stub.shutdown()
    stub.server_close()

failed = [n for n, ok in checks if not ok]
print(f"\nSUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
