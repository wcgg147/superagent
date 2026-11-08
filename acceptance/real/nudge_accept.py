"""真模型验收：主动回访（人走开了，它自己回来）。

真实场景：
  1. 交给它一件要跑命令的事 -> 它停下来等你点头；
  2. 人走开了（进程重启）-> 现场保留，出「接着做」卡片；
  3. 它自己回访：一条主动消息 + 一张可点的卡。

判据只看链路结构与话术是否具体，不评生成质量。
"""
import json
import os
import subprocess
import time
import urllib.request

BASE = "http://127.0.0.1:3211"


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.loads(r.read().decode())


def wait_status(turn_id, wanted, timeout=240):
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = get(f"/api/turns/{turn_id}")
        if t["status"] in wanted:
            return t
        time.sleep(0.5)
    raise TimeoutError(f"turn {turn_id} not in {wanted}")


def read_key():
    """Sanitized: the third-party key comes ONLY from the command environment.
    The historical version extracted a key literal from a PI-Desktop session
    log on disk, which conflicts with AGENTS.md section 2 (key only via env,
    never written to disk). Every check(...) assertion here is untouched."""
    return os.environ.get("DSH_TEST_KEY", "").strip() or None



def port_open():
    try:
        with urllib.request.urlopen(BASE + "/api/nudges", timeout=3):
            return True
    except Exception:
        return False


def start_service():
    key = read_key()
    env = {**os.environ, "PORT": "3211",
           "DATA_DIR": os.path.join(os.environ["PI_SCRATCH_DIR"], "nudge_accept"),
           "NUDGE_MIN_AGE_MS": "0", "NUDGE_COOLDOWN_MS": "0"}
    if key:
        env["DEEPSEEK_API_KEY"] = key
        env["DEEPSEEK_BASE_URL"] = "https://api.qnaigc.com/v1"
        env["DEEPSEEK_MODEL"] = "deepseek/deepseek-v4-flash"
    proc = subprocess.Popen(
        ["node", "src/server.mjs"],
        cwd=r"C:\Users\meme\Desktop\deepseek",
        env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if port_open():
            return proc
        time.sleep(0.5)
    return proc


def main():
    if not port_open():
        print("# starting service")
        start_service()
    bot = post("/api/bots", {"name": "回访同学", "job": "常驻同事"})
    bot_id = bot["id"]
    print(f"# bot={bot_id}")

    # 1. Hand it a job, then walk away before it finishes: the process dies
    #    while the turn is still running.
    r = post(f"/api/bots/{bot_id}/messages", {"text": "读一下 README 里的待办，并整理成清单"})
    print(f"# turn={r['turnId']} (left unfinished on purpose)")
    time.sleep(1.5)

    # 2. The human walks away: kill the process, then bring it back.
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "$l = Get-NetTCPConnection -LocalPort 3211 -State Listen -ErrorAction SilentlyContinue; "
                    "if($l){ Stop-Process -Id $l[0].OwningProcess -Force }"], check=False)
    time.sleep(1.5)
    key = read_key()
    env = {**os.environ, "PORT": "3211",
           "DATA_DIR": os.path.join(os.environ["PI_SCRATCH_DIR"], "nudge_accept"),
           "NUDGE_MIN_AGE_MS": "0", "NUDGE_COOLDOWN_MS": "0"}
    if key:
        env["DEEPSEEK_API_KEY"] = key
        env["DEEPSEEK_BASE_URL"] = "https://api.qnaigc.com/v1"
        env["DEEPSEEK_MODEL"] = "deepseek/deepseek-v4-flash"
    subprocess.Popen(
        ["node", "src/server.mjs"],
        cwd=r"C:\Users\meme\Desktop\deepseek",
        env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            get("/api/nudges")
            break
        except Exception:
            time.sleep(0.5)
    print("# service restarted (recover() ran)")
    # 3. It comes back on its own.
    res = post("/api/nudges/scan", {})
    print(f"# scan={res}")

    items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")["items"]
    said = [e for e in items if e["kind"] == "assistant/message" and e.get("nudge")]
    cards = [e for e in items if e["kind"] == "card" and e.get("cardType") == "nudge-offer"]
    resumes = [e for e in items if e["kind"] == "card" and e.get("cardType") == "resume-offer"]

    print("\n--- timeline ---")
    for e in items:
        k = e["kind"]
        extra = ""
        if k == "card":
            extra = f" cardType={e.get('cardType')} actions={[a.get('id') for a in (e.get('actions') or [])]}"
        if k == "assistant/message":
            extra = f" nudge={e.get('nudge')} viaOutbox={e.get('viaOutbox')}"
        txt = str(e.get("text") or e.get("summary") or "")[:80]
        print(f"  {k:<16} {txt}{extra}")

    print("\n--- assertions ---")
    checks = []
    checks.append(("重启后确实留了「接着做」的卡", len(resumes) >= 1))
    checks.append(("主动消息存在", len(said) >= 1))
    checks.append(("主动消息走统一出口", all(s.get("viaOutbox") is True for s in said)))
    checks.append(("主动消息有内容", all(len(str(s.get("text") or "")) > 0 for s in said)))
    checks.append(("话术不过长（≤80 字）", all(len(str(s.get("text") or "")) <= 80 for s in said)))
    checks.append(("出了一张可点的主动卡", len(cards) >= 1))
    checks.append(("主动卡带动作", bool(cards and (cards[0].get("actions") or []))))
    checks.append(("同一次扫描只开口一次", res.get("offered") == len(said)))
    checks.append(("第二次扫描不重复提同一件事",
                   post("/api/nudges/scan", {}).get("offered") == 0))

    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and bool(passed)
    if said:
        print(f"\n  主动话术：{said[0].get('text')}")
    print(f"\nRESULT={'ACCEPTED' if ok else 'REJECTED'}")


if __name__ == "__main__":
    main()
