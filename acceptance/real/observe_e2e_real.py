"""End-to-end probe of the proactive loop against the REAL model.

The judge gate was already measured in isolation (judge_probe.py). This probe
checks the rest of the Super-agent chain: an environment event is noticed, a
card is offered, the user delegates, and the SAME agent runs a real model turn
through to a single reply on the one timeline.

We deliberately assert only on LINK STRUCTURE (event kinds, seq watermark, one
outbox, terminal turn), never on the quality of what the model writes.
"""
import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request
import os
import tempfile

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.environ.get("RESIDENT_REPO", _REPO_ROOT)
SCRATCH = os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir())
DATA = os.path.join(SCRATCH, "p0a-observe-real-e2e")
REPORT = os.path.join(SCRATCH, "observe_e2e_report.txt")
ROOT = "http://127.0.0.1:3110"
KEY = os.environ.get("DSH_TEST_KEY", "")

shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(os.path.join(DATA, "materials"), exist_ok=True)
# A real local file so the agent has something truthful to read after delegation.
with open(os.path.join(DATA, "materials", "notes.md"), "w", encoding="utf-8") as f:
    f.write("# CI 构建日志片段\n\n"
            "TypeError: cannot read property 'id' of undefined\n"
            "  at renderUser (src/user.js:42)\n"
            "  at build (src/main.js:7)\n\n"
            "备注：user 对象在异步返回前被访问，需要先判空。\n")

env = dict(os.environ,
           PORT="3110", HOST="127.0.0.1", DATA_DIR=DATA,
           DEEPSEEK_API_KEY=KEY,
           DEEPSEEK_BASE_URL="https://api.qnaigc.com/v1",
           DEEPSEEK_MODEL="deepseek/deepseek-v4-flash",
           OBSERVER_MODE="observe")
for k in ("EXECUTOR_PROVIDER", "MAX_CONCURRENT_TURNS"):
    env.pop(k, None)

proc = subprocess.Popen(
    ["node", "src/server.mjs"], cwd=WORKSPACE, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    encoding="utf-8", errors="replace",
)
checks = []
notes = []


def check(name, cond, extra=""):
    checks.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + str(extra)) if extra else ""))


def note(name, value):
    notes.append((name, value))
    print(f"NOTE  {name}: {value}")


