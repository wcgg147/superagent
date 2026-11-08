import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-p1-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3202"

env = dict(os.environ, PORT="3202", HOST="127.0.0.1", DATA_DIR=DATA)
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
    check("health", health and health.get("ok") is True)
    check("default executor still local", health and health.get("executor") == "local", health and health.get("executor"))
    st, page = call("GET", "/")
    check("index served with P1 entries", st == 200 and "workspaceBtn" in str(page) and "roomMentionWrap" in str(page))
    st, p1js = call("GET", "/p1.js")
    check("p1.js served", st == 200 and "renderSkills" in str(p1js) and "syncRoomMention" in str(p1js))

    st, bot = call("POST", "/api/bots", {"name": "P1Bot", "job": "验证 P1 接口"})
    bot_id = bot.get("id", "")
    check("create bot", st == 201 and bot_id.startswith("bot_"))
    st, sent = call("POST", f"/api/bots/{bot_id}/messages", {"text": "帮我写一份周报", "clientNonce": "p1-1"})
    check("send accepted", st == 202 and sent.get("accepted") is True)
    time.sleep(0.4)

    # ---- Skill
    st, sk = call("POST", "/api/skills/from-turn", {"turnId": sent["turnId"], "name": "周报流程"})
    check("skill from turn", st == 201 and "instruction" in sk, sk.get("id"))
    st, skills = call("GET", "/api/skills")
    check("list skills", st == 200 and len(skills.get("items", [])) == 1)
    st, run = call("POST", f"/api/skills/{sk['id']}/run", {"botId": bot_id, "input": "第二次"})
    check("run skill", st == 202 and run.get("accepted") is True)
    time.sleep(0.4)

    # ---- Routine
    st, rt = call("POST", "/api/routines", {
        "botId": bot_id, "name": "缺陷复现", "instruction": "复现这个缺陷",
        "trigger": {"type": "event", "source": "github", "phrase": "needs repro"},
    })
    check("create routine", st == 201 and rt.get("enabled") is True, rt.get("id"))
    st, ing = call("POST", "/api/events/ingest", {"source": "github", "text": "普通讨论"})
    check("narrow match ignores noise", st == 202 and len(ing.get("fired", [])) == 0)
    st, ing2 = call("POST", "/api/events/ingest", {"source": "github", "text": "#12 needs repro"})
    check("narrow match fires", st == 202 and len(ing2.get("fired", [])) == 1)
    st, toggle = call("POST", f"/api/routines/{rt['id']}/toggle", {"enabled": False})
    check("toggle routine", st == 200 and toggle.get("enabled") is False)
    st, removed = call("DELETE", f"/api/routines/{rt['id']}")
    check("delete routine", st == 200 and removed.get("removed") == rt["id"])

    # ---- Room
    st, bot2 = call("POST", "/api/bots", {"name": "乙"})
    st, room = call("POST", "/api/rooms", {"name": "协作群", "memberIds": [bot_id, bot2["id"]]})
    check("create room", st == 201 and len(room.get("members", [])) == 2, room.get("id"))
    st, fan = call("POST", f"/api/rooms/{room['id']}/messages", {"text": "大家一起看"})
    check("room fan-out", st == 202 and len(fan.get("targets", [])) == 2)
    st, mention = call("POST", f"/api/rooms/{room['id']}/messages",
                       {"text": "@P1Bot 交给你", "mentions": [bot_id]})
    check("@ narrows targets", st == 202 and mention.get("targets") == [bot_id])
    st, bots = call("GET", "/api/bots")
    check("rooms excluded from bot list", all(b.get("kind") != "room" for b in bots.get("items", [])))
    st, rooms = call("GET", "/api/rooms")
    check("list rooms", st == 200 and len(rooms.get("items", [])) == 1)

    # ---- regression of P0-A
    st, err = call("GET", "/api/bots/bot_missing")
    check("404 error family", st == 404 and err.get("error", {}).get("family") == "transport")
    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    check("transcript intact", st == 200 and any(e.get("kind") == "artifact" for e in tr.get("items", [])))

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
