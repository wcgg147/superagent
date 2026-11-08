"""「验交付」：判据看交付物内容对不对，不看链路结构。

三个剧本：
  A 小文件整理  —— 材料不截断，看它能不能交出一份合格的清单
  B 大文件整理  —— 待办埋在 800 字符之后，看材料截断会不会让它交不出
  C 跨会话接续  —— 隔一堆闲聊后说「上次那份清单接着补」，看它能不能接上内容

不评生成质量（文采/格式），只判事实齐不齐、有没有编造、有没有把原文当交付物。
"""
import json
import re
import time
import urllib.request

BASE = "http://127.0.0.1:3211"
TIMEOUT = 300


def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.loads(r.read().decode())


def get_text(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return r.read().decode("utf-8", errors="replace")


def wait_terminal(bot_id, turn_id, timeout=TIMEOUT):
    """Wait for a real terminal state; a transient plan failure leaves the
    turn paused (status interrupted), so resume it instead of giving up."""
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


def ask(bot_id, text):
    r = post(f"/api/bots/{bot_id}/messages", {"text": text})
    turn = wait_terminal(bot_id, r["turnId"])
    items = get(f"/api/bots/{bot_id}/transcript?cursor=0&limit=1000")["items"]
    return turn, [e for e in items if e.get("turnId") == r["turnId"]], items


def deliverables(entries):
    out = []
    for e in entries:
        if e["kind"] == "artifact" and e.get("artifactId"):
            try:
                out.append({"filename": e.get("filename"),
                            "id": e["artifactId"],
                            "text": get_text(f"/api/artifacts/{e['artifactId']}")})
            except Exception as err:
                out.append({"filename": e.get("filename"), "id": e["artifactId"], "text": f"<读取失败 {err}>"})
    return out


def browse_facts(entries):
    out = []
    for e in entries:
        if e["kind"] == "tool/call" and e.get("name") == "browse":
            for it in (e.get("result") or {}).get("items") or []:
                out.append({"title": it.get("title"), "bytes": it.get("bytes"),
                            "shown": it.get("shown"), "truncated": it.get("truncated", False),
                            "snippet_head": str(it.get("snippet") or "")[:60]})
    return out


TODO_WORDS = ["渠道", "周报", "向量"]
BAD_MARKERS = ["系统兜底", "没能整理成答案", "以下是本机读到的原文", "没有读到可用材料", "没有生成内容"]


def judge_doc(text, label):
    checks = []
    checks.append(("交付物非空且不是占位", bool(text.strip()) and len(text.strip()) > 40))
    checks.append(("含启动命令", bool(re.search(r"npm\s+start|node\s+src/server\.mjs", text))))
    checks.append(("含测试命令", bool(re.search(r"npm\s+test", text))))
    for w in TODO_WORDS:
        checks.append((f"含待办「{w}」", w in text))
    checks.append(("没有把原文兜底当交付", not any(m in text for m in BAD_MARKERS)))
    checks.append(("不是整篇材料原样贴回", len(text) < 6000))
    ok = True
    print(f"\n--- {label} 判据 ---")
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and bool(passed)
    return ok


def main():
    bot = post("/api/bots", {"name": "交付同学", "job": "把活做完"})
    bot_id = bot["id"]
    print(f"# bot={bot_id}")
    overall = []

    # ---------------- A: small, unclipped material
    print("\n=== A 小文件整理 ===")
    t, entries, _ = ask(bot_id,
                        "读一下 materials/项目现状.md，把启动命令、测试命令、三件还没做的事整理成一份 现状清单.md 存下来")
    docs = deliverables(entries)
    print(f"# turn={t['id']} status={t['status']} artifacts={len(docs)}")
    print(f"# browse={browse_facts(entries)}")
    if docs:
        print(f"# 交付物正文（前 500 字）：\n{docs[-1]['text'][:500]}")
        overall.append(("A", judge_doc(docs[-1]["text"], "A 现状清单.md")))
    else:
        print("# 没有生成交付物")
        overall.append(("A", False))

    # ---------------- B: long file, the todo list is past the 800-char window
    print("\n=== B 大文件整理（待办在 800 字符之后） ===")
    t, entries, _ = ask(bot_id,
                        "读一下 materials/项目现状_长.md，把启动命令、测试命令、三件还没做的事整理成一份 现状清单_长.md 存下来")
    docs = deliverables(entries)
    print(f"# turn={t['id']} status={t['status']} artifacts={len(docs)}")
    print(f"# browse={browse_facts(entries)}")
    if docs:
        print(f"# 交付物正文（前 500 字）：\n{docs[-1]['text'][:500]}")
        overall.append(("B", judge_doc(docs[-1]["text"], "B 现状清单_长.md")))
    else:
        print("# 没有生成交付物")
        overall.append(("B", False))

    # ---------------- C: continue a prior deliverable across chatter
    print("\n=== C 跨会话接续 ===")
    for i in range(8):
        r = post(f"/api/bots/{bot_id}/messages", {"text": f"闲聊 {i}：随便说点别的"})
        wait_terminal(bot_id, r["turnId"])
    t, entries, _ = ask(bot_id,
                        "上次那份 现状清单.md 接着补：再加一节「风险」，写两条；原来那三件还没做的事要保留，存成 现状清单_v2.md")
    docs = deliverables(entries)
    print(f"# turn={t['id']} status={t['status']} artifacts={len(docs)}")
    if docs:
        text = docs[-1]["text"]
        print(f"# 交付物正文（前 600 字）：\n{text[:600]}")
        checks = [
            ("交付物非空", bool(text.strip()) and len(text.strip()) > 40),
            ("保留了原来的三件待办", all(w in text for w in TODO_WORDS)),
            ("新增了风险一节", "风险" in text),
            ("没有把原文兜底当交付", not any(m in text for m in BAD_MARKERS)),
        ]
        ok = True
        print("\n--- C 判据 ---")
        for name, passed in checks:
            print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
            ok = ok and bool(passed)
        overall.append(("C", ok))
    else:
        print("# 没有生成交付物")
        overall.append(("C", False))

    print("\n=== 汇总 ===")
    for label, ok in overall:
        print(f"  {label}: {'ACCEPTED' if ok else 'REJECTED'}")
    print(f"RESULT={'ACCEPTED' if all(ok for _, ok in overall) else 'REJECTED'}")


if __name__ == "__main__":
    main()
