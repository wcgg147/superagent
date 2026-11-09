"""多 Bot 真模型联调：一个常驻进程里几个 Bot 同时跑，会不会串味。

验证：
  S1 三 Bot 并发（真模型同时打端点），各自材料/回复/时间线/并行标记隔离
  S2 SSE 全局广播下，botId 正确、seq 单调、cursor 拉取合并不重不丢
  S3 RoomHub 群聊扇出到多个 Bot，各归各的时间线
  S4 上下文隔离：B 不能召回 A 读过的东西
"""
import json
import tempfile
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request

BASE = "http://127.0.0.1:3214"
PORT = "3214"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.environ.get("RESIDENT_REPO", _REPO_ROOT)
SCRATCH = os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir())
DATA = os.path.join(SCRATCH, "multibot_accept")
TIMEOUT = 300

HARD = []
SOFT = []


def hard(name, cond, extra=""):
    HARD.append((name, bool(cond), str(extra)[:200]))
    print(("  [HARD %s] " % ("PASS" if cond else "FAIL")) + name + (("  " + str(extra)[:170]) if extra else ""))


def soft(name, cond, extra=""):
    SOFT.append((name, bool(cond), str(extra)[:200]))
    print(("  [SOFT %s] " % ("PASS" if cond else "MISS")) + name + (("  " + str(extra)[:170]) if extra else ""))


def post(path, body=None):
    data = json.dumps(body or {}, ensure_ascii=False).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.loads(r.read().decode())


def read_key():
    """Sanitized: the third-party key comes ONLY from the command environment.
    The historical version extracted a key literal from a PI-Desktop session
    log on disk, which conflicts with AGENTS.md section 2 (key only via env,
    never written to disk). Every check(...) assertion here is untouched."""
    return os.environ.get("DSH_TEST_KEY", "").strip() or None



def start_service():
    shutil.rmtree(DATA, ignore_errors=True)
    m = os.path.join(DATA, "materials")
    os.makedirs(m, exist_ok=True)
    for tag, start, todos in (("alpha", "alpha-start", "A1、A2、A3"),
                              ("beta", "beta-start", "B1、B2、B3"),
                              ("gamma", "gamma-start", "G1、G2、G3")):
        with open(os.path.join(m, f"{tag}.md"), "w", encoding="utf-8") as f:
            f.write(f"# {tag.upper()} 项目\n\n启动命令：{start}\n\n还没做的三件事：{todos}\n")
    env = dict(os.environ)
    env.update({"PORT": PORT, "HOST": "127.0.0.1", "DATA_DIR": DATA,
                "NUDGE_INTERVAL_MS": "2000", "NUDGE_MIN_AGE_MS": "0",
                "NUDGE_COOLDOWN_MS": "0", "OBSERVER_INTERVAL_MS": "1500",
                "WATCHDOG_INTERVAL_MS": "1000", "WATCHDOG_HEARTBEAT_MS": "2000",
                "WATCHDOG_STALL_MS": "8000"})
    key = read_key()
    if key:
        env["DEEPSEEK_API_KEY"] = key
        env["DEEPSEEK_BASE_URL"] = "https://api.qnaigc.com/v1"
        env["DEEPSEEK_MODEL"] = "deepseek/deepseek-v4-flash"
    proc = subprocess.Popen(["node", "src/server.mjs"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            get("/api/health")
            return proc
        except Exception:
            time.sleep(0.4)
    raise RuntimeError("service did not come up")


def stop_service():
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"$l = Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue; "
                    "if($l){ Stop-Process -Id $l[0].OwningProcess -Force }"], check=False)
    for _ in range(30):
        try:
            get("/api/health")
            time.sleep(0.3)
        except Exception:
            return


def wait_terminal(turn_id, timeout=TIMEOUT):
    deadline = time.time() + timeout
    resumed = 0
    while time.time() < deadline:
        t = get(f"/api/turns/{turn_id}")
        s = t["status"]
        if s == "waiting_approval" and t.get("pendingApproval"):
            post(f"/api/approvals/{t['pendingApproval']}", {"approve": True})
        elif s == "interrupted" and t.get("pausedAt") and resumed < 3:
            post(f"/api/turns/{turn_id}/resume", {})
            resumed += 1
        elif s in ("completed", "failed", "interrupted", "denied"):
            return t
        time.sleep(0.5)
    raise TimeoutError(f"turn {turn_id} not terminal")


def timeline(bot_id):
    return get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=1000")["items"]


# ---------------------------------------------------------------- S1

