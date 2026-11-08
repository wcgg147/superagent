"""HTTP-level proof of bounded parallelism.

A local, deliberately slow OpenAI-compatible stub stands in for the model so
`plan()` is genuinely async: two turns really overlap, the rest really queue.
No external network and no real API key are involved.
"""
import http.server, json, os, shutil, socketserver, subprocess, sys, threading, time
import urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-conc-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3106"
STUB_PORT = 3108

lock = threading.Lock()
probe = {"inflight": 0, "peak": 0, "calls": 0, "efforts": []}


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try: body = json.loads(raw)
        except Exception: body = {}
        with lock:
            probe["calls"] += 1
            probe["inflight"] += 1
            probe["peak"] = max(probe["peak"], probe["inflight"])
            probe["efforts"].append(body.get("reasoning_effort"))
        time.sleep(0.6)  # the whole point: keep two slots occupied at once
        content = json.dumps({"actions": [{"kind": "reply", "text": "这件事我办好了"}]}, ensure_ascii=False)
        payload = json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")
        with lock:
            probe["inflight"] -= 1
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

env = dict(os.environ, PORT="3106", HOST="127.0.0.1", DATA_DIR=DATA,
           MAX_CONCURRENT_TURNS="2",
           DEEPSEEK_API_KEY="E2E_LOCAL_ONLY_NOT_A_SECRET",
           DEEPSEEK_BASE_URL=f"http://127.0.0.1:{STUB_PORT}/v1",
           DEEPSEEK_MODEL="e2e-mock", DEEPSEEK_REASONING_EFFORT="low")
for var in ("EXECUTOR_PROVIDER", "OBSERVER_MODE"):
    env.pop(var, None)
proc = subprocess.Popen(
    ["node", "src/server.mjs"], cwd=WORKSPACE, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
)
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


def transcript(bot_id):
    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")
    return tr.get("items", []) if isinstance(tr, dict) else []


