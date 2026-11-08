import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-thread-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3107"

env = dict(os.environ, PORT="3107", HOST="127.0.0.1", DATA_DIR=DATA)
for var in ("DEEPSEEK_API_KEY", "EXECUTOR_PROVIDER", "OBSERVER_MODE", "MAX_CONCURRENT_TURNS"):
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


def cards(bot_id, card_type):
    return [e for e in transcript(bot_id) if e.get("kind") == "card" and e.get("cardType") == card_type]


try:
    health = None
    for _ in range(60):
        try:
            st, health = call("GET", "/api/health")
            if st == 200: break
        except Exception:
            time.sleep(0.25)
    check("service started", health and health.get("ok") is True)

    st, initial = call("GET", "/api/threads")
    check("threads endpoint starts empty", st == 200 and initial.get("total") == 0, initial)

    st, bot = call("POST", "/api/bots", {"name": "它"})
    bot_id = bot.get("id", "")

    events = [
        {"botId": bot_id, "source": "github", "entity": "issue/12", "text": "CI 报错了", "kind": "ci"},
        {"botId": bot_id, "source": "github", "entity": "issue/12", "text": "复现步骤已补齐"},
        {"botId": bot_id, "source": "github", "entity": "issue/12", "text": "维护者回复了"},
    ]
    results = [call("POST", "/api/threads/ingest", e) for e in events]
    check("three ingests accepted with 202", all(st == 202 for st, _ in results))
    first, second, third = [r for _, r in results]
    check("first event offers the single card", first.get("offered") is True)
    check("later events coalesce into the same chain",
          second.get("coalesced") is True and third.get("coalesced") is True
          and first.get("threadId") == second.get("threadId") == third.get("threadId"))
    thread_id = first.get("threadId", "")

    st, listed = call("GET", "/api/threads")
    check("one thread with three events and one open card",
          st == 200 and listed.get("total") == 1 and listed.get("events") == 3
          and listed.get("openCards") == 1, {k: listed.get(k) for k in ("total", "events", "openCards")})

    items = transcript(bot_id)
    check("three faint thread rows on the same timeline",
          len([e for e in items if e.get("kind") == "thread/event"]) == 3)
    check("rows keep their chain counters",
          [e.get("count") for e in items if e.get("kind") == "thread/event"] == [1, 2, 3])
    offer = cards(bot_id, "thread-offer")
    check("exactly one thread-offer card", len(offer) == 1)
    check("card offers delegate / dismiss", offer and
          [a.get("id") for a in offer[0].get("actions", [])] == ["delegate", "dismiss"])
    check("ingesting never auto-delegates a turn",
          not any(e.get("kind") == "user/message" for e in items))

    st, thread = call("GET", f"/api/threads/{thread_id}")
    check("thread exposes seq watermarks", st == 200 and thread.get("deliveredSeq") == 0
          and thread.get("throughSeq", 0) > 0, {k: thread.get(k) for k in ("id", "throughSeq", "deliveredSeq")})
    through = thread.get("throughSeq")
    st, recall = call("GET", f"/api/threads/{thread_id}/recall?afterSeq=0")
    check("recall from 0 returns the whole bounded chain",
          st == 200 and recall.get("afterSeq") == 0 and recall.get("throughSeq") == through
          and len(recall.get("items", [])) == 3, recall)

    st, acted = call("POST", f"/api/cards/{offer[0]['cardId']}/act", {"action": "delegate"})
    check("delegate produces one turn carrying the threadId",
          st == 200 and acted.get("status") == "saved" and acted.get("resultKind") == "turn"
          and acted.get("result", {}).get("threadId") == thread_id, acted)
    turn_id = acted.get("result", {}).get("turnId", "")

    deadline = time.time() + 12
    status = ""
    while time.time() < deadline:
        status = call("GET", f"/api/turns/{turn_id}")[1].get("status")
        if status == "completed": break
        time.sleep(0.1)
    check("delegated turn completed", status == "completed", status)

    after = transcript(bot_id)
    check("three events still produced exactly one user message",
          len([e for e in after if e.get("kind") == "user/message"]) == 1)
    check("user message is tagged with the thread",
          all(e.get("threadId") == thread_id for e in after if e.get("kind") == "user/message"))
    check("activity shows the incremental recall reached the model",
          any("接续同一条线索" in str(e.get("summary", "")) and "新增 3 条" in str(e.get("summary", ""))
              for e in after if e.get("kind") == "activity"))

    st, delivered = call("GET", f"/api/threads/{thread_id}")
    check("delivery advances the watermark and closes the card",
          delivered.get("deliveredSeq") == through and delivered.get("openCardId") is None,
          {k: delivered.get(k) for k in ("deliveredSeq", "throughSeq", "openCardId")})
    st, delta = call("GET", f"/api/threads/{thread_id}/recall?afterSeq={through}")
    check("recall after the watermark is empty", st == 200 and delta.get("items") == [], delta)

    st, fourth = call("POST", "/api/threads/ingest",
                      {"botId": bot_id, "source": "github", "entity": "issue/12", "text": "又有一条新进展"})
    check("a new event reopens the chain with a fresh card", st == 202 and fourth.get("offered") is True)
    check("two thread-offer cards over the whole timeline", len(cards(bot_id, "thread-offer")) == 2)
    st, delta2 = call("GET", f"/api/threads/{thread_id}/recall?afterSeq={through}")
    check("delta recall contains only the new event",
          st == 200 and len(delta2.get("items", [])) == 1
          and delta2["items"][0].get("text") == "又有一条新进展", delta2)

    new_card = cards(bot_id, "thread-offer")[1]
    st, dismissed = call("POST", f"/api/cards/{new_card['cardId']}/act", {"action": "dismiss"})
    check("dismiss closes the chain without a turn",
          st == 200 and dismissed.get("status") == "dismissed" and dismissed.get("resultKind") == "none")
    check("dismiss did not create a second user message",
          len([e for e in transcript(bot_id) if e.get("kind") == "user/message"]) == 1)
    st, closed = call("GET", f"/api/threads/{thread_id}")
    check("dismissed chain is not resurrected later",
          closed.get("deliveredSeq") == closed.get("throughSeq"))

    st, dup = call("POST", "/api/threads/ingest",
                   {"botId": bot_id, "source": "github", "entity": "issue/12", "text": "又有一条新进展"})
    check("duplicate event is deduplicated", st == 202 and dup.get("duplicate") is True)
    st, missing = call("GET", "/api/threads/thr_missing")
    check("unknown thread is a 404", st == 404)
    st, bad = call("POST", "/api/threads/ingest", {"botId": bot_id, "source": "x", "entity": "y"})
    check("event without text is rejected", st == 400)

finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
    print("\n--- server log ---")
    print((out or "").strip()[:600])

failed = [n for n, ok in checks if not ok]
print(f"\nSUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
