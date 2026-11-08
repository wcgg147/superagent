import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-p2-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3104"

env = dict(os.environ, PORT="3104", HOST="127.0.0.1", DATA_DIR=DATA)
env.pop("DEEPSEEK_API_KEY", None)
env.pop("EXECUTOR_PROVIDER", None)
env.pop("DSH_CLI_ENTRY", None)
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

    st, bot = call("POST", "/api/bots", {"name": "P2Bot"})
    bot_id = bot.get("id", "")
    st, team = call("POST", "/api/teams", {"name": "小队", "quotaPerDay": 1})
    check("create team with daily quota", st == 201 and team.get("quotaPerDay") == 1)
    st, assigned = call("POST", f"/api/teams/{team['id']}/assign", {"botId": bot_id})
    check("assign bot to team", st == 200 and assigned.get("teamId") == team["id"])

    st, quota = call("GET", "/api/quota")
    check("quota status starts at zero", st == 200 and quota["teams"][0]["usedToday"] == 0)

    st, channel = call("POST", "/api/channels", {
        "name": "GitHub", "kind": "webhook", "botId": bot_id, "phrase": "needs repro",
    })
    token = channel.get("token", "")
    channel_id = channel.get("id", "")
    check("create channel returns one-time token", st == 201 and token.startswith("ch_"), channel_id)

    st, listed = call("GET", "/api/channels")
    item = listed.get("items", [{}])[0] if listed.get("items") else {}
    check("channel list hides token and hash", "token" not in item and "tokenHash" not in item)

    st, bad = call("POST", f"/api/channels/{channel_id}/ingest", {"token": "wrong", "text": "needs repro"})
    check("wrong token rejected", st == 401 and bad.get("error", {}).get("code") == "CHANNEL_TOKEN_INVALID")

    st, miss = call("POST", f"/api/channels/{channel_id}/ingest", {"token": token, "text": "普通讨论"})
    check("narrow match ignores noise", st == 202 and miss.get("matched") is False and miss.get("fired") == [])

    st, hit = call("POST", f"/api/channels/{channel_id}/ingest",
                   {"token": token, "source": "github", "text": "#12 needs repro"})
    check("matching event commands the bot", st == 202 and hit.get("matched") is True and len(hit.get("fired", [])) == 1)

    st, over = call("POST", f"/api/channels/{channel_id}/ingest",
                    {"token": token, "source": "github", "text": "#13 needs repro"})
    check("channel cannot bypass quota", st == 402 and over.get("error", {}).get("code") == "USAGE_LIMIT")
    check("quota error has a truthful title", "用量" in str(over.get("error", {}).get("title", "")))

    st, audit = call("GET", f"/api/channels/{channel_id}/audit")
    items = audit.get("items", [])
    check("every call is audited", len(items) == 3, len(items))
    check("audit records the quota failure", any(e.get("error") == "USAGE_LIMIT" for e in items))
    check("audit never contains tokens", all("token" not in e for e in items))

    st, toggled = call("POST", f"/api/channels/{channel_id}/toggle", {"enabled": False})
    check("disable channel", st == 200 and toggled.get("enabled") is False)
    st, disabled = call("POST", f"/api/channels/{channel_id}/ingest", {"token": token, "text": "hi"})
    check("disabled channel refuses calls", st == 403 and disabled.get("error", {}).get("code") == "CHANNEL_DISABLED")

    st, revoked = call("DELETE", f"/api/channels/{channel_id}")
    check("revoke channel", st == 200 and revoked.get("revoked") == channel_id)
    st, gone = call("POST", f"/api/channels/{channel_id}/ingest", {"token": token, "text": "hi"})
    check("revoked channel refuses calls", st == 404)
    st, after = call("GET", "/api/channels")
    check("revoked channel disappears from audit surface", all(c.get("id") != channel_id for c in after.get("items", [])))

    st, quota2 = call("GET", "/api/quota")
    check("quota consumed exactly once", quota2["teams"][0]["usedToday"] == 1, quota2["teams"][0]["usedToday"])

    time.sleep(0.4)
    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    check("channel-driven turn produced a transcript", any(e.get("kind") == "user/message" for e in tr.get("items", [])))

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
