"""真模型验收：跨轮实体召回。

场景：
  1. 先让它读 materials/ 里的 package.json，得到一个具体结论（脚本名）；
  2. 中间灌很多无关闲聊（把尾部窗口挤掉）；
  3. 用户只说「package.json 那件事后来怎么样了」——不提内容、只提把手；
  4. 断言：规划输入里带着那次的相关历史，且模型的回答**用到了**那次结论。

判据：链路结构 + 召回事实是否进了规划输入 + 回答是否复述了上次的结论。
不评生成质量。
"""
import json
import re
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


def wait_terminal(turn_id, timeout=240):
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = get(f"/api/turns/{turn_id}")
        if t["status"] in ("completed", "failed", "interrupted", "denied"):
            return t
        if t["status"] == "waiting_approval" and t.get("pendingApproval"):
            post(f"/api/approvals/{t['pendingApproval']}", {"approve": True})
        time.sleep(0.5)
    raise TimeoutError(f"turn {turn_id} not terminal")


def main():
    bot = post("/api/bots", {"name": "召回同学", "job": "常驻同事"})
    bot_id = bot["id"]
    print(f"# bot={bot_id}")

    # 1. A concrete job about a named file.
    r1 = post(f"/api/bots/{bot_id}/messages",
              {"text": "读一下 materials/package.json，告诉我里面声明了哪些 npm scripts"})
    wait_terminal(r1["turnId"])
    first_items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")["items"]
    first_reply = [e for e in first_items
                   if e["kind"] == "assistant/message" and e["turnId"] == r1["turnId"]]
    print(f"# first reply: {(first_reply[0].get('text') or '')[:120] if first_reply else '(none)'}")

    # 2. Push it out of the continuity window with unrelated chatter.
    for i in range(14):
        reply = post(f"/api/bots/{bot_id}/messages", {"text": f"闲聊 {i}：今天星期几"})
        wait_terminal(reply["turnId"])
    print("# chatter pushed the topic out of the tail window")

    # 3. Only the handle, no content.
    r2 = post(f"/api/bots/{bot_id}/messages",
              {"text": "package.json 那件事后来怎么样了"})
    wait_terminal(r2["turnId"])
    print(f"# second turn={r2['turnId']}")

    items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=800")["items"]
    second_reply = [e for e in items
                    if e["kind"] == "assistant/message" and e["turnId"] == r2["turnId"]]
    reply_text = second_reply[0].get("text") if second_reply else ""

    # What did the planner actually receive?
    plan = get(f"/api/turns/{r2['turnId']}")
    plan_args = plan.get("planArgs") or {}
    related = plan_args.get("related") or []

    print("\n--- recall ---")
    print(f"# related 事实 {len(related)} 条")
    for r in related:
        print(f"   - [{r.get('kind')}] {str(r.get('text'))[:90]}")

    print("\n--- second answer ---")
    print(f"# {str(reply_text)[:300]}")

    print("\n--- assertions ---")
    checks = []
    checks.append(("规划输入带回了相关历史", len(related) >= 1))
    checks.append(("相关历史确实谈的是 package.json",
                   any("package.json" in str(r.get("text")) for r in related)))
    checks.append(("相关历史里有那次用户的原话",
                   any(r.get("kind") == "user" and "package.json" in str(r.get("text")) for r in related)))
    checks.append(("相关历史不含闲聊",
                   not any("闲聊" in str(r.get("text")) for r in related)))
    # The decisive one: does the answer reuse what was found earlier?
    names = set()
    for e in first_items:
        if e["kind"] == "tool/call" and e.get("result"):
            for item in (e["result"].get("items") or []):
                names |= set(re.findall(r'"([a-z][a-z0-9:_-]*)"\s*:', str(item.get("snippet") or "")))
    script_names = {n for n in names if n in ("test", "start", "check", "stop")}
    reused = bool(script_names) and any(n in str(reply_text) for n in script_names)
    checks.append(("回答里复述了上次读到的脚本名（真的用上了召回）", reused))
    checks.append(("没有把整篇材料原样贴回来",
                   len(str(reply_text)) < 2000))

    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and bool(passed)
    print(f"\nRESULT={'ACCEPTED' if ok else 'REJECTED'}")


def _last_turn(bot_id):
    items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=800")["items"]
    ids = [e["turnId"] for e in items if e["kind"] == "user/message" and e.get("turnId")]
    return ids[-1]


def _last_turn(bot_id):
    items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=800")["items"]
    ids = [e["turnId"] for e in items if e["kind"] == "user/message" and e.get("turnId")]
    return ids[-1]


if __name__ == "__main__":
    main()
