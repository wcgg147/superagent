import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-cards-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3102"

env = dict(os.environ, PORT="3102", HOST="127.0.0.1", DATA_DIR=DATA)
env.pop("DEEPSEEK_API_KEY", None)
env.pop("EXECUTOR_PROVIDER", None)
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

    st, bot = call("POST", "/api/bots", {"name": "卡片Bot"})
    bot_id = bot.get("id", "")
    st, sent = call("POST", f"/api/bots/{bot_id}/messages", {"text": "帮我写一份周报"})
    time.sleep(0.5)

    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    cards = [e for e in tr.get("items", []) if e.get("kind") == "card"]
    check("one typed card offered in conversation", len(cards) == 1, len(cards))
    card = cards[0] if cards else {}
    check("card has 3 actions", len(card.get("actions", [])) == 3)
    check("card initiator is agent", card.get("initiator") == "agent")

    cid = card.get("cardId", "")
    st, info = call("GET", f"/api/cards/{cid}")
    check("card starts pending", st == 200 and info.get("status") == "pending")

    st, acted = call("POST", f"/api/cards/{cid}/act", {"action": "save-skill"})
    check("save-skill creates a skill", st == 200 and acted.get("status") == "saved"
          and str(acted.get("result", {}).get("id", "")).startswith("skl_"))
    st, skills = call("GET", "/api/skills")
    check("skill list has 1 item", len(skills.get("items", [])) == 1)

    st, again = call("POST", f"/api/cards/{cid}/act", {"action": "save-routine"})
    check("repeat action is idempotent", st == 200 and again.get("status") == "saved")
    st, skills2 = call("GET", "/api/skills")
    check("no duplicate skill created", len(skills2.get("items", [])) == 1)

    st, tr2 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    resolved = [e for e in tr2.get("items", []) if e.get("kind") == "card/resolved"]
    check("resolved event recorded with initiator", len(resolved) == 1
          and resolved[0].get("initiator") == "card_action")

    call("POST", f"/api/bots/{bot_id}/messages", {"text": "你好"})
    time.sleep(0.4)
    st, tr3 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    check("pure chat does not add another card",
          len([e for e in tr3.get("items", []) if e.get("kind") == "card"]) == 1)

    st, missing = call("GET", "/api/cards/crd_nope")
    check("unknown card 404", st == 404)

    call("POST", f"/api/bots/{bot_id}/messages", {"text": "再写一份报告"})
    time.sleep(0.4)
    st, tr4 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    fresh = [e for e in tr4.get("items", []) if e.get("kind") == "card"][-1]
    st, bad = call("POST", f"/api/cards/{fresh['cardId']}/act", {"action": "rm-rf"})
    check("invalid card action rejected", st == 400 and bad.get("error", {}).get("family") == "transport")

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