def call(method, path, body=None, timeout=30):
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
    check("service uses the REAL model", health and health.get("model") == "deepseek",
          health.get("model") if health else None)
    if not health or not health.get("ok"):
        raise SystemExit("service did not start")

    st, bot = call("POST", "/api/bots", {"name": "它"})
    bot_id = bot.get("id", "")
    check("bot created", bool(bot_id))

    # Enqueue both events back-to-back, then drive them in ONE deterministic
    # flush. No sleep between them: we must not let the resident timer steal a
    # batch while a manual flush is in flight.
    st, noise = call("POST", "/api/observations",
                     {"source": "github", "text": "今天的日程已同步", "botId": bot_id})
    check("noise event accepted for judgement", st == 202 and noise.get("accepted") is True)

    DEFECT = ("CI 构建失败：TypeError: cannot read property 'id' of undefined，"
              "请读 notes.md 分析原因并给出修复建议")
    st, defect = call("POST", "/api/observations",
                      {"source": "ci", "text": DEFECT, "botId": bot_id})
    check("defect event accepted", st == 202 and defect.get("accepted") is True)

    st, flushed = call("POST", "/api/observations/flush", {}, timeout=180)
    check("flush drove BOTH observations in one batch",
          st == 200 and flushed.get("flushed", 0) == 2,
          flushed.get("flushed") if isinstance(flushed, dict) else flushed)
    if isinstance(flushed, dict):
        note("observer stats after flush", {k: flushed[k] for k in
             ("received", "filtered", "judgedNo", "offered", "delegated", "rateLimited")
             if k in flushed})
        check("noise was judged false, defect offered (no concurrent judge)",
              flushed.get("judgedNo") == 1 and flushed.get("offered") == 1,
              f"judgedNo={flushed.get('judgedNo')} offered={flushed.get('offered')}")

    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0", timeout=30)
    items = tr.get("items", []) if isinstance(tr, dict) else []
    kinds = [e.get("kind") for e in items]
    note("timeline kinds before delegate", kinds)

    check("noise did NOT become an observation", kinds.count("observation") == 1,
          kinds.count("observation"))
    check("defect appears on the timeline", "observation" in kinds)
    cards = [e for e in items if e.get("kind") == "card" and e.get("cardType") == "observation-offer"]
    check("exactly one proactive offer card", len(cards) == 1, len(cards))
    check("card offers delegate / dismiss",
          bool(cards) and [a["id"] for a in cards[0].get("actions", [])] == ["delegate", "dismiss"])
    check("observe mode does NOT auto-delegate", "user/message" not in kinds)
    check("no assistant reply before the user delegates", "assistant/message" not in kinds)

    if not cards:
        raise SystemExit("no offer card, cannot exercise delegation")

    st, status2 = call("GET", "/api/observations")
    check("stats show an offer, no delegated turn", isinstance(status2, dict)
          and status2.get("offered", 0) >= 1 and status2.get("delegated", 0) == 0, status2)

    # The user delegates -> the SAME agent runs a real model turn.
    time.sleep(2.0)
    st, acted = call("POST", f"/api/cards/{cards[0]['cardId']}/act", {"action": "delegate"}, timeout=30)
    check("delegate action accepted", st == 200 and acted.get("status") == "saved")
    turn_id = (acted.get("result") or {}).get("turnId", "") if isinstance(acted, dict) else ""
    check("delegating produced a turnId", bool(turn_id), turn_id)

    turn = {}
    for _ in range(60):
        st, turn = call("GET", f"/api/turns/{turn_id}", timeout=15)
        if isinstance(turn, dict) and turn.get("status") in ("completed", "failed", "interrupted", "rejected"):
            break
        time.sleep(2.0)
    tstatus = turn.get("status") if isinstance(turn, dict) else "unknown"
    note("turn terminal status", tstatus)
    check("turn reached a terminal state",
          tstatus in ("completed", "failed", "interrupted", "rejected"), tstatus)

    st, tr2 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0", timeout=30)
    items2 = tr2.get("items", []) if isinstance(tr2, dict) else []
    kinds2 = [e.get("kind") for e in items2]
    note("timeline kinds after delegate", kinds2)

    check("delegating starts a real turn on the timeline", "user/message" in kinds2)
    check("a task row and exactly one task/done are written",
          "task" in kinds2 and kinds2.count("task/done") == 1,
          f"task={kinds2.count('task')} done={kinds2.count('task/done')}")
    replies = [e for e in items2 if e.get("kind") == "assistant/message"]
    check("there is at least one assistant reply", len(replies) >= 1, len(replies))
    check("all replies come through the single outbox",
          bool(replies) and all(e.get("viaOutbox") is True for e in replies),
          [e.get("viaOutbox") for e in replies])
    check("exactly one reply (one agent, one voice)", len(replies) == 1, len(replies))

    seqs = [e.get("seq") for e in items2 if isinstance(e.get("seq"), int)]
    check("seq watermark is strictly increasing", all(b > a for a, b in zip(seqs, seqs[1:])),
          f"n={len(seqs)}")

    tool_calls = [e for e in items2 if e.get("kind") == "tool/call"]
    note("real model actions executed", [e.get("name") for e in tool_calls])
    browsed = [e for e in tool_calls if e.get("name") == "browse"]
    if browsed:
        hit = (browsed[0].get("result") or {}).get("items", [])
        check("browse returned REAL local material (not a hallucinated read)",
              any("renderUser" in str(i.get("snippet", "")) for i in hit), len(hit))
    else:
        note("model chose not to browse", "allowed: we assert chain structure, not model behaviour")

    note("artifacts produced", len([e for e in items2 if e.get("kind") == "artifact"]))
    note("observation errors (rate limit etc.)",
         len([e for e in items2 if e.get("kind") == "observation/error"]))

finally:
    proc.terminate()
    try:
        server_log = proc.communicate(timeout=8)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        server_log = proc.communicate()[0]
    print("\n--- server log ---")
    print((server_log or "").strip()[:800])

failed = [n for n, ok in checks if not ok]
with open(REPORT, "w", encoding="utf-8") as f:
    f.write("主动观察端到端真模型实测 · model=deepseek/deepseek-v4-flash\n")
    f.write("=" * 92 + "\n")
    f.write("判据只看链路结构，不评生成质量。\n\n")
    for n, ok in checks:
        f.write(f"{'PASS' if ok else 'FAIL'}  {n}\n")
    f.write("-" * 92 + "\n")
    for n, v in notes:
        f.write(f"NOTE  {n}: {v}\n")
    f.write("-" * 92 + "\n")
    f.write((server_log or "").strip()[:800] + "\n")

print(f"\nreport -> {REPORT}")
print(f"SUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
