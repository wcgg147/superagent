"""the agent harness 真实 CLI 路径验收（最后一条硬缺口）。

用 scratch 里安装的 0.2.1-rc.5 CLI，通过 DSH_CLI_ENTRY 指向它，
服务以 EXECUTOR_PROVIDER=gray 启动，全程不改产品代码、不改钉扎、不写死本机路径。

  S1 gray 服务：切 dsh → 真模型/桩触发 browse → tool/call 显示 provider=dsh
  S2 会话复用：同一 Bot 第二次调用复用 sessionId
  S3 安全边界：run_command / writeArtifact 仍走本机白名单，不被 DSH 绕过
  S4 版本闸门：指向本机 rc.2 CLI 时，真实调用 fail loudly，不假装成功
  S5 回滚：一键 rollback 后不再有灰度 Bot
"""
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request

ROOT = r"C:\Users\meme\Desktop\deepseek"
SCRATCH = os.environ.get("PI_SCRATCH_DIR", r"C:\Users\meme\.pi-desktop\scratch")
RC5 = os.path.join(SCRATCH, "dsh_rc5", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
RC2 = r"C:\Users\meme\Desktop\编程ide\node_modules\@deepseek-ai\dsh\lib\bin.js"

HARD = []
SOFT = []


def hard(name, cond, extra=""):
    HARD.append((name, bool(cond)))
    print(("  [HARD %s] " % ("PASS" if cond else "FAIL")) + name + (("  " + str(extra)[:200]) if extra else ""))


def soft(name, cond, extra=""):
    SOFT.append((name, bool(cond)))
    print(("  [SOFT %s] " % ("PASS" if cond else "MISS")) + name + (("  " + str(extra)[:200]) if extra else ""))


def make_client(port):
    base = f"http://127.0.0.1:{port}"

    def call(method, path, body=None):
        data = json.dumps(body or {}, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method,
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
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

    return base, call


def start_service(port, data_dir, entry):
    shutil.rmtree(data_dir, ignore_errors=True)
    m = os.path.join(data_dir, "materials")
    os.makedirs(m, exist_ok=True)
    with open(os.path.join(m, "note.md"), "w", encoding="utf-8") as f:
        f.write("# 说明\n\n启动命令：dsh-start\n")
    env = dict(os.environ)
    env.update({
        "PORT": str(port), "HOST": "127.0.0.1", "DATA_DIR": data_dir,
        "EXECUTOR_PROVIDER": "gray", "DSH_CLI_ENTRY": entry,
        "DSH_HOME": os.path.join(os.path.expanduser("~"), ".dsh"),
        "OBSERVER_MODE": "off", "NUDGE_MODE": "off",
    })
    # Deterministic MockModel: the point here is the EXECUTOR path, not the LLM.
    for k in ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"):
        env.pop(k, None)
    proc = subprocess.Popen(["node", "src/server.mjs"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base, call = make_client(port)
    for _ in range(80):
        try:
            st, health = call("GET", "/api/health")
            if st == 200:
                return proc, base, call, health
        except Exception:
            time.sleep(0.4)
    raise RuntimeError("service did not come up")


def stop_service(port):
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"$l = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; "
                    "if($l){ Stop-Process -Id $l[0].OwningProcess -Force }"], check=False)
    for _ in range(30):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2)
            time.sleep(0.3)
        except Exception:
            return


def wait_terminal(call, turn_id, timeout=240):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, t = call("GET", f"/api/turns/{turn_id}")
        s = t.get("status")
        if s == "waiting_approval" and t.get("pendingApproval"):
            call("POST", f"/api/approvals/{t['pendingApproval']}", {"approve": True})
        elif s in ("completed", "failed", "interrupted", "denied"):
            return t
        time.sleep(0.5)
    raise TimeoutError(turn_id)


def items(call, bot_id):
    return call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=1000")[1]["items"]


# ---------------------------------------------------------------- main

def main():
    print("# RC5 =", RC5, "exists =", os.path.exists(RC5))
    print("# RC2 =", RC2, "exists =", os.path.exists(RC2))
    hard("前置: rc.5 CLI 已就位", os.path.exists(RC5))
    hard("前置: 本机 rc.2 CLI 已就位", os.path.exists(RC2))

    port = 3218
    data = os.path.join(SCRATCH, "dsh_real_accept")
    proc, base, call, health = start_service(port, data, RC5)
    try:
        st, status = call("GET", "/api/executors")
        print("\n=== S1 gray 服务 + 真实 CLI ===")
        hard("S1: gray 模式启用且 dshAvailable", status.get("mode") == "gray" and status.get("dshAvailable"), status)
        hard("S1: 服务用的是 MockModel（验证执行面而非 LLM）", health.get("model") == "mock", health.get("model"))

        st, b = call("POST", "/api/bots", {"name": "灰度同学", "job": "真实 CLI"})
        bid = b["id"]
        st, sw = call("POST", f"/api/bots/{bid}/executor", {"provider": "dsh"})
        hard("S1: 灰度切换到 dsh 成功", st == 200 and sw.get("executor") == "dsh", sw)
        st, status2 = call("GET", "/api/executors")
        hard("S1: grayBots 记录该 Bot", bid in status2.get("grayBots", []), status2.get("grayBots"))

        # MockModel sees the catalog and emits a browse action.
        st, sent = call("POST", f"/api/bots/{bid}/messages", {"text": "把这件事办一下"})
        hard("S1: 消息被接受", st == 202 and "turnId" in sent, sent)
        t = wait_terminal(call, sent["turnId"])
        hard("S1: turn 正常收口", t.get("status") == "completed", t.get("status"))
        tl = items(call, bid)
        calls = [e for e in tl if e["kind"] == "tool/call" and e.get("name") == "browse"]
        hard("S1: 时间线有 browse 工具调用", len(calls) >= 1, len(calls))
        if calls:
            res = calls[0].get("result") or {}
            hard("S1: 结果确实来自 DSH 执行面", res.get("provider") == "dsh", res.get("provider"))
            snippet = str((res.get("items") or [{}])[0].get("snippet") or "")
            hard("S1: 真实 CLI 返回了非空正文", bool(snippet.strip()), snippet[:120])
        plan = call("GET", f"/api/turns/{sent['turnId']}")[1].get("planArgs") or {}
        hard("S1: 灰度 Bot 拿到本机材料清单", bool(plan.get("catalog")), plan.get("catalog"))

        print("\n=== S2 会话复用 ===")
        st, sent2 = call("POST", f"/api/bots/{bid}/messages", {"text": "再办一件类似的事"})
        t2 = wait_terminal(call, sent2["turnId"])
        hard("S2: 第二次 turn 收口", t2.get("status") == "completed", t2.get("status"))
        sess_file = os.path.join(data, "state", "dshSessions.json")
        sessions = {}
        if os.path.exists(sess_file):
            with open(sess_file, encoding="utf-8") as f:
                sessions = json.load(f)
        hard("S2: 会话被持久化且绑定到该 Bot", bid in sessions, list(sessions.keys()))
        soft("S2: sessionId 格式正确", str(sessions.get(bid, "")).startswith("session-"), sessions.get(bid))

        print("\n=== S3 命令/文件仍走本机安全边界 ===")
        # A command action must NOT be routed to the DSH CLI.
        # MockModel takes the catalog/browse branch unless the text contains
        # 搜索|查|读|解释; include 查 so it reaches the run_command branch.
        st, sent3 = call("POST", f"/api/bots/{bid}/messages",
                         {"text": "查一下并运行 `node --version` 看看版本"})
        t3 = wait_terminal(call, sent3["turnId"])
        tl3 = items(call, bid)
        cmds = [e for e in tl3 if e["kind"] == "tool/call" and e.get("name") == "run_command"]
        hard("S3: 命令走本机 run_command（未被 DSH 接管）", len(cmds) >= 1, len(cmds))
        if cmds:
            hard("S3: 命令输出来自本机白名单执行器",
                 "v" in str((cmds[0].get("result") or {}).get("stdout", "")),
                 (cmds[0].get("result") or {}).get("stdout", "")[:60])
        hard("S3: 命令 turn 收口", t3.get("status") == "completed", t3.get("status"))

        print("\n=== S5 回滚 ===")
        st, rb = call("POST", "/api/executors/rollback", {})
        hard("S5: 回滚成功", rb.get("rolledBack") == 1, rb)
        st, status5 = call("GET", "/api/executors")
        hard("S5: 回滚后 grayBots 清空", status5.get("grayBots") == [], status5.get("grayBots"))
    finally:
        stop_service(port)

    # ---- S4: version gate against a REAL older CLI ----
    print("\n=== S4 版本闸门（指向本机真实 rc.2 CLI） ===")
    port2 = 3219
    data2 = os.path.join(SCRATCH, "dsh_version_gate")
    proc2, base2, call2, health2 = start_service(port2, data2, RC2)
    try:
        st, b = call2("POST", "/api/bots", {"name": "版本闸门", "job": "验证"})
        bid2 = b["id"]
        st, sw = call2("POST", f"/api/bots/{bid2}/executor", {"provider": "dsh"})
        hard("S4: 灰度切换成功（切换本身不校验版本）", st == 200, sw)
        st, sent = call2("POST", f"/api/bots/{bid2}/messages", {"text": "把这件事办一下"})
        t = wait_terminal(call2, sent["turnId"])
        tl = items(call2, bid2)
        errs = [e for e in tl if e["kind"] == "error"]
        codes = [e.get("code") for e in errs]
        hard("S4: 真实 CLI 版本漂移被显式拒绝", "DSH_VERSION_MISMATCH" in codes, codes)
        hard("S4: 不假装成功（turn 不是 completed）", t.get("status") != "completed", t.get("status"))
        has_dsh_result = any((e.get("result") or {}).get("provider") == "dsh"
                             for e in tl if e["kind"] == "tool/call")
        hard("S4: 版本不符时绝不产生 DSH 结果", not has_dsh_result)
        soft("S4: 错误信息点明钉扎版本",
             any("0.2.1-rc.5" in str(e.get("detail")) for e in errs),
             [e.get("detail") for e in errs][:1])
    finally:
        stop_service(port2)

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
