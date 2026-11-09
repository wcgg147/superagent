"""真模型验收：一条消息里的多件事，agent 自己拆开并行跑。

判据只看链路结构：拆没拆、并行没并行、各支有没有收口、有没有重复执行。
不评生成质量。
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:3211"
TIMEOUT = 240


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return json.loads(r.read().decode())


def wait_terminal(turn_ids, timeout=TIMEOUT):
    deadline = time.time() + timeout
    while time.time() < deadline:
        states = {}
        for tid in turn_ids:
            t = get(f"/api/turns/{tid}")
            states[tid] = t["status"]
            if t["status"] == "waiting_approval" and t.get("pendingApproval"):
                post(f"/api/approvals/{t['pendingApproval']}", {"approve": True})
        if all(s in ("completed", "failed", "interrupted", "denied") for s in states.values()):
            return states
        time.sleep(1.0)
    raise TimeoutError(f"turns not terminal: {turn_ids}")


def main():
    bot = post("/api/bots", {"name": "拆活同学", "job": "并行推进"})
    bot_id = bot["id"]
    print(f"# bot={bot_id}")

    # One message that plainly holds two independent jobs.
    text = "帮我读一下项目里的 README，并且看一下 package.json 里都声明了哪些脚本"
    r = post(f"/api/bots/{bot_id}/messages", {"text": text})
    parent = r["turnId"]
    print(f"# parent turn={parent} interjected={r.get('interjected')}")

    # The parent may spawn children; poll for them, then wait for everything.
    children = []
    deadline = time.time() + TIMEOUT
    while time.time() < deadline:
        p = get(f"/api/turns/{parent}")
        children = p.get("childTurns") or []
        if children:
            break
        if p["status"] in ("completed", "failed", "interrupted", "denied"):
            break
        time.sleep(0.5)

    ids = [parent] + list(children)
    states = wait_terminal(ids)
    print(f"# children={children}")
    print(f"# states={states}")

    items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")["items"]
    split_nodes = [e for e in items if e["kind"] == "split"]
    replies = [e for e in items if e["kind"] == "assistant/message"]
    tasks = [e for e in items if e["kind"] == "task"]
    dones = [e for e in items if e["kind"] == "task/done"]
    errors = [e for e in items if e["kind"] == "error"]

    with open(os.path.join(SCRATCH, "split_timeline.json"),
              "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    print("\n--- timeline ---")
    for e in items:
        k = e["kind"]
        extra = ""
        if k == "task":
            extra = f" label={e.get('taskLabel')} branch={e.get('branch')} parallel={e.get('parallel')}"
        if k == "task/done":
            extra = f" label={e.get('taskLabel')} status={e.get('status')}"
        if k == "split":
            extra = f" count={e.get('count')} labels={e.get('labels')}"
        if k == "assistant/message":
            extra = f" taskLabel={e.get('taskLabel')}"
        txt = str(e.get("text") or e.get("summary") or "")[:70]
        print(f"  {k:<16} {txt}{extra}")

    checks = []
    checks.append(("模型确实把这一条拆成了多件事", len(split_nodes) >= 1))
    if split_nodes:
        checks.append(("拆分支数 ≥ 2", split_nodes[0].get("count", 0) >= 2))
    checks.append(("拆出了子任务", len(children) >= 2))
    checks.append(("父任务正常收口", states.get(parent) == "completed"))
    for cid in children:
        checks.append((f"子任务 {cid[:12]} 收口", states.get(cid) in ("completed", "failed")))
    checks.append(("每个子任务都有 task 与 task/done 配对",
                   all(any(t["turnId"] == c for t in tasks) and any(d["turnId"] == c for d in dones)
                       for c in children)))
    checks.append(("回复仍走统一出口", all(r.get("viaOutbox") is True for r in replies)))
    checks.append(("回复条数与分支数对得上", len(replies) >= len(children)))
    checks.append(("无重复执行：没有同一支跑两次", len(tasks) == len(set(t["turnId"] for t in tasks))))

    print("\n--- assertions ---")
    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and bool(passed)
    if errors:
        print(f"\n  (note) 时间线上有 {len(errors)} 条 error 记录：")
        for e in errors:
            print(f"    - {e.get('code')}: {str(e.get('detail'))[:120]}")
    print(f"\nRESULT={'ACCEPTED' if ok else 'REJECTED'}")


if __name__ == "__main__":
    main()
