import json, os, subprocess, sys, time, urllib.error, urllib.request

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRATCH = os.environ.get("PI_SCRATCH_DIR", os.path.join(os.path.expanduser("~"), ".resident-agent", "acceptance"))
DATA = os.path.join(SCRATCH, "p0a-e2e")
os.makedirs(DATA, exist_ok=True)
ROOT = "http://127.0.0.1:3201"

env = dict(os.environ, PORT="3201", HOST="127.0.0.1", DATA_DIR=DATA)
env.pop("DEEPSEEK_API_KEY", None)
proc = subprocess.Popen(
    ["node", "src/server.mjs"], cwd=BASE, env=env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
)

results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS  " if cond else "FAIL  ") + name + (("  " + str(extra)) if extra else ""))

def call(method, path, body=None):
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(ROOT + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read().decode("utf-8")
            try: return r.status, json.loads(raw)
            except Exception: return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

try:
    health = None
    for _ in range(60):
        try:
            status, health = call("GET", "/api/health")
            if status == 200: break
        except Exception:
            time.sleep(0.2)
    check("服务启动 /api/health", health is not None and health.get("ok") is True, health)

    status, page = call("GET", "/")
    check("静态首页可访问", status == 200 and "常驻 Bot" in str(page))
    status, js = call("GET", "/app.js")
    check("前端脚本可访问", status == 200 and "EventSource" in str(js))

    status, bot = call("POST", "/api/bots", {"name": "验收Bot", "job": "端到端验证"})
    bot_id = bot.get("id", "") if isinstance(bot, dict) else ""
    check("创建命名 Bot", status == 201 and bot_id.startswith("bot_"), bot_id)

    status, sent = call("POST", f"/api/bots/{bot_id}/messages",
                        {"text": "帮我写一份周报", "clientNonce": "e2e-1"})
    check("发送只返回 202 accepted", status == 202 and sent.get("accepted") is True, sent.get("turnId"))

    time.sleep(0.4)
    status, tr = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    items = tr.get("items", []) if isinstance(tr, dict) else []
    kinds = [e.get("kind") for e in items]
    check("transcript 含回复与活动摘要", "assistant/message" in kinds and "activity" in kinds, kinds)
    art = next((e for e in items if e.get("kind") == "artifact"), None)
    check("产出交付物链接", art is not None and art.get("url", "").startswith("/api/artifacts/"), art.get("url") if art else None)
    if art:
        status, content = call("GET", art["url"])
        check("交付物可下载", status == 200 and "周报" in str(content))

    status, dup = call("POST", f"/api/bots/{bot_id}/messages",
                       {"text": "帮我写一份周报", "clientNonce": "e2e-1"})
    check("相同 nonce 幂等", status == 202 and dup.get("duplicate") is True)

    status, sec = call("POST", "/api/secrets", {"value": "TOPSECRET_E2E"})
    ref = sec.get("ref", "")
    check("凭据旁路返回引用", status == 201 and ref.startswith("sec_"), ref)
    call("POST", f"/api/bots/{bot_id}/messages", {"text": f"用 @secret:{ref} 登录", "clientNonce": "e2e-2"})
    time.sleep(0.4)
    status, tr2 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    check("明文不进 transcript", "TOPSECRET_E2E" not in json.dumps(tr2, ensure_ascii=False))
    check("消息里只留已提供标记", any("[已提供]" in str(e.get("text", "")) for e in tr2.get("items", [])))

    call("POST", f"/api/bots/{bot_id}/messages",
         {"text": "执行命令 `node --version`", "clientNonce": "e2e-3"})
    time.sleep(0.4)
    status, tr3 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
    card = next((e for e in tr3.get("items", []) if e.get("kind") == "card" and e.get("cardType") == "approval"), None)
    check("有后果动作生成审批卡片", card is not None and card.get("cardType") == "approval")
    if card:
        status, ap = call("POST", f"/api/approvals/{card['approvalId']}", {"approve": True})
        check("审批接口可用", status == 200 and ap.get("status") == "approved")
        time.sleep(0.5)
        status, tr4 = call("GET", f"/api/bots/{bot_id}/transcript?cursor=0")
        check("批准后才出现工具调用", any(e.get("kind") == "tool/call" for e in tr4.get("items", [])))

    status, err = call("GET", "/api/bots/bot_missing")
    check("404 错误按族分类", status == 404 and err.get("error", {}).get("family") == "transport",
          err.get("error", {}).get("title"))

    status, caps = call("GET", "/api/capabilities")
    check("执行面声明为本机 provider", status == 200 and caps.get("executor") == "local", caps)

finally:
    proc.terminate()
    try:
        out = proc.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
    print("\n--- server log ---")
    print((out or "").strip()[:1000])

failed = [n for n, ok, _ in results if not ok]
print(f"\nSUMMARY: {len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
