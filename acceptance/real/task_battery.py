"""Real-task battery: drive the product the way a person actually would,
then dump the timeline a user would SEE (not just assert fields exist).

Scenes are intentionally continuous: several real chores in a row on one Bot,
an event stream, and several things delegated at once. The point is to surface
irritation that isolated assertions cannot see.
"""
import http.server, json, os, shutil, socketserver, subprocess, sys, threading, time
import urllib.error, urllib.request

WORKSPACE = r"C:\Users\meme\Desktop\deepseek"
SCRATCH = os.environ.get("PI_SCRATCH_DIR", r"C:\Users\meme\.pi-desktop\scratch")
DATA = os.path.join(SCRATCH, "p0a-battery")
REPORT = os.path.join(SCRATCH, "battery_report.txt")
shutil.rmtree(DATA, ignore_errors=True)
os.makedirs(DATA, exist_ok=True)
MATERIALS = os.path.join(DATA, "materials")
os.makedirs(MATERIALS, exist_ok=True)
with open(os.path.join(MATERIALS, "release-notes.md"), "w", encoding="utf-8") as f:
    f.write("# 发布说明\n\nDeepSeek V4 Flash 支持结构化 actions，检索到这条本机资料。\n")

PORT, STUB_PORT = 3112, 3113
ROOT = f"http://127.0.0.1:{PORT}"

JUDGE = json.dumps({"worthwhile": True, "reason": "疑似缺陷/待办"}, ensure_ascii=False)


def actions_for(text):
    t = text or ""
    if any(k in t for k in ("执行", "命令", "node --version")):
        return [
            {"kind": "activity", "summary": "准备在本机执行一条命令"},
            {"kind": "run_command", "command": "node --version", "summary": "确认本机 Node 版本",
             "detail": "node --version", "requiresApproval": True},
            {"kind": "reply", "text": "命令跑完了，结果在上面。"},
        ]
    if any(k in t for k in ("查", "搜索", "资料", "检索")):
        return [
            {"kind": "activity", "summary": "正在检索资料"},
            {"kind": "browse", "query": t, "summary": "查资料"},
            {"kind": "write_artifact", "filename": "资料整理.md", "content": "# 资料整理\n\n检索结果摘要。", "summary": "正在整理成文档"},
            {"kind": "reply", "text": "资料整理好了，文档在下面。"},
        ]
    if "待办" in t or "导出" in t:
        return [
            {"kind": "activity", "summary": "正在汇总待办"},
            {"kind": "write_artifact", "filename": "待办清单.md", "content": "# 待办清单\n\n- 待办项", "summary": "正在导出清单"},
            {"kind": "reply", "text": "待办清单导好了，文件在下面。"},
        ]
    if any(k in t for k in ("写一份", "周报", "文档", "生成")):
        return [
            {"kind": "activity", "summary": "正在理解这件事"},
            {"kind": "write_artifact", "filename": "周报.md", "content": "# 周报\n\n本周完成事项。", "summary": "正在起草交付物"},
            {"kind": "reply", "text": "周报写好了，文档在下面。"},
        ]
    return [{"kind": "activity", "summary": "正在处理这件事"}, {"kind": "reply", "text": "这件事办好了。"}]


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try:
            body = json.loads(raw)
            system = body.get("messages", [{}])[0].get("content", "")
            user = body.get("messages", [{}, {}])[1].get("content", "{}")
            try:
                text = json.loads(user).get("text", "")
            except Exception:
                text = user
        except Exception:
            system, text = "", ""
        time.sleep(0.35)  # keeps turns alive long enough for real concurrency
        content = JUDGE if "观察哨" in system else json.dumps({"actions": actions_for(text)}, ensure_ascii=False)
        payload = json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def log_message(self, *args):
        pass


