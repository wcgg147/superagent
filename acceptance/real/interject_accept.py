import json
import time
import urllib.request

BASE = "http://127.0.0.1:3211"


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return json.loads(r.read().decode())


def create_bot():
    return post("/api/bots", {"name": "验收同学", "job": "常驻同事"})


def send(bot_id, text):
    return post(f"/api/bots/{bot_id}/messages", {"text": text})


def transcript(bot_id, cursor=0):
    return get(f"/api/bots/{bot_id}/transcript?cursor={cursor}&limit=500")


def wait_done(bot_id, ids, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        statuses = {i: get(f"/api/turns/{i}")["status"] for i in ids}
        # Human-in-the-loop during interjection: approve any pending command.
        for i in ids:
            t = get(f"/api/turns/{i}")
            if t["status"] == "waiting_approval" and t.get("pendingApproval"):
                post(f"/api/approvals/{t['pendingApproval']}", {"approve": True})
        if all(s in ("completed", "failed", "interrupted", "denied") for s in statuses.values()):
            return statuses
        time.sleep(1.0)
    raise TimeoutError(f"turns not terminal: {ids}")


def main():
    bot = create_bot()
    bot_id = bot["id"]
    print(f"# bot={bot_id}")

    # A 与 B 紧接发送：A 在 coordinator.active 中即被识别为在飞，B 应为插话
    rA = send(bot_id, "先帮我读一下项目里的 README，挑三件还没做的事列出来")
    rB = send(bot_id, "插一句：顺手看看 package.json 里都声明了哪些脚本")
    print(f"# rA interjected={rA.get('interjected')} queued={rA.get('queued')} turn={rA['turnId']}")
    print(f"# rB interjected={rB.get('interjected')} queued={rB.get('queued')} turn={rB['turnId']}")

    statuses = wait_done(bot_id, [rA["turnId"], rB["turnId"]])
    print(f"# statuses={statuses}")

    items = transcript(bot_id, 0)["items"]
    labels = {"user/message": "U", "assistant/message": "A", "interject": "IJ",
              "task": "T", "task/done": "TD", "interrupt": "X", "activity": ".",
              "card": "C", "artifact": "F", "progress": "p", "result": "R"}

    interject_nodes = [e for e in items if e["kind"] == "interject"]
    ack = [e for e in items if e["kind"] == "assistant/message" and e.get("interjection")]
    interrupts = [e for e in items if e["kind"] == "interrupt"]
    u_with_flag = [e for e in items if e["kind"] == "user/message" and e.get("interjection")]

    print("\n--- timeline ---")
    for e in items:
        k = e["kind"]
        tag = labels.get(k, k)
        extra = ""
        if k == "user/message":
            extra = f" interjection={e.get('interjection')}"
        if k == "assistant/message":
            extra = f" interjection={e.get('interjection')} taskLabel={e.get('taskLabel')}"
        if k == "interject":
            extra = f" against={e.get('against')} queued={e.get('queued')}"
        if k in ("task", "task/done"):
            extra = f" label={e.get('taskLabel')} status={e.get('status')}"
        txt = str(e.get("text") or e.get("summary") or "")[:60]
        print(f"  {tag:>3} {txt}{extra}")

    print("\n--- assertions ---")
    checks = []
    checks.append(("B 被识别为插话", rB.get("interjected") is True))
    # 「插话不终止 turn」的精确语义：A 不被插话 interrupt（杀死）。
    # A 自身可能因弱模型生成白名单外命令而 failed（执行面安全拒绝），
    # 这与插话无关——只要 A 不是 interrupted 且仍收口，即说明插话没有杀死 A。
    checks.append(("A 未被插话中断（插话不杀 A）", statuses[rA["turnId"]] != "interrupted"))
    checks.append(("B 完成", statuses[rB["turnId"]] == "completed"))
    checks.append(("时间线有 interject 节点", len(interject_nodes) >= 1))
    checks.append(("有插话确认气泡", len(ack) >= 1))
    checks.append(("B 的用户消息带 interjection 标记", any(e["turnId"] == rB["turnId"] for e in u_with_flag)))
    checks.append(("零中断记录", len(interrupts) == 0))
    checks.append(("A/B 各有配对 task/done",
                   len([e for e in items if e["kind"] == "task/done" and e["turnId"] == rA["turnId"]]) == 1
                   and len([e for e in items if e["kind"] == "task/done" and e["turnId"] == rB["turnId"]]) == 1))
    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    print(f"\nRESULT={'ACCEPTED' if ok else 'REJECTED'}")


if __name__ == "__main__":
    main()
