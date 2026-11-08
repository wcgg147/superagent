"""量化：真模型在多意图消息上自发拆分的比例。

同一句话跑 N 次，看时间线里是否出现 split 节点。
只统计链路事实（拆没拆），不评生成质量。
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:3211"
N = 5
TEXT = "帮我读一下项目里的 README，并且看一下 package.json 里都声明了哪些脚本"


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return json.loads(r.read().decode())


def wait_terminal(turn_ids, timeout=240):
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
    raise TimeoutError("not terminal")


def main():
    bot = post("/api/bots", {"name": "量化同学", "job": "并行推进"})
    bot_id = bot["id"]
    splits = 0
    rows = []
    for i in range(N):
        r = post(f"/api/bots/{bot_id}/messages", {"text": TEXT})
        parent = r["turnId"]
        children = []
        deadline = time.time() + 240
        while time.time() < deadline:
            p = get(f"/api/turns/{parent}")
            children = p.get("childTurns") or []
            if children or p["status"] in ("completed", "failed", "interrupted", "denied"):
                break
            time.sleep(0.5)
        states = wait_terminal([parent] + list(children))
        items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")["items"]
        split_nodes = [e for e in items if e["kind"] == "split" and e["turnId"] == parent]
        replies = [e for e in items if e["kind"] == "assistant/message" and e["turnId"] in set([parent] + list(children))]
        hollow = [e for e in replies if "稍后" in str(e.get("text")) or "我来" in str(e.get("text"))]
        ok = bool(split_nodes)
        splits += 1 if ok else 0
        rows.append((i + 1, ok, len(children), states.get(parent),
                     len(replies), len(hollow)))
        print(f"  run {i+1}: split={ok} branches={len(children)} parent={states.get(parent)} "
              f"replies={len(replies)} hollow={len(hollow)}")
        time.sleep(2)

    print(f"\n拆分遵守率: {splits}/{N}")
    print("RESULT=" + ("STABLE" if splits == N else ("PARTIAL" if splits > 0 else "NONE")))


if __name__ == "__main__":
    main()