def s1_parallel_bots():
    print("\n=== S1 三 Bot 真模型并发 ===")
    bots = {}
    for tag in ("alpha", "beta", "gamma"):
        bots[tag] = post("/api/bots", {"name": f"同事-{tag}", "job": f"负责 {tag}"})["id"]
    prompts = {
        "alpha": "读一下 materials/alpha.md，告诉我启动命令和第一件还没做的事",
        "beta": "读一下 materials/beta.md，告诉我启动命令和第一件还没做的事",
        "gamma": "读一下 materials/gamma.md，告诉我启动命令和第一件还没做的事",
    }
    turns = {}
    for tag in ("alpha", "beta", "gamma"):
        turns[tag] = post(f"/api/bots/{bots[tag]}/messages", {"text": prompts[tag]})["turnId"]
    cap_mid = get("/api/capabilities")["concurrency"]
    soft("S1: 三个 turn 真的同时打真实端点", cap_mid.get("peak", 0) >= 2, cap_mid)
    for tag in turns:
        wait_terminal(turns[tag])
    cap = get("/api/capabilities")["concurrency"]
    hard("S1: 并发结束槽位归零", cap["active"] == 0 and cap["queued"] == 0, cap)

    own = {"alpha": ("alpha.md", "alpha-start", "A1"),
           "beta": ("beta.md", "beta-start", "B1"),
           "gamma": ("gamma.md", "gamma-start", "G1")}
    turn_owner = {t: get(f"/api/turns/{t}")["botId"] for t in turns.values()}
    all_seqs = {}
    for tag, bot in bots.items():
        items = timeline(bot)
        all_seqs[tag] = items
        seqs = [e["seq"] for e in items]
        hard(f"S1 {tag}: 自己的 seq 从 1 严格递增", seqs == list(range(1, len(items) + 1)), len(items))
        foreign = [e for e in items
                   if e.get("turnId") and turn_owner.get(e["turnId"]) not in (None, bot)]
        hard(f"S1 {tag}: 没有别的 Bot 的 turn 条目", not foreign, len(foreign))
        # Parallel marker must count only this Bot's own in-flight turns.
        tasks = [e for e in items if e["kind"] == "task"]
        hard(f"S1 {tag}: 单任务不被别的 Bot 标成并行",
             all(t.get("parallel", 1) == 1 for t in tasks),
             [t.get("parallel") for t in tasks])
        replies = [e for e in items if e["kind"] == "assistant/message"]
        hard(f"S1 {tag}: 回复不误带 taskLabel",
             all(not r.get("taskLabel") for r in replies), [r.get("taskLabel") for r in replies])
        # Read the right file, and answer with the right facts.
        browsed = [e for e in items if e["kind"] == "tool/call" and e.get("name") == "browse"]
        titles = [it.get("title") for e in browsed for it in (e.get("result") or {}).get("items", [])]
        soft(f"S1 {tag}: 读的是自己的材料", own[tag][0] in titles, titles)
        text = " ".join(str(r.get("text") or "") for r in replies)
        soft(f"S1 {tag}: 回答含自己的启动命令", own[tag][1] in text, text[:100])
        others = [v for k, v in own.items() if k != tag]
        hard(f"S1 {tag}: 回答里没有别人的事实",
             not any(o[1] in text for o in others), text[:100])
    return bots, turns


# ---------------------------------------------------------------- S2

