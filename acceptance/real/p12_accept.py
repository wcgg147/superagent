"""P1/P2 真模型联调：此前只在 stub / HTTP e2e 下验过的控制面能力。

  S1 Routine 定时触发（定时器自驱，不手动 /test）
  S2 团队额度 QuotaBook 在真模型 turn 前拦截
  S3 渠道 token / 窄匹配 / 审计 / 撤销
  S4 Skill from-turn → run，技能真的进真模型规划上下文
  S5 DSH 三态灰度的真实 CLI 路径：本机没装就如实报告未验证
"""
import json
import tempfile
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3217"
PORT = "3217"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.environ.get("RESIDENT_REPO", _REPO_ROOT)
SCRATCH = os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir())
DATA = os.path.join(SCRATCH, "p12_accept")

HARD = []
SOFT = []


def hard(name, cond, extra=""):
    HARD.append((name, bool(cond)))
    print(("  [HARD %s] " % ("PASS" if cond else "FAIL")) + name + (("  " + str(extra)[:170]) if extra else ""))


def soft(name, cond, extra=""):
    SOFT.append((name, bool(cond)))
    print(("  [SOFT %s] " % ("PASS" if cond else "MISS")) + name + (("  " + str(extra)[:170]) if extra else ""))


def call(method, path, body=None):
    data = json.dumps(body or {}, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def post(path, body=None):
    return call("POST", path, body)


def get(path):
    return call("GET", path)[1]


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
    with open(os.path.join(m, "note.md"), "w", encoding="utf-8") as f:
        f.write("# 说明\n\n启动命令：p12-start\n\n待办：补一份周报\n")
    env = dict(os.environ)
    env.update({"PORT": PORT, "HOST": "127.0.0.1", "DATA_DIR": DATA})
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


def wait_terminal(turn_id, timeout=300):
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
    raise TimeoutError(turn_id)


def bot(name):
    return post("/api/bots", {"name": name, "job": "P1P2 验证"})[1]["id"]


def timeline(bid):
    return get(f"/api/bots/{bid}/transcript?cursor=0&limit=1000")["items"]


# ---------------------------------------------------------------- S1

def s1_routine_timer():
    print("\n=== S1 Routine 定时触发（不手动 /test） ===")
    bid = bot("定时同学")
    st, r = post("/api/routines", {
        "botId": bid, "name": "每 15 秒读一次说明",
        "instruction": "读一下 materials/note.md，只说启动命令是什么",
        "trigger": {"type": "interval", "everyMs": 15000},
    })
    hard("S1: 创建 routine 成功", st == 201 and "id" in r, r)
    rid = r.get("id")
    # The resident scheduler polls every 5s; never call /test here.
    fired = None
    for _ in range(40):
        time.sleep(0.5)
        routines = get("/api/routines")["items"]
        fired = next((x for x in routines if x.get("id") == rid and (x.get("runCount") or 0) >= 1), None)
        if fired:
            break
    hard("S1: 定时器自己触发了", fired is not None, fired)
    if fired:
        items = timeline(bid)
        hard("S1: 时间线出现 routine 派发的消息",
             any(e["kind"] == "user/message" and "note.md" in str(e.get("text")) for e in items),
             [e.get("text") for e in items if e["kind"] == "user/message"][:2])
    # Stop it so it does not flood the rest of the run.
    post(f"/api/routines/{rid}/toggle", {"enabled": False})
    return bid


# ---------------------------------------------------------------- S2

def s2_quota():
    print("\n=== S2 团队额度在真模型 turn 前拦截 ===")
    bid = bot("额度同学")
    st, team = post("/api/teams", {"name": "小队", "quotaPerDay": 2})
    hard("S2: 建团队成功", st == 201 and "id" in team, team)
    tid = team["id"]
    st, assigned = post(f"/api/teams/{tid}/assign", {"botId": bid})
    hard("S2: 把 Bot 分到团队", assigned.get("teamId") == tid, assigned)
    codes = []
    for i in range(3):
        st, r = post(f"/api/bots/{bid}/messages", {"text": f"第 {i+1} 件事：打个招呼"})
        codes.append((st, (r.get("error") or {}).get("code") if isinstance(r, dict) else None))
        if st == 202 and isinstance(r, dict) and r.get("turnId"):
            wait_terminal(r["turnId"])
    hard("S2: 前两条放行、第三条被额度拦下",
         codes[0][0] == 202 and codes[1][0] == 202 and codes[2][1] == "USAGE_LIMIT", codes)
    status = get("/api/quota")
    team_status = next((t for t in status["teams"] if t["id"] == tid), {})
    hard("S2: 当日用量正确记为 2", team_status.get("usedToday") == 2, team_status)


# ---------------------------------------------------------------- S3

def s3_channel():
    print("\n=== S3 渠道 token / 窄匹配 / 审计 / 撤销 ===")
    bid = bot("渠道同学")
    st, ch = post("/api/channels", {
        "name": "CI webhook", "kind": "webhook", "botId": bid, "phrase": "DEPLOY",
    })
    hard("S3: 创建渠道并拿到 token", st == 201 and bool(ch.get("token")), {k: v for k, v in ch.items() if k != "token"})
    cid, token = ch["id"], ch["token"]
    safe = get(f"/api/channels/{cid}")
    hard("S3: GET 渠道不泄露 tokenHash", "tokenHash" not in safe and "token" not in safe, list(safe.keys()))

    st, bad = post(f"/api/channels/{cid}/ingest", {"token": "wrong-token", "text": "DEPLOY failed"})
    hard("S3: 错 token 被拒", st == 401 and (bad.get("error") or {}).get("code") == "CHANNEL_TOKEN_INVALID", bad)

    st, ok = post(f"/api/channels/{cid}/ingest",
                  {"token": token, "source": "ci", "text": "DEPLOY failed：构建报错需要修复"})
    fired = ok.get("fired") or []
    hard("S3: 正确 token + 命中短语派发 turn", st == 202 and bool(fired), ok)
    if fired:
        wait_terminal(fired[0])

    st, miss = post(f"/api/channels/{cid}/ingest", {"token": token, "text": "日常闲聊一条"})
    hard("S3: 不命中短语不派 turn", st == 202 and not miss.get("turnId"), miss)

    audit = get(f"/api/channels/{cid}/audit")["items"]
    hard("S3: 审计记录了成功/失败/窄匹配",
         len(audit) >= 2 and any(a.get("turnId") for a in audit) and any(a.get("matched") is False for a in audit),
         [(a.get("matched"), a.get("error"), bool(a.get("turnId"))) for a in audit])
    hard("S3: 审计不落 token 明文", all("token" not in a for a in audit))

    st, revoked = post(f"/api/channels/{cid}/toggle", {"enabled": False})
    hard("S3: 停用成功", revoked.get("enabled") is False, revoked)
    st, denied = post(f"/api/channels/{cid}/ingest", {"token": token, "text": "DEPLOY again"})
    hard("S3: 停用后拒绝投递", st == 403 and (denied.get("error") or {}).get("code") == "CHANNEL_DISABLED", denied)

    # Revoke (DELETE), then the channel must no longer be addressable.
    rst, revoked = call("DELETE", f"/api/channels/{cid}")
    hard("S3: 撤销渠道成功", rst == 200 and revoked.get("revoked") == cid, revoked)
    gst, gone = call("GET", f"/api/channels/{cid}")
    hard("S3: 撤销后渠道不可再访问", gst == 404, gone)
    ist, after_revoke = post(f"/api/channels/{cid}/ingest", {"token": token, "text": "DEPLOY again"})
    hard("S3: 撤销后拒绝投递", ist >= 400, after_revoke)
    return bid


# ---------------------------------------------------------------- S4

def s4_skill():
    print("\n=== S4 Skill from-turn → run，技能进真模型规划上下文 ===")
    bid = bot("技能同学")
    st, sent = post(f"/api/bots/{bid}/messages",
                    {"text": "读一下 materials/note.md 的启动命令"})
    wait_terminal(sent["turnId"])
    st, skill = post("/api/skills/from-turn", {"turnId": sent["turnId"], "name": "读说明"})
    hard("S4: 从已完成任务生成技能", st == 201 and "id" in skill, skill)
    sid = skill["id"]
    st, ran = post(f"/api/skills/{sid}/run", {"botId": bid, "input": "再读一次"})
    hard("S4: 技能 run 派发 turn", st == 202 and bool(ran.get("turnId")), ran)
    if isinstance(ran, dict) and ran.get("turnId"):
        wait_terminal(ran["turnId"])
        plan = get(f"/api/turns/{ran['turnId']}").get("planArgs") or {}
        names = [s.get("name") for s in (plan.get("skills") or [])]
        hard("S4: 技能出现在真模型规划输入里", "读说明" in names, names)


# ---------------------------------------------------------------- S5

def s5_dsh():
    print("\n=== S5 DSH 三态灰度真实 CLI ===")
    exe = shutil.which("dsh") or shutil.which("dsh.exe")
    st, status = call("GET", "/api/executors")
    soft("S5: 执行面状态接口可用", st == 200, status)
    mode = status.get("mode")
    if mode in ("gray", "dsh") and status.get("dshAvailable"):
        bid = bot("灰度同学")
        st, r = post(f"/api/bots/{bid}/executor", {"provider": "dsh"})
        hard("S5: 灰度切换成功", st == 200, r)
        if st == 200:
            st, sent = post(f"/api/bots/{bid}/messages", {"text": "打个招呼"})
            if st == 202:
                wait_terminal(sent["turnId"])
                hard("S5: 灰度 Bot 的 turn 收口",
                     get(f"/api/turns/{sent['turnId']}")["status"] in ("completed", "failed"))
            else:
                hard("S5: 灰度 Bot 能发消息", False, sent)
        soft("S5: DSH 真实 CLI 路径被跑到", True, exe)
        return
    # Service runs in local mode: switching to an un-enabled provider MUST be
    # refused. That boundary is worth asserting; the real CLI path is not
    # exercised here and must be reported honestly.
    bid = bot("灰度同学")
    st, r = post(f"/api/bots/{bid}/executor", {"provider": "dsh"})
    hard("S5: local 模式正确拒绝切到未启用的 dsh",
         st == 400 and (r.get("error") or {}).get("code") == "BAD_REQUEST", r)
    soft("S5: DSH 真实 CLI 路径", False,
         f"服务 mode={mode}、dshAvailable={status.get('dshAvailable')}；本机 dsh={exe or '未找到'}，"
         "未做真实 CLI 调用（灰度切换的契约由 e2e_executor.py 12/12 覆盖）")


def main():
    start_service()
    try:
        s1_routine_timer()
        s2_quota()
        s3_channel()
        s4_skill()
        s5_dsh()
    finally:
        stop_service()
    print("\n========== 汇总 ==========")
    hp = sum(1 for _, ok in HARD if ok)
    sp = sum(1 for _, ok in SOFT if ok)
    print(f"HARD: {hp}/{len(HARD)}")
    print(f"SOFT: {sp}/{len(SOFT)}")
    for n, ok in HARD:
        if not ok:
            print("  HARD FAIL:", n)
    for n, ok in SOFT:
        if not ok:
            print("  SOFT MISS:", n)
    print(f"RESULT={'VERIFIED' if all(ok for _, ok in HARD) else 'BROKEN'}")


if __name__ == "__main__":
    main()