class ThreadedStub(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


stub = ThreadedStub(("127.0.0.1", STUB_PORT), Stub)
threading.Thread(target=stub.serve_forever, daemon=True).start()

env = dict(os.environ, PORT=str(PORT), HOST="127.0.0.1", DATA_DIR=DATA,
           MAX_CONCURRENT_TURNS="2",
           DEEPSEEK_API_KEY="E2E_LOCAL_ONLY_NOT_A_SECRET",
           DEEPSEEK_BASE_URL=f"http://127.0.0.1:{STUB_PORT}/v1",
           DEEPSEEK_MODEL="e2e-mock", DEEPSEEK_REASONING_EFFORT="low")
for var in ("EXECUTOR_PROVIDER", "OBSERVER_MODE", "WATCHDOG_INTERVAL_MS"):
    env.pop(var, None)


def call(method, path, body=None):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(ROOT + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except Exception:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def transcript(bot_id):
    st, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=500")
    return tr.get("items", []) if isinstance(tr, dict) else []


def wait_turn(tid, timeout=12):
    deadline = time.time() + timeout
    status = ""
    while time.time() < deadline:
        status = call("GET", f"/api/turns/{tid}")[1].get("status")
        if status in ("completed", "failed", "denied", "interrupted"):
            return status
        time.sleep(0.08)
    return status


def approve_pending(bot_id):
    items = transcript(bot_id)
    resolved = {e.get("cardId") for e in items if e.get("kind") == "card/resolved"}
    for c in items:
        if c.get("kind") == "card" and c.get("cardType") == "approval" and c.get("approvalId") not in resolved:
            call("POST", f"/api/approvals/{c['approvalId']}", {"approve": True})


HIDDEN = {"tool/call", "result", "approval", "system", "card/resolved", "progress"}
DONE_LABEL = {"completed": "完成", "interrupted": "已停止", "denied": "已拒绝", "failed": "失败"}


def visible_lines(items):
    """Approximate what the UI shows (single-task task rows are collapsed)."""
    parallel = any(e.get("kind") == "task" and (e.get("parallel") or 1) > 1 for e in items)
    active = 0
    batch_seen = False
    out = []
    for e in items:
        kind = e.get("kind")
        if kind == "task":
            active += 1
            if active > 1:
                batch_seen = True
        if kind == "task/done":
            active = max(0, active - 1)
        if kind in HIDDEN:
            continue
        if kind in ("task", "task/done") and not (parallel or batch_seen):
            continue
        if kind == "card":
            text = f"[卡片] {e.get('title')} — {e.get('summary')} | 动作: {','.join(a.get('label', '') for a in e.get('actions', []))}"
        elif kind == "assistant/message":
            label = f"[{e.get('taskLabel')}] " if e.get("taskLabel") else ""
            text = f"[它] {label}{e.get('text')}"
        elif kind == "user/message":
            text = f"[我] {e.get('text')}"
        elif kind == "artifact":
            text = f"[附件] {e.get('filename')}"
        elif kind == "activity":
            text = f"[进度] {e.get('summary')}" + (f" · {e.get('detail')}" if e.get("detail") else "")
        elif kind == "thread/event":
            text = f"[线索] 第{e.get('count')}条 {'续' if e.get('coalesced') else '新'}: {e.get('text')}"
        elif kind == "observation":
            text = f"[观察] {e.get('summary')} · {e.get('detail') or ''}"
        elif kind == "watchdog":
            text = f"[看门狗] {e.get('summary')}"
        elif kind == "interrupt":
            text = f"[中断] {e.get('summary')}"
        elif kind == "task":
            text = f"[任务] {e.get('taskLabel')} 开始"
        elif kind == "task/done":
            text = f"[任务] {e.get('taskLabel')} {DONE_LABEL.get(e.get('status'), e.get('status'))}"
        elif kind == "resume":
            text = f"[恢复] {e.get('summary')}"
        else:
            text = f"[{kind}] {e.get('summary') or e.get('text') or ''}"
        out.append(text.replace("\n", " ").strip()[:140])
    return out


scenes = []


def scene(name, bot_id, note=""):
    items = transcript(bot_id)
    lines = visible_lines(items)
    cards = [e for e in items if e.get("kind") == "card"]
    followups = [e for e in cards if e.get("cardType") == "followup-offer"]
    scenes.append({"name": name, "note": note, "lines": lines,
                   "cards": len(cards), "followups": len(followups), "total": len(items)})


proc = None
try:
    proc = subprocess.Popen(["node", "src/server.mjs"], cwd=WORKSPACE, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    for _ in range(60):
        try:
            if call("GET", "/api/health")[1].get("ok"):
                break
        except Exception:
            time.sleep(0.25)

    # Scene 1: three real chores back to back on ONE Bot (the common daily use).
    st, b1 = call("POST", "/api/bots", {"name": "日常", "job": "帮我处理日常事务"})
    bot1 = b1["id"]
    for text in ("帮我写一份周报", "查一下 DeepSeek 的资料并整理成文档", "执行 `node --version` 看看版本"):
        r = call("POST", f"/api/bots/{bot1}/messages", {"text": text})[1]
        tid = r.get("turnId")
        for _ in range(40):
            if wait_turn(tid, 0.4) in ("completed", "failed", "denied"):
                break
            approve_pending(bot1)
        time.sleep(0.15)
    scene("① 连续做三件真事（写周报 → 查资料整理 → 跑命令）", bot1,
          "看连续使用时卡片/淡行会不会累积成打扰")

    # Scene 2: an event stream — observations + a chained issue thread.
    st, b2 = call("POST", "/api/bots", {"name": "盯 CI", "job": "盯着仓库"})
    bot2 = b2["id"]
    for text in ("#12 CI 报错 needs repro", "构建失败，请复现"):
        call("POST", "/api/observations", {"botId": bot2, "source": "github", "text": text})
    call("POST", "/api/observations/flush", {})
    time.sleep(0.3)
    for text in ("issue #12 有新评论", "维护者贴了日志", "复现步骤补齐"):
        call("POST", "/api/threads/ingest",
             {"botId": bot2, "source": "github", "entity": "issue/12", "text": text})
    scene("② 事件流（2 条观察 + 3 条同线索事件）", bot2,
          "看淡行/卡片密度，以及是否自动派了 turn")

    # Scene 3: delegate several things at once, stop one, resume it.
    st, b3 = call("POST", "/api/bots", {"name": "并行", "job": "同时推进"})
    bot3 = b3["id"]
    sent = []
    for text in ("整理会议纪要", "查一下发布说明", "把待办清单导出来"):
        sent.append(call("POST", f"/api/bots/{bot3}/messages", {"text": text})[1])
    time.sleep(0.12)
    mid = sent[1].get("turnId")
    call("POST", f"/api/turns/{mid}/interrupt", {})
    time.sleep(0.5)
    for s in sent:
        wait_turn(s["turnId"])
    call("POST", f"/api/turns/{mid}/resume", {})
    wait_turn(mid)
    scene("③ 同时交代三件 + 停掉中间一件 + 接着做", bot3,
          "看并行标注、停止/恢复是否看得懂")

finally:
    if proc and proc.poll() is None:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    stub.shutdown()
    stub.server_close()

with open(REPORT, "w", encoding="utf-8") as f:
    f.write("真实任务剧本 · 用户可见时间线\n")
    f.write("=" * 78 + "\n\n")
    for s in scenes:
        f.write(f"## {s['name']}\n")
        f.write(f"意图: {s['note']}\n")
        f.write(f"统计: transcript {s['total']} 条 / 用户可见 {len(s['lines'])} 行 / 卡片 {s['cards']} 张（其中 followup {s['followups']} 张）\n")
        f.write("-" * 78 + "\n")
        for i, line in enumerate(s["lines"], 1):
            f.write(f"{i:>2}. {line}\n")
        f.write("\n")
print(f"report -> {REPORT}")
for s in scenes:
    print(f"{s['name']}: visible={len(s['lines'])} cards={s['cards']} followups={s['followups']} total={s['total']}")

# Lightweight invariants so a future run catches regressions in "feel",
# not just in API shape.
followups = [s["followups"] for s in scenes]
assert max(followups) <= 1, f"followup card stacking is back: {followups}"
assert any("已停止「任务" in line for s in scenes for line in s["lines"]), \
    "interrupt must say which task was stopped"
assert any("[观察] github" in line for s in scenes for line in s["lines"]), \
    "observation line must carry the actual signal"
assert not any(line.startswith("[我]") for line in scenes[1]["lines"]), \
    "event stream must not auto-delegate turns"
print("battery invariants OK")
