"""Concurrency of turns against the REAL model.

The existing e2e_concurrency.py proves slot/queue behaviour with a local slow
stub. This probe asks a harder question: when several turns really call the
real DeepSeek endpoint at once, does our chain still hold? We assert only on
link structure (one outbox, one task/done per turn, seq watermark, terminal
states), not on generation quality.
"""
import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request
import os
import tempfile

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.environ.get("RESIDENT_REPO", _REPO_ROOT)
SCRATCH = os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir())
DATA = os.path.join(SCRATCH, "p0a-conc-real-e2e")
REPORT = os.path.join(SCRATCH, "conc_e2e_report.txt")
ROOT = "http://127.0.0.1:3210"
KEY = os.environ.get("DSH_TEST_KEY", "")
N = 3

shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)

env = dict(os.environ,
           PORT="3210", HOST="127.0.0.1", DATA_DIR=DATA,
           MAX_CONCURRENT_TURNS=str(N),
           DEEPSEEK_API_KEY=KEY,
           DEEPSEEK_BASE_URL="https://api.qnaigc.com/v1",
           DEEPSEEK_MODEL="deepseek/deepseek-v4-flash",
           DEEPSEEK_REASONING_EFFORT="low")
for k in ("EXECUTOR_PROVIDER", "OBSERVER_MODE"):
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
    conc = (health or {}).get("concurrency", {})
    check("MAX_CONCURRENT_TURNS=3 is honoured", conc.get("maxConcurrent") == N, conc)

    st, bot = call("POST", "/api/bots", {"name": "它", "job": "同时推进几件事"})
    bot_id = bot.get("id", "")
    check("bot created", bool(bot_id))

    TEXTS = [
        "用一句话说明什么是幂等",
        "用一句话说明什么是游标",
        "用一句话说明什么是退避重试",
    ]
    sends = []
    for i, text in enumerate(TEXTS):
        st, r = call("POST", f"/api/bots/{bot_id}/messages",
                     {"text": text, "clientNonce": f"conc-real-{i}"}, timeout=20)
        sends.append((st, r))
    check("all three sends accepted", all(st == 202 and r.get("accepted") for st, r in sends))
    check("none of them queued (3 slots for 3 turns)",
          all(r.get("queued") is False for _, r in sends),
          [(r.get("queued"), r.get("position")) for _, r in sends])
    turn_ids = [r.get("turnId") for _, r in sends]
    check("three distinct turnIds", len(set(turn_ids)) == N and all(turn_ids), turn_ids)
    check("each send carries a taskLabel",
          all(r.get("taskLabel") for _, r in sends),
          [r.get("taskLabel") for _, r in sends])

    st, during = call("GET", "/api/capabilities", timeout=15)
    note("concurrency while in flight", during.get("concurrency", {}) if isinstance(during, dict) else during)

    statuses = {}
    deadline = time.time() + 240
    while time.time() < deadline:
        statuses = {}
        for tid in turn_ids:
            st, t = call("GET", f"/api/turns/{tid}", timeout=15)
            statuses[tid] = t.get("status") if isinstance(t, dict) else "unknown"
        if all(v in ("completed", "failed", "interrupted", "rejected") for v in statuses.values()):
            break
        time.sleep(2.0)
    note("turn terminal statuses", list(statuses.values()))
    check("every turn reached a terminal state",
          all(v in ("completed", "failed", "interrupted", "rejected") for v in statuses.values()),
          statuses)
    check("no turn was left running", "running" not in statuses.values(), statuses)

    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=500", timeout=30)
    items = tr.get("items", []) if isinstance(tr, dict) else []
    kinds = [e.get("kind") for e in items]
    note("timeline kinds", kinds)

    users = [e for e in items if e.get("kind") == "user/message"]
    check("three user messages on the one timeline", len(users) == N, len(users))
    tasks = [e for e in items if e.get("kind") == "task"]
    done = [e for e in items if e.get("kind") == "task/done"]
    check("one task row per turn", len(tasks) == N, len(tasks))
    check("exactly one task/done per turn (no duplicate close)", len(done) == N, len(done))

    all_replies = [e for e in items if e.get("kind") == "assistant/message"]
    note("assistant replies", len(all_replies))
    # Interjection acknowledgements are outbound messages too, but they are
    # notices rather than a turn's answer: keep the per-turn invariant on the
    # answers, and assert the acknowledgements separately. Mirrors the fix
    # already applied to the deterministic e2e_concurrency.py group.
    replies = [e for e in all_replies if not e.get("interjection")]
    acks = [e for e in all_replies if e.get("interjection")]
    check("all replies come through the single outbox",
          bool(all_replies) and all(e.get("viaOutbox") is True for e in all_replies),
          [e.get("viaOutbox") for e in all_replies])
    check("parallel replies carry a taskLabel so the user can tell them apart",
          bool(replies) and all(e.get("taskLabel") for e in replies),
          [e.get("taskLabel") for e in replies])
    check("one reply per turn (no duplicate voice)", len(replies) == N, len(replies))
    check("interjection acks also come from the single outbox",
          len(acks) >= 1 and all(e.get("viaOutbox") is True for e in acks), len(acks))

    seqs = [e.get("seq") for e in items if isinstance(e.get("seq"), int)]
    check("seq watermark strictly increasing under concurrency",
          all(b > a for a, b in zip(seqs, seqs[1:])), f"n={len(seqs)}")

    errors = [e for e in items if e.get("kind") in ("error", "turn/error")]
    note("error events on timeline", len(errors))
    note("completed turns", sum(1 for v in statuses.values() if v == "completed"))

finally:
    proc.terminate()
    try:
        server_log = proc.communicate(timeout=8)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        server_log = proc.communicate()[0]
    print("\n--- server log ---")
    print((server_log or "").strip()[:900])

failed = [n for n, ok in checks if not ok]
with open(REPORT, "w", encoding="utf-8") as f:
    f.write("并发 turn 真模型实测 · model=deepseek/deepseek-v4-flash\n")
    f.write("=" * 92 + "\n")
    f.write("判据只看链路结构，不评生成质量。\n\n")
    for n, ok in checks:
        f.write(f"{'PASS' if ok else 'FAIL'}  {n}\n")
    f.write("-" * 92 + "\n")
    for n, v in notes:
        f.write(f"NOTE  {n}: {v}\n")
    f.write("-" * 92 + "\n")
    f.write((server_log or "").strip()[:900] + "\n")

print(f"\nreport -> {REPORT}")
print(f"SUMMARY: {len(checks) - len(failed)}/{len(checks)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
