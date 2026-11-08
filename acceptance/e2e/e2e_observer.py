import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-observe-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3105"

env = dict(os.environ, PORT="3105", HOST="127.0.0.1", DATA_DIR=DATA)
env.pop("DEEPSEEK_API_KEY", None)
env.pop("EXECUTOR_PROVIDER", None)
env.pop("OBSERVER_MODE", None)  # default: observe
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

try:
    health = None
    for _ in range(60):
        try:
            st, health = call("GET", "/api/health")
            if st == 200: break
        except Exception:
            time.sleep(0.25)
    check("service started", health and health.get("ok") is True)

    st, bot = call("POST", "/api/bots", {"name": "它"})
    bot_id = bot.get("id", "")

    st, status = call("GET", "/api/observations")
    check("observer defaults to observe mode", st == 200 and status.get("mode") == "observe", status.get("mode"))

    st, noise = call("POST", "/api/observations", {"source": "chat", "text": "今天天气不错，午饭吃了什么"})
    check("casual event accepted for judgement", st == 202 and noise.get("accepted") is True)
    st, defect = call("POST", "/api/observations",
                      {"source": "github", "text": "#12 报错 needs repro 请复现"})
    check("defect event accepted", st == 202 and defect.get("accepted") is True)

    time.sleep(2.8)  # let the resident loop process the queue

    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    items = tr.get("items", [])
    kinds = [e.get("kind") for e in items]
    check("noticed event appears on the timeline", "observation" in kinds, kinds)
    card = next((e for e in items if e.get("kind") == "card" and e.get("cardType") == "observation-offer"), None)
    check("proactive card is offered", card is not None)
    check("card offers delegate / dismiss", card and [a["id"] for a in card.get("actions", [])] == ["delegate", "dismiss"])
    check("observe mode does NOT auto-delegate", "user/message" not in kinds)

    st, status2 = call("GET", "/api/observations")
    check("observer stats show an offer without a turn", status2.get("offered", 0) >= 1
          and status2.get("delegated", 0) == 0, status2)

    st, acted = call("POST", f"/api/cards/{card['cardId']}/act", {"action": "delegate"})
    check("delegate card action accepted", st == 200 and acted.get("status") == "saved")
    time.sleep(0.6)
    st, tr2 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    check("delegating starts a real turn", any(e.get("kind") == "user/message" for e in tr2.get("items", [])))

    st, dup = call("POST", "/api/observations", {"source": "github", "text": "#12 报错 needs repro 请复现"})
    check("duplicate event is deduplicated", st == 202 and dup.get("accepted") is False
          and dup.get("reason") == "duplicate", dup.get("reason"))

    st, short = call("POST", "/api/observations", {"source": "ci", "text": "123"})
    check("fast path filters obvious noise", st == 202 and short.get("reason") == "fast-path")

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
