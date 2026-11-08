"""Real-model capability probe: run the SAME 14 tasks against the real
DeepSeek endpoint through the product's own adapter. This measures whether
our chain accepts what the model actually returns (not the model's IQ).

Usage: DSH_TEST_KEY / DSH_TEST_BASE / DSH_TEST_MODEL env vars.
"""
import http.server, json, os, shutil, socketserver, subprocess, sys, threading, time
import urllib.error, urllib.request

WORKSPACE = r"C:\Users\meme\Desktop\deepseek"
SCRATCH = os.environ.get("PI_SCRATCH_DIR", r"C:\Users\meme\.pi-desktop\scratch")
DATA = os.path.join(SCRATCH, "p0a-realprobe")
MATRIX = os.path.join(SCRATCH, "real_model_report.txt")
MODEL = os.environ.get("DSH_TEST_MODEL", "deepseek/deepseek-v4-flash")
BASE = os.environ.get("DSH_TEST_BASE", "https://api.qnaigc.com/v1").rstrip("/")
KEY = os.environ.get("DSH_TEST_KEY", "")
shutil.rmtree(DATA, ignore_errors=True)
MATERIALS = os.path.join(DATA, "materials")
os.makedirs(MATERIALS, exist_ok=True)

with open(os.path.join(MATERIALS, "sort.js"), "w", encoding="utf-8") as f:
    f.write("function sortItems(items) {\n  return items.sort((a, b) => a.score - b.score)\n}\nmodule.exports = { sortItems }\n")
with open(os.path.join(MATERIALS, "access.log"), "w", encoding="utf-8") as f:
    f.write("GET /a 200\nGET /b 500\nPOST /c 500\nGET /d 200\nGET /e 500\n")
with open(os.path.join(MATERIALS, "notes.md"), "w", encoding="utf-8") as f:
    f.write("# 技术说明\n\nDeepSeek 的推理档位通过旁路字段传递，不进入 messages，因此不影响前缀缓存命中率。\n")

PORT = 3116
ROOT = f"http://127.0.0.1:{PORT}"

TASKS = [
    ("A1", "文字", "把 notes.md 里的技术说明译成英文，术语保持一致"),
    ("A2", "文字", "把 notes.md 压成 5 条要点"),
    ("A3", "文字", "把「这个活儿搞定了哈，挺好」改成严谨的书面语"),
    ("A4", "文字", "从 notes.md 里抽出术语表"),
    ("B2", "编程", "给 materials/sort.js 写一个 Node 单元测试并跑起来"),
    ("B3", "编程", "materials/sort.js 报 TypeError，帮我定位原因"),
    ("B4", "编程", "写个 Node 脚本统计 materials/access.log 里 500 出现的次数并运行"),
    ("B5", "编程", "审查 materials/sort.js 有什么问题"),
    ("C1", "推理", "一个水池进出两根管子，给出解题过程"),
    ("C2", "推理", "三个约束下推断谁拿了钥匙，写清推理步骤"),
    ("D1", "结构化", "把 materials/access.log 解析成 JSON"),
    ("D2", "结构化", "统计 materials/access.log 里 500 出现了几次"),
    ("D3", "结构化", "判断「用了三天还是不满意，必须退钱」是投诉还是建议"),
]

env = dict(os.environ, PORT=str(PORT), HOST="127.0.0.1", DATA_DIR=DATA,
           MAX_CONCURRENT_TURNS="3",
           DEEPSEEK_API_KEY=KEY,
           DEEPSEEK_BASE_URL=BASE,
           DEEPSEEK_MODEL=MODEL,
           DEEPSEEK_REASONING_EFFORT="low")
for var in ("EXECUTOR_PROVIDER", "OBSERVER_MODE", "WATCHDOG_INTERVAL_MS"):
    env.pop(var, None)


