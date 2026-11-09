"""Capability probe: enumerate work DeepSeek / the agent harness are actually
good at (text, code, reasoning, structured data) and drive EACH one through the
product to see whether our chain can carry it -- not to grade the model's IQ.

Output: a matrix of ok / partial / blocked plus the concrete missing capability.
"""
import http.server, json, os, re, shutil, socketserver, subprocess, sys, threading, time
import os
import tempfile
import urllib.error, urllib.request

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.environ.get("RESIDENT_REPO", _REPO_ROOT)
SCRATCH = os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir())
DATA = os.path.join(SCRATCH, "p0a-probe")
MATRIX = os.path.join(SCRATCH, "capability_matrix.txt")
shutil.rmtree(DATA, ignore_errors=True)
MATERIALS = os.path.join(DATA, "materials")
os.makedirs(MATERIALS, exist_ok=True)

with open(os.path.join(MATERIALS, "sort.js"), "w", encoding="utf-8") as f:
    f.write("function sortItems(items) {\n  return items.sort((a, b) => a.score - b.score)\n}\nmodule.exports = { sortItems }\n")
with open(os.path.join(MATERIALS, "access.log"), "w", encoding="utf-8") as f:
    f.write("GET /a 200\nGET /b 500\nPOST /c 500\nGET /d 200\nGET /e 500\n")
with open(os.path.join(MATERIALS, "notes.md"), "w", encoding="utf-8") as f:
    f.write("# 技术说明\n\nDeepSeek 的推理档位通过旁路字段传递，不进入 messages，因此不影响前缀缓存命中率。\n")

PORT, STUB_PORT = 3114, 3115
ROOT = f"http://127.0.0.1:{PORT}"

# id, category, what a user would actually say, what "done" means
TASKS = [
    ("A1", "文字", "把这段技术说明译成英文，术语保持一致", "reply"),
    ("A2", "文字", "把 notes.md 压成 5 条要点", "reply+material"),
    ("A3", "文字", "把这段口语改成严谨书面语", "reply"),
    ("A4", "文字", "从这段说明里抽出术语表", "reply"),
    ("B1", "编程", "解释一下 sort.js 在做什么", "material+reply"),
    ("B2", "编程", "给 sort.js 写单元测试并跑起来", "artifact+run"),
    ("B3", "编程", "node sort.js 报 TypeError，帮我定位原因", "material+reply"),
    ("B4", "编程", "写个 Node 脚本统计 access.log 里 500 的次数并运行", "artifact+run"),
    ("B5", "编程", "审查 sort.js 有什么问题", "material+reply"),
    ("C1", "推理", "一个水池两根管子，给出解题过程", "reply"),
    ("C2", "推理", "三个约束下推断谁拿了钥匙，写清推理步骤", "reply"),
    ("D1", "结构化", "把这段日志解析成 JSON", "reply"),
    ("D2", "结构化", "统计 access.log 里 500 出现了几次", "material+reply"),
    ("D3", "结构化", "判断这条反馈是投诉还是建议", "reply"),
]


def actions_for(tag, text):
    pure = ("A1", "A3", "A4", "C1", "C2", "D1", "D3")
    read = ("A2", "B1", "B3", "B5", "D2")
    build = ("B2", "B4")
    if tag in pure:
        return [{"kind": "activity", "summary": "正在处理这个任务"},
                {"kind": "reply", "text": f"已完成「{text[:20]}」：结果如下。"}]
    if tag in read:
        return [{"kind": "activity", "summary": "正在读取本机材料"},
                {"kind": "browse", "query": text, "summary": "读取材料"},
                {"kind": "reply", "text": "基于读到的材料，结论如下。"}]
    if tag in build:
        # model gives no artifact content: it expects the chain to carry the
        # retrieved material into the deliverable. Then it runs a command.
        return [{"kind": "activity", "summary": "正在读取本机材料"},
                {"kind": "browse", "query": text, "summary": "读取材料"},
                {"kind": "write_artifact", "filename": f"{tag}-result.js", "summary": "生成可运行脚本"},
                {"kind": "run_command", "command": "node @last",
                 "summary": "执行刚生成的交付物", "requiresApproval": False},
                {"kind": "reply", "text": "脚本生成并跑过了。"}]
    return [{"kind": "reply", "text": "完成。"}]


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        try:
            body = json.loads(raw)
            msgs = body.get("messages", [{}, {}])
            system = msgs[0].get("content", "")
            user = msgs[1].get("content", "{}")
            text = json.loads(user).get("text", "")
        except Exception:
            system, text = "", ""
        m = re.match(r"\[TASK:([A-Z]\d+)\]", text)
        tag = m.group(1) if m else "A1"
        if "交付物撰写器" in system:
            # Second pass: the model writes a runnable deliverable from the
            # real material the chain handed back. Tag identifies the task.
            script = f"console.log('ARTIFACT_RAN {tag}')\n"
            content = json.dumps({"content": script}, ensure_ascii=False)
        else:
            content = json.dumps({"actions": actions_for(tag, text)}, ensure_ascii=False)
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
           MAX_CONCURRENT_TURNS="3",
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


def wait_turn(tid, timeout=12):
    end = time.time() + timeout
    while time.time() < end:
        s = call("GET", f"/api/turns/{tid}")[1].get("status")
        if s in ("completed", "failed", "denied", "interrupted"):
            return s
        time.sleep(0.07)
    return "timeout"


def artifact_text(art_id):
    st, body = call("GET", f"/api/artifacts/{art_id}")
    return body if isinstance(body, str) else ""