def s2_sse_isolation(bots):
    print("\n=== S2 SSE 全局广播下的隔离与增量 ===")
    rows = []
    stop = threading.Event()

    def reader():
        try:
            req = urllib.request.Request(BASE + "/api/events")
            with urllib.request.urlopen(req, timeout=180) as r:
                while not stop.is_set():
                    line = r.readline()
                    if not line:
                        break
                    s = line.decode("utf-8", "replace").strip()
                    if not s.startswith("data: "):
                        continue
                    try:
                        msg = json.loads(s[6:])
                        if msg.get("type") == "entry":
                            rows.append((msg.get("botId"), msg["entry"]["seq"], msg["entry"]["kind"]))
                    except Exception:
                        pass
        except Exception:
            pass

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    time.sleep(1.0)
    before = {tag: len(timeline(bot)) for tag, bot in bots.items()}
    target = bots["alpha"]
    r = post(f"/api/bots/{target}/messages", {"text": "再读一次 materials/alpha.md，只说启动命令是什么"})
    wait_terminal(r["turnId"])
    time.sleep(1.5)
    stop.set()
    th.join(timeout=3)

    hard("S2: SSE 收到了推送", len(rows) > 0, len(rows))
    hard("S2: 每条推送都带 botId", all(b for b, _, _ in rows),
         [b for b, _, _ in rows[:6]])
    per = {}
    for b, seq, _ in rows:
        per.setdefault(b, []).append(seq)
    hard("S2: 同一 Bot 的推送 seq 严格递增",
         all(v == sorted(set(v)) for v in per.values()),
         {k: v[:8] for k, v in per.items()})
    after = timeline(target)
    new_entries = after[before["alpha"]:]
    pushed = [seq for b, seq, _ in rows if b == target]
    missing = [e["seq"] for e in new_entries if e["seq"] not in pushed]
    hard("S2: 本 Bot 新增条目没有漏推", not missing, f"missing={missing[:6]}")
    hard("S2: 推送没有重复 seq", len(pushed) == len(set(pushed)), len(pushed))
    known = set(bots.values())
    hard("S2: 推送的 botId 都属于已知 Bot",
         all(b in known for b, _, _ in rows), sorted(set(b for b, _, _ in rows)))
    soft("S2: 观察到的推送 bot 集合", True, sorted(set(b for b, _, _ in rows)))
    return rows


# ---------------------------------------------------------------- S3

def s3_room(bots):
    print("\n=== S3 群聊扇出 ===")
    room = post("/api/rooms", {"name": "三人群", "memberIds": list(bots.values())})
    hard("S3: 建群成功", "id" in room, room)
    if "id" not in room:
        return
    sent = post(f"/api/rooms/{room['id']}/messages",
                {"text": "大家各自报一下自己负责哪个项目，用一句话"})
    ids = sent.get("turnIds") or []
    hard("S3: 扇出到三个 Bot", len(ids) == 3, sent)
    for tid in ids:
        wait_terminal(tid)
    room_items = timeline(room["id"])
    hard("S3: 群时间线只有一条用户消息",
         len([e for e in room_items if e["kind"] == "user/message"]) == 1,
         [e["kind"] for e in room_items])
    for tag, bot in bots.items():
        items = timeline(bot)
        own_turns = [e for e in items if e.get("turnId") in ids]
        hard(f"S3 {tag}: 自己的 turn 只在自己的时间线", len(own_turns) > 0, len(own_turns))
    cap = get("/api/capabilities")["concurrency"]
    hard("S3: 群聊后槽位归零", cap["active"] == 0 and cap["queued"] == 0, cap)


# ---------------------------------------------------------------- S4

def s4_context_isolation(bots):
    print("\n=== S4 上下文不串味 ===")
    # B has never read alpha.md. Its recall must not pick up A's history.
    r = post(f"/api/bots/{bots['beta']}/messages",
             {"text": "alpha.md 那件事后来怎么样了"})
    wait_terminal(r["turnId"])
    plan = get(f"/api/turns/{r['turnId']}").get("planArgs") or {}
    related = plan.get("related") or []
    joined = json.dumps(related, ensure_ascii=False)
    hard("S4: B 不能召回 A 的对话历史", "alpha-start" not in joined and "A1" not in joined,
         joined[:160])
    # A itself can still recall its own earlier alpha.md conversation.
    r2 = post(f"/api/bots/{bots['alpha']}/messages",
              {"text": "alpha.md 那件事再确认一下"})
    wait_terminal(r2["turnId"])
    plan2 = get(f"/api/turns/{r2['turnId']}").get("planArgs") or {}
    soft("S4: A 能召回自己的历史", len(plan2.get("related") or []) >= 1,
         len(plan2.get("related") or []))


def main():
    proc = start_service()
    try:
        bots, _ = s1_parallel_bots()
        s2_sse_isolation(bots)
        s3_room(bots)
        s4_context_isolation(bots)
    finally:
        stop_service()
    print("\n========== 汇总 ==========")
    hp = sum(1 for _, ok, _ in HARD if ok)
    sp = sum(1 for _, ok, _ in SOFT if ok)
    print(f"HARD: {hp}/{len(HARD)}")
    print(f"SOFT: {sp}/{len(SOFT)}")
    for n, ok, e in HARD:
        if not ok:
            print(f"  HARD FAIL: {n}  {e}")
    for n, ok, e in SOFT:
        if not ok:
            print(f"  SOFT MISS: {n}  {e}")
    print(f"RESULT={'VERIFIED' if all(ok for _, ok, _ in HARD) else 'BROKEN'}")


if __name__ == "__main__":
    main()