try:
    health = None
    for _ in range(60):
        try:
            st, health = call("GET", "/api/health")
            if st == 200: break
        except Exception:
            time.sleep(0.25)
    check("service started", health and health.get("ok") is True)

    conc = (health or {}).get("concurrency", {})
    check("MAX_CONCURRENT_TURNS=2 is honoured", conc.get("maxConcurrent") == 2, conc)
    check("health reports live active/queued", conc.get("active") == 0 and conc.get("queued") == 0, conc)
    st, caps = call("GET", "/api/capabilities")
    check("capabilities exposes the same concurrency view", st == 200
          and caps.get("concurrency", {}).get("maxConcurrent") == 2)
    check("model adapter is pointed at the local stub", (health or {}).get("model") == "deepseek")

    st, bot = call("POST", "/api/bots", {"name": "它", "job": "同时推进几件事"})
    bot_id = bot.get("id", "")
    check("bot created", st == 201 and bot_id.startswith("bot_"), bot_id)

    # sendMessage returns before plan() finishes, so the last two must queue
    sends = []
    for i in range(4):
        st, r = call("POST", f"/api/bots/{bot_id}/messages",
                     {"text": f"帮我写第 {i + 1} 份报告", "clientNonce": f"conc-{i}"})
        sends.append((st, r))
    check("four sends accepted with 202", all(st == 202 and r.get("accepted") for st, r in sends))
    check("each send carries taskLabel / queued / position",
          all(r.get("taskLabel") and "queued" in r and "position" in r for _, r in sends))
    check("first two turns start immediately",
          sends[0][1].get("queued") is False and sends[1][1].get("queued") is False)
    check("overflow turns report queue positions 1 and 2",
          sends[2][1].get("queued") is True and sends[2][1].get("position") == 1
          and sends[3][1].get("queued") is True and sends[3][1].get("position") == 2,
          [(r.get("queued"), r.get("position")) for _, r in sends])
    turn_ids = [r["turnId"] for _, r in sends]
    check("four distinct turnIds", len(set(turn_ids)) == 4, turn_ids)

    st, during = call("GET", "/api/capabilities")
    dc = during.get("concurrency", {})
    check("two active + two queued while work is in flight",
          dc.get("active") == 2 and dc.get("queued") == 2, dc)

    deadline = time.time() + 20
    statuses = {}
    while time.time() < deadline:
        statuses = {tid: call("GET", f"/api/turns/{tid}")[1].get("status") for tid in turn_ids}
        if all(v == "completed" for v in statuses.values()): break
        time.sleep(0.1)
    check("all turns completed", all(v == "completed" for v in statuses.values()), statuses)

    with lock:
        peak_calls, total_calls, efforts = probe["peak"], probe["calls"], list(probe["efforts"])
    check("two model calls really overlapped", peak_calls == 2, peak_calls)
    check("every turn made exactly one model call", total_calls == 4, total_calls)
    check("reasoning_effort stayed a top-level sidecar", efforts and all(e == "low" for e in efforts), efforts)

    items = transcript(bot_id)
    starts = [e for e in items if e.get("kind") == "task"]
    dones = [e for e in items if e.get("kind") == "task/done"]
    check("four task starts on the timeline", len(starts) == 4)
    check("four task/done entries", len(dones) == 4)
    check("every start is paired exactly once by turnId",
          len({e.get("turnId") for e in dones}) == 4
          and all(any(d.get("turnId") == s.get("turnId") for d in dones) for s in starts))
    check("task rows carry a label and parallel count",
          all(e.get("taskLabel") and "parallel" in e for e in starts))

    all_replies = [e for e in items if e.get("kind") == "assistant/message"]
    # Interjection acknowledgements are outbound messages too, but they are
    # notices rather than a turn's answer: keep the per-turn invariant on the
    # answers, and assert the acknowledgements separately.
    replies = [e for e in all_replies if not e.get("interjection")]
    acks = [e for e in all_replies if e.get("interjection")]
    check("one reply per turn", len(replies) == 4, len(replies))
    check("all replies come from the single outbox",
          all(e.get("viaOutbox") is True and e.get("turnId") for e in replies))
    check("parallel replies are labelled with their task",
          all(e.get("taskLabel") for e in replies), [e.get("taskLabel") for e in replies])
    check("interjection acks also come from the single outbox",
          len(acks) >= 1 and all(e.get("viaOutbox") is True for e in acks), len(acks))
    check("seq is one strictly ordered timeline",
          [e.get("seq") for e in items] == list(range(1, len(items) + 1)))

    st, final = call("GET", "/api/capabilities")
    fc = final.get("concurrency", {})
    check("no slot or queue leak after all turns", fc.get("active") == 0 and fc.get("queued") == 0, fc)
    check("coordinator peak is the hard ceiling", fc.get("peak") == 2, fc)
    check("coordinator reports started / enqueued totals",
          fc.get("started") == 4 and fc.get("enqueued") == 2, fc)

    st, dup = call("POST", f"/api/bots/{bot_id}/messages",
                   {"text": "帮我写第 1 份报告", "clientNonce": "conc-0"})
    check("clientNonce dedupe does not open a fifth task",
          st == 202 and dup.get("duplicate") is True and dup.get("turnId") == turn_ids[0])
    time.sleep(0.3)
    check("dedupe left task rows untouched", len([e for e in transcript(bot_id) if e.get("kind") == "task"]) == 4)

    st, stopped = call("POST", f"/api/turns/{turn_ids[0]}/interrupt", {})
    check("interrupt on a finished turn is harmless", st == 200 and stopped.get("status") == "completed")
    check("interrupt did not emit an extra task/done",
          len([e for e in transcript(bot_id) if e.get("kind") == "task/done"]) == 4)

finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
    stub.shutdown()
    stub.server_close()
    print("\n--- server log ---")
    print((out or "").strip()[:600])

failed = [n for n, ok in checks if not ok]
print(f"\nSUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
