import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-exec-e2e")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3103"

env = dict(os.environ, PORT="3103", HOST="127.0.0.1", DATA_DIR=DATA, EXECUTOR_PROVIDER="gray")
env.pop("DEEPSEEK_API_KEY", None)
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
    check("default executor still local", health and health.get("executor") == "local")
    check("health reports gray mode", health and health.get("mode") == "gray", health and health.get("mode"))

    st, status = call("GET", "/api/executors")
    check("executor status: gray + dsh available", st == 200 and status.get("mode") == "gray"
          and status.get("dshAvailable") is True and status.get("grayBots") == [])

    st, a = call("POST", "/api/bots", {"name": "灰度甲"})
    st, b = call("POST", "/api/bots", {"name": "灰度乙"})
    check("two bots created", st == 201 and a.get("id") and b.get("id"))

    st, moved = call("POST", f"/api/bots/{a['id']}/executor", {"provider": "dsh"})
    check("opt one bot into dsh", st == 200 and moved.get("executor") == "dsh")
    st, status2 = call("GET", "/api/executors")
    check("gray list contains only that bot", status2.get("grayBots") == [a["id"]], status2.get("grayBots"))

    st, bad = call("POST", f"/api/bots/{a['id']}/executor", {"provider": "bogus"})
    check("invalid provider rejected", st == 400 and bad.get("error", {}).get("family") == "transport")

    st, rolled = call("POST", "/api/executors/rollback")
    check("one-click rollback", st == 200 and rolled.get("rolledBack") == 1, rolled.get("rolledBack"))
    st, status3 = call("GET", "/api/executors")
    check("gray list empty after rollback", status3.get("grayBots") == [], status3.get("grayBots"))
    check("default executor unchanged", status3.get("defaultExecutor") == "local")

    st, sent = call("POST", f"/api/bots/{a['id']}/messages", {"text": "帮我写一份周报"})
    time.sleep(0.5)
    st, tr = call("GET", f"/api/bots/{a['id']}/transcript?cursor=0")
    check("product loop still works after rollback", st == 200
          and any(e.get("kind") == "artifact" for e in tr.get("items", [])))

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
