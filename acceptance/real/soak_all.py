"""真模型全流程联调（soak）：一个常驻进程，把所有能力串起来。

刻意不手动调用 /api/nudges/scan、/api/observations/flush、/api/watchdog/tick，
让三个常驻循环靠自己的定时器跑 —— 这是此前八件套从没验证过的部分。

判据分两层：
  HARD  链路不变量（崩了就是没跑通）：seq 递增、task/done 配对、槽位归零、
        统一出口、重启无孤儿、定时器自驱
  SOFT  能力触发率（如实报告，不因模型没配合就判链路崩）
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3213"
ROOT = r"C:\Users\meme\Desktop\deepseek"
SCRATCH = os.environ.get("PI_SCRATCH_DIR", r"C:\Users\meme\.pi-desktop\scratch")
PORT = "3213"
ROUNDS = int(os.environ.get("SOAK_ROUNDS", "1"))
TIMEOUT = 300

HARD = []
SOFT = []
LATENCY = []


def hard(name, cond, extra=""):
    HARD.append((name, bool(cond), str(extra)[:200]))
    print(("  [HARD %s] " % ("PASS" if cond else "FAIL")) + name + (("  " + str(extra)[:160]) if extra else ""))


def soft(name, cond, extra=""):
    SOFT.append((name, bool(cond), str(extra)[:200]))
    print(("  [SOFT %s] " % ("PASS" if cond else "MISS")) + name + (("  " + str(extra)[:160]) if extra else ""))


def post(path, body=None):
    data = json.dumps(body or {}, ensure_ascii=False).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.loads(r.read().decode())


def alive():
    try:
        get("/api/health")
        return True
    except Exception:
        return False


def read_key():
    """Sanitized: the third-party key comes ONLY from the command environment.
    The historical version extracted a key literal from a PI-Desktop session
    log on disk, which conflicts with AGENTS.md section 2 (key only via env,
    never written to disk). Every check(...) assertion here is untouched."""
    return os.environ.get("DSH_TEST_KEY", "").strip() or None



def service_env(data_dir):
    env = dict(os.environ)
    env.update({
        "PORT": PORT, "HOST": "127.0.0.1", "DATA_DIR": data_dir,
        "NUDGE_INTERVAL_MS": "2000", "NUDGE_MIN_AGE_MS": "0", "NUDGE_COOLDOWN_MS": "0",
        "OBSERVER_INTERVAL_MS": "800",
        "WATCHDOG_INTERVAL_MS": "1000", "WATCHDOG_HEARTBEAT_MS": "2000",
        "WATCHDOG_STALL_MS": "8000",
    })
    key = read_key()
    if key:
        env["DEEPSEEK_API_KEY"] = key
        env["DEEPSEEK_BASE_URL"] = "https://api.qnaigc.com/v1"
        env["DEEPSEEK_MODEL"] = "deepseek/deepseek-v4-flash"
    return env


def start_service(data_dir):
    os.makedirs(os.path.join(data_dir, "materials"), exist_ok=True)
    src = os.path.join(SCRATCH, "delivery_accept", "materials", "项目现状.md")
    if os.path.exists(src):
        shutil.copyfile(src, os.path.join(data_dir, "materials", "项目现状.md"))
    proc = subprocess.Popen(["node", "src/server.mjs"], cwd=ROOT, env=service_env(data_dir),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        if alive():
            return proc
        time.sleep(0.4)
    raise RuntimeError("service did not come up")


def stop_service():
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"$l = Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue; "
                    "if($l){ Stop-Process -Id $l[0].OwningProcess -Force }"], check=False)
    for _ in range(30):
        if not alive():
            return
        time.sleep(0.3)


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


def new_bot(label):
    return post("/api/bots", {"name": "联调-" + label, "job": "常驻同事"})["id"]


def invariants(items, tag):
    seqs = [e["seq"] for e in items]
    hard(f"{tag}: seq 严格递增", seqs == list(range(1, len(items) + 1)),
         f"{len(items)} 条" if seqs == list(range(1, len(items) + 1)) else f"首异常 {seqs[:8]}")
    msgs = [e for e in items if e["kind"] == "assistant/message"]
    hard(f"{tag}: 回复全走统一出口", all(m.get("viaOutbox") is True for m in msgs), f"{len(msgs)} 条")
    starts = [e for e in items if e["kind"] == "task" and e.get("turnId")]
    dones = [e for e in items if e["kind"] == "task/done" and e.get("turnId")]
    # A paused-then-resumed turn legitimately has TWO start/done pairs. Compare
    # counts per turn, not "exactly one done per turn".
    hard(f"{tag}: task 与 task/done 数量相等", len(starts) == len(dones),
         f"{len(starts)}/{len(dones)}")
    for tid in {e["turnId"] for e in starts}:
        a = len([e for e in starts if e["turnId"] == tid])
        b = len([e for e in dones if e["turnId"] == tid])
        hard(f"{tag}: {tid[:12]} 起止配对", a == b, f"task={a} done={b}")


# ---------------------------------------------------------------- stages

def s1_observer_timer(round_no):
    print("\n=== S1 观察循环：定时器自己驱动（不 flush） ===")
    bot = new_bot(f"r{round_no}-obs")
    t0 = time.time()
    post("/api/observations", {"botId": bot, "source": "ci",
                               "text": "构建失败：test_report.md 里有 3 个断言报错需要修复"})
    # Deliberately no flush(). A real low-effort model judge can take tens of
    # seconds under gateway backoff, so allow enough time and MEASURE it.
    found = None
    for _ in range(180):
        time.sleep(0.5)
        items = timeline(bot)
        found = [e for e in items if e["kind"] == "observation"]
        if found:
            break
    obs_ms = (time.time() - t0) * 1000
    LATENCY.append((f"r{round_no} 观察事件→时间线", obs_ms))
    hard(f"r{round_no} S1: 观察循环定时器自驱", bool(found), f"观察节点 {len(found or [])} 耗时 {obs_ms/1000:.1f}s")
    soft(f"r{round_no} S1: 15 秒内注意到", obs_ms <= 15000, f"{obs_ms/1000:.1f}s")
    cards = [e for e in timeline(bot) if e["kind"] == "card" and e.get("cardType") == "observation-offer"]
    soft(f"r{round_no} S1: 摆出观察卡片", bool(cards), len(cards))
    return bot, t0


def s2_nudge_timer(round_no, bot, t0):
    """Reuse S1's bot: its unanswered observation card is a *deterministic*
    hanging item. No reliance on whether the model happens to ask for approval."""
    print("\n=== S2 主动回访：定时器自己开口（不 scan，复用 S1 悬挂卡） ===")
    said = None
    for _ in range(180):
        time.sleep(0.5)
        items = timeline(bot)
        said = [e for e in items if e["kind"] == "assistant/message" and e.get("nudge")]
        if said:
            break
    nudge_ms = (time.time() - t0) * 1000
    LATENCY.append((f"r{round_no} 事件→主动开口", nudge_ms))
    hard(f"r{round_no} S2: 回访定时器自驱", bool(said),
         f"主动消息 {len(said or [])} 端到端 {nudge_ms/1000:.1f}s")
    soft(f"r{round_no} S2: 话术有内容", bool(said and str(said[0].get("text")).strip()),
         said[0].get("text") if said else "")
    return bot


def s3_split_interject(round_no):
    print("\n=== S3 拆分 + 插话（组合） ===")
    bot = new_bot(f"r{round_no}-split")
    a = post(f"/api/bots/{bot}/messages",
             {"text": "读一下 materials/项目现状.md 整理启动命令，并且看看里面三件还没做的事"})
    b = post(f"/api/bots/{bot}/messages", {"text": "插一句：顺便记一下这份材料有多少字"})
    wait_terminal(a["turnId"])
    wait_terminal(b["turnId"])
    items = timeline(bot)
    soft(f"r{round_no} S3: 模型自发拆分", any(e["kind"] == "split" for e in items))
    soft(f"r{round_no} S3: 识别为插话", b.get("interjected") is True)
    hard(f"r{round_no} S3: 插话没有杀掉在跑任务",
         not any(e["kind"] == "interrupt" for e in items))
    hard(f"r{round_no} S3: A/B 都收口",
         get(f"/api/turns/{a['turnId']}")["status"] in ("completed", "failed")
         and get(f"/api/turns/{b['turnId']}")["status"] in ("completed", "failed"))
    invariants(items, f"r{round_no} S3")
    return bot


def s4_restart_recover(round_no, data_dir):
    print("\n=== S4 多任务在飞时重启 + 恢复 ===")
    bot = new_bot(f"r{round_no}-restart")
    a = post(f"/api/bots/{bot}/messages", {"text": "读一下 materials/项目现状.md 的启动命令"})
    c = post(f"/api/bots/{bot}/messages", {"text": "再看看 materials/项目现状.md 的测试命令"})
    time.sleep(1.5)  # both still in flight
    stop_service()
    start_service(data_dir)
    # recover() must have run during startup.
    sa = get(f"/api/turns/{a['turnId']}")
    sc = get(f"/api/turns/{c['turnId']}")
    hard(f"r{round_no} S4: 重启后两轮都不是 running",
         sa["status"] != "running" and sc["status"] != "running",
         f"{sa['status']}/{sc['status']}")
    items = timeline(bot)
    resumes = [e for e in items if e["kind"] == "card" and e.get("cardType") == "resume-offer"]
    soft(f"r{round_no} S4: 出了接着做卡片", bool(resumes), len(resumes))
    # A restart must not auto-resume: status stays interrupted until a human acts.
    hard(f"r{round_no} S4: 不自动续跑",
         sa["status"] == "interrupted" and sc["status"] == "interrupted",
         f"{sa['status']}/{sc['status']}")
    # Check slots BEFORE asking anything to resume: a resumed turn is legitimately
    # in flight, which is not a leak.
    cap = get("/api/capabilities")["concurrency"]
    hard(f"r{round_no} S4: 重启后槽位无泄漏", cap["active"] == 0 and cap["queued"] == 0, cap)
    if resumes:
        card = resumes[0]
        try:
            acted = post(f"/api/cards/{card['cardId']}/act", {"action": "resume"})
            if acted.get("result", {}).get("turnId"):
                wait_terminal(acted["result"]["turnId"])
        except Exception as err:
            soft(f"r{round_no} S4: 接着做可执行", False, str(err)[:80])
    invariants(items, f"r{round_no} S4")
    return bot


def s5_recall_delivery(round_no):
    print("\n=== S5 跨轮召回 + 交付 ===")
    bot = new_bot(f"r{round_no}-deliver")
    a = post(f"/api/bots/{bot}/messages",
             {"text": "读一下 materials/项目现状.md，把启动命令、测试命令、三件还没做的事整理成 现状清单.md 存下来"})
    wait_terminal(a["turnId"])
    for i in range(6):
        r = post(f"/api/bots/{bot}/messages", {"text": f"闲聊 {i}：随便聊点别的"})
        wait_terminal(r["turnId"])
    b = post(f"/api/bots/{bot}/messages",
             {"text": "项目现状.md 那件事接着补：加一节「风险」写两条，原来三件待办要保留，存成 现状清单_v2.md"})
    wait_terminal(b["turnId"])
    items = timeline(bot)
    arts = [e for e in items if e["kind"] == "artifact"]
    soft(f"r{round_no} S5: 生成了两份交付物", len(arts) >= 2, len(arts))
    # HARD = "no malformed deliverable exists"; whether the model chose to
    # produce one at all is a SOFT capability-trigger question.
    hard(f"r{round_no} S5: 交付物回读校验通过",
         all(e.get("integrity") is True for e in arts),
         [e.get("integrity") for e in arts])
    hard(f"r{round_no} S5: 交付物带正文预览",
         all(isinstance(e.get("preview"), list) and e["preview"] for e in arts))
    plan = get(f"/api/turns/{b['turnId']}").get("planArgs") or {}
    soft(f"r{round_no} S5: 接续时带上次正文", len(plan.get("priorDeliverables") or []) >= 1)
    invariants(items, f"r{round_no} S5")
    return bot


def stage(fn, *args):
    """A single slow/failed stage must not abort the whole soak run; record it
    as a HARD failure and keep going so the rest is still measured."""
    label = f"r{args[0]} {fn.__name__}"
    try:
        return fn(*args)
    except Exception as err:
        hard(f"{label}: 阶段未抛异常", False, f"{type(err).__name__}: {str(err)[:120]}")
        return None


def main():
    all_bots = []
    for r in range(1, ROUNDS + 1):
        data_dir = os.path.join(SCRATCH, f"soak_all_r{r}")
        shutil.rmtree(data_dir, ignore_errors=True)
        print(f"\n########## ROUND {r} ##########")
        start_service(data_dir)
        try:
            obs = stage(s1_observer_timer, r)
            if obs:
                all_bots.append(obs[0])
                stage(s2_nudge_timer, r, obs[0], obs[1])
            all_bots.append(stage(s3_split_interject, r))
            all_bots.append(stage(s4_restart_recover, r, data_dir))
            if not alive():
                start_service(data_dir)
            all_bots.append(stage(s5_recall_delivery, r))
            wd = get("/api/watchdog")
            hard(f"r{r} 全局: Watchdog 定时器自驱（脚本从不手动 tick）",
                 wd.get("running") is True and wd.get("ticks", 0) > 0, wd)
            # Observer / nudge status counters reset when S4 restarts the
            # process; their timer evidence is the S1/S2 timeline HARD checks.
            cap = get("/api/capabilities")["concurrency"]
            hard(f"r{r} 全局: 槽位归零", cap["active"] == 0 and cap["queued"] == 0, cap)
        finally:
            stop_service()

    print("\n========== 汇总 ==========")
    hpass = sum(1 for _, ok, _ in HARD if ok)
    spass = sum(1 for _, ok, _ in SOFT if ok)
    print(f"HARD（链路不变量）: {hpass}/{len(HARD)}")
    print(f"SOFT（能力触发率）: {spass}/{len(SOFT)}")
    if LATENCY:
        print("LATENCY（定时器端到端，秒）:")
        for name, ms in LATENCY:
            print(f"  {name}: {ms/1000:.1f}s")
    failed = [(n, e) for n, ok, e in HARD if not ok]
    for n, e in failed:
        print(f"  HARD FAIL: {n}  {e}")
    missed = [(n, e) for n, ok, e in SOFT if not ok]
    for n, e in missed:
        print(f"  SOFT MISS: {n}  {e}")
    print(f"RESULT={'VERIFIED' if not failed else 'BROKEN'}")


if __name__ == "__main__":
    main()