rows = []
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

    st, bot = call("POST", "/api/bots", {"name": "能力探针", "job": "逐个试真实工作"})
    bot_id = bot["id"]

    for tag, category, text, expect in TASKS:
        payload = f"[TASK:{tag}] {text}"
        r = call("POST", f"/api/bots/{bot_id}/messages", {"text": payload})[1]
        tid = r.get("turnId")
        state = wait_turn(tid)
        tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=1000")[1].get("items", [])
        mine = [e for e in tr if e.get("turnId") == tid]
        replies = [e for e in mine if e.get("kind") == "assistant/message"]
        calls = [e for e in mine if e.get("kind") == "tool/call"]
        arts = [e for e in mine if e.get("kind") == "artifact"]
        browse_hits = 0
        for c in calls:
            if c.get("name") == "browse":
                browse_hits = len((c.get("result") or {}).get("items") or [])
        art_content = artifact_text(arts[0].get("artifactId")) if arts else ""
        has_real = any(k in art_content for k in ("sortItems", "500", "DeepSeek", "materials"))
        composed = bool(arts and arts[0].get("composed")) and "系统兜底" not in art_content
        run_calls = [c for c in calls if c.get("name") == "run_command"]
        gen_id = arts[0].get("artifactId") if arts else None
        ran_generated = any(
            bool(gen_id) and f"artifacts/{gen_id}" in str(c.get("resolved", ""))
            and "ARTIFACT_RAN" in str((c.get("result") or {}).get("stdout", ""))
            for c in run_calls
        )

        missing = []
        if "material" in expect and browse_hits == 0:
            missing.append("读不到本机代码/日志材料")
        if "artifact" in expect:
            if not arts:
                missing.append("没有生成交付物")
            elif not art_content.strip():
                missing.append("交付物是空的（检索结果没喂给下一步动作）")
            elif not has_real and not composed:
                missing.append("交付物内容不是真实材料")
            if not composed:
                missing.append("内容不是模型基于材料写的（仍是系统拼贴）")
        if "run" in expect:
            if not run_calls:
                missing.append("生成的东西没被执行")
            elif not ran_generated:
                missing.append("执行的不是刚生成的交付物")
        if not replies:
            missing.append("没有回复")

        verdict = "blocked" if missing else "ok"
        if missing and any("交付物" in m or "真实材料" in m for m in missing):
            verdict = "partial"
        run_debug = "; ".join(
            f"detail={c.get('detail')} resolved={c.get('resolved')} out={str((c.get('result') or {}).get('stdout', ''))[:80]!r}"
            for c in run_calls
        )
        rows.append({"tag": tag, "category": category, "text": text, "expect": expect,
                     "state": state, "verdict": verdict, "missing": missing,
                     "browse": browse_hits, "artifacts": len(arts), "art_chars": len(art_content),
                     "composed": composed, "ran_generated": ran_generated, "run_debug": run_debug})

finally:
    if proc and proc.poll() is None:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    stub.shutdown()
    stub.server_close()

with open(MATRIX, "w", encoding="utf-8") as f:
    f.write("DeepSeek / harness 强项工作 · 产品承载矩阵\n")
    f.write("=" * 96 + "\n")
    f.write(f"{'ID':<4}{'类别':<8}{'工作':<44}{'结果':<10}{'缺口'}\n")
    f.write("-" * 96 + "\n")
    for r in rows:
        f.write(f"{r['tag']:<4}{r['category']:<8}{r['text'][:42]:<44}{r['verdict']:<10}{'; '.join(r['missing']) or '—'}\n")
    f.write("-" * 96 + "\n")
    for cat in ("文字", "编程", "推理", "结构化"):
        sub = [r for r in rows if r["category"] == cat]
        ok = sum(1 for r in sub if r["verdict"] == "ok")
        f.write(f"{cat}: {ok}/{len(sub)} 完全接得住\n")
    total_ok = sum(1 for r in rows if r["verdict"] == "ok")
    f.write(f"\n合计 {total_ok}/{len(rows)} 完全接得住；"
            f"partial {sum(1 for r in rows if r['verdict'] == 'partial')}；"
            f"blocked {sum(1 for r in rows if r['verdict'] == 'blocked')}\n")
    f.write("\n详细：\n")
    for r in rows:
        f.write(f"  {r['tag']} state={r['state']} browse_hits={r['browse']} "
                f"artifacts={r['artifacts']} art_chars={r['art_chars']} "
                f"composed={r['composed']} ran_generated={r['ran_generated']}\n")
    f.write("\nB2/B4 执行详情：\n")
    for r in rows:
        if r["run_debug"]:
            f.write(f"  {r['tag']}: {r['run_debug']}\n")
    f.write("\n本轮收口与仍存边界：\n")
    f.write("  - 已打通：检索材料 -> 模型 compose 写交付物正文 -> @last 展开成 artifacts/<id> -> node 执行该交付物。\n")
    f.write("    B2/B4 的严格判据要求 composed=true 且 stdout 含 ARTIFACT_RAN，系统拼贴不再算通过。\n")
    f.write("  - 仍存：全程用本地桩返回结构化动作，测的是产品承载链路，不是 DS 模型的生成质量；\n")
    f.write("    模型质量需要真实代理上的 key 才能验，与链路是否接通无关。\n")
    f.write("  - 仍存：compose 用的是稳定 system 前缀 + 尾部 user 承载材料，尚未做材料过长时的截断/溢出策略。\n")

print(f"matrix -> {MATRIX}")
for r in rows:
    print(f"{r['tag']} {r['verdict']:<8} {'; '.join(r['missing']) or 'ok'}")