def call(method, path, body=None):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(ROOT + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
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


def wait_turn(tid, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        s = call("GET", f"/api/turns/{tid}")[1].get("status")
        if s in ("completed", "failed", "denied", "interrupted"):
            return s
        time.sleep(0.2)
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
    health = None
    for _ in range(80):
        try:
            st, health = call("GET", "/api/health")
            if st == 200 and health.get("ok"):
                break
        except Exception:
            time.sleep(0.25)
    print(f"service model={health.get('model') if health else '?'}")

    st, bot = call("POST", "/api/bots", {"name": "真模型探针", "job": "逐项验证真实输出"})
    bot_id = bot["id"]

    for tag, category, text in TASKS:
        r = call("POST", f"/api/bots/{bot_id}/messages", {"text": text})[1]
        tid = r.get("turnId")
        state = wait_turn(tid)
        tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=2000")[1].get("items", [])
        mine = [e for e in tr if e.get("turnId") == tid]
        replies = [e for e in mine if e.get("kind") == "assistant/message"]
        calls = [e for e in mine if e.get("kind") == "tool/call"]
        arts = [e for e in mine if e.get("kind") == "artifact"]
        errs = [e for e in mine if e.get("kind") == "error"]
        browse = next((c for c in calls if c.get("name") == "browse"), None)
        browse_hits = len((browse or {}).get("result", {}).get("items") or [])
        art_text = artifact_text(arts[0].get("artifactId")) if arts else ""
        reply_text = replies[0].get("text", "") if replies else ""

        if state == "failed" and errs and errs[0].get("code") == "USAGE_LIMIT":
            print(f"  ({tag} hit gateway rate limit, waiting 25s and retrying)")
            time.sleep(25)
            r2 = call("POST", f"/api/bots/{bot_id}/messages",
                      {"text": text, "clientNonce": f"retry-{tag}"})[1]
            tid = r2.get("turnId")
            state = wait_turn(tid, 150)
            tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0&limit=2000")[1].get("items", [])
            mine = [e for e in tr if e.get("turnId") == tid]
            replies = [e for e in mine if e.get("kind") == "assistant/message"]
            calls = [e for e in mine if e.get("kind") == "tool/call"]
            arts = [e for e in mine if e.get("kind") == "artifact"]
            errs = [e for e in mine if e.get("kind") == "error"]
            browse = next((c for c in calls if c.get("name") == "browse"), None)
            browse_hits = len((browse or {}).get("result", {}).get("items") or [])
            art_text = artifact_text(arts[0].get("artifactId")) if arts else ""
            reply_text = replies[0].get("text", "") if replies else ""

        gaps = []
        if state != "completed":
            gaps.append(f"turn={state}" + (f" err={errs[0].get('code')}" if errs else ""))
        if not replies:
            gaps.append("无回复")
        elif not reply_text.strip():
            gaps.append("回复是空的")
        if browse is None and any(k in text for k in ("sort.js", "access.log", "notes.md")):
            gaps.append("没去读本机材料")
        elif browse is not None and browse_hits == 0:
            gaps.append("读了但没命中")
        if arts and not art_text.strip():
            gaps.append("交付物是空的")
        if arts and arts[0].get("composed") is False:
            gaps.append("内容是系统拼贴而非模型写的")
        verdict = "ok" if not gaps else ("partial" if len(gaps) == 1 and "读了但没命中" in gaps[0] else "blocked")
        rows.append({"tag": tag, "cat": category, "text": text, "state": state,
                     "verdict": verdict, "gaps": gaps, "browse": browse_hits,
                     "arts": len(arts), "art_chars": len(art_text),
                     "reply": reply_text[:160].replace("\n", " ")})
        print(f"{tag} {verdict:<8} reply={reply_text[:60]!r}")

finally:
    if proc and proc.poll() is None:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass

with open(MATRIX, "w", encoding="utf-8") as f:
    f.write(f"真实模型能力探针 · model={MODEL}\n")
    f.write("=" * 96 + "\n")
    for r in rows:
        f.write(f"{r['tag']:<4}{r['cat']:<8}{r['verdict']:<10}{'; '.join(r['gaps']) or '—'}\n")
        f.write(f"      问: {r['text']}\n")
        f.write(f"      答: {r['reply']}\n")
        f.write(f"      browse={r['browse']} artifacts={r['arts']} art_chars={r['art_chars']}\n")
    ok = sum(1 for r in rows if r["verdict"] == "ok")
    f.write("-" * 96 + "\n")
    for cat in ("文字", "编程", "推理", "结构化"):
        sub = [r for r in rows if r["cat"] == cat]
        f.write(f"{cat}: {sum(1 for r in sub if r['verdict'] == 'ok')}/{len(sub)}\n")
    f.write(f"\n合计 {ok}/{len(rows)} 完全接得住\n")
print(f"report -> {MATRIX}")
