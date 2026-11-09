"""Measure the observation gate against the REAL model.

Low-attention means two different errors:
  - false positive: noise flagged as "worth handling" -> the user gets bothered
  - false negative: a real defect flagged as noise -> the user never finds out

We label a realistic event set, run the product's own judge() through the real
DeepSeek endpoint, and report both directions.
"""
import json, os, subprocess, sys, time
import os
import tempfile
import urllib.error, urllib.request

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.environ.get("RESIDENT_REPO", _REPO_ROOT)
SCRATCH = os.environ.get("PI_SCRATCH_DIR", tempfile.gettempdir())
REPORT = os.path.join(SCRATCH, "judge_report.txt")
MODEL = os.environ.get("DSH_TEST_MODEL", "deepseek/deepseek-v4-flash")
BASE = os.environ.get("DSH_TEST_BASE", "https://api.qnaigc.com/v1").rstrip("/")
KEY = os.environ.get("DSH_TEST_KEY", "")

# (source, text, should_flag)
# should_flag=True  -> a real defect / todo / decision that deserves attention
# should_flag=False -> ordinary noise that must NOT interrupt the user
CASES = [
    ("github", "构建失败：TypeError: cannot read property 'id' of undefined", True),
    ("github", "#12 CI 报错 needs repro，麻烦复现一下", True),
    ("ci", "构建失败，请复现", True),
    ("github", "PR #48 有一个 review 冲突需要人来决定合哪边", True),
    ("email", "服务器磁盘已满，请尽快处理，否则服务会挂", True),
    ("calendar", "会议改到明天上午 10 点，需要你确认", True),
    ("github", "issue 里有明确的待办：补一个回归测试", True),
    ("slack", "发布回滚了，需要人工确认是否重发", True),
    ("github", "依赖有高危漏洞，需要升级", True),
    ("email", "密码将在 3 天后过期，请更新", True),
    ("github", "有人在评论里问这个 API 怎么用", False),
    ("github", "CI 跑挂了，帮忙看看", True),

    ("heartbeat", "服务正常运行", False),
    ("github", "文档更新了一点拼写", False),
    ("slack", "午饭一起吗", False),
    ("email", "本周周报请大家周五前提交", False),
    ("github", "star 数到 1000 了", False),
    ("calendar", "今天的日程已同步", False),
    ("system-noise", "定时任务执行完毕", False),
    ("github", "有个 issue 被关闭了", False),
    ("email", "收到你的邮件，谢谢", False),
    ("slack", "稍后聊", False),
    ("ci", "所有测试通过", False),
    ("github", "有个新的 fork 出现了", False),
    ("email", "订阅了我们的 newsletter 吗？", False),
    ("slack", "哈哈哈哈", False),
    ("calendar", "提醒：15 分钟前的会议纪要已归档", False),
]


def load_judge_system():
    probe = os.path.join(SCRATCH, "judge_prompt_probe.mjs")
    with open(probe, "w", encoding="utf-8") as f:
        f.write("import { JUDGE_SYSTEM } from 'file:///" +
                WORKSPACE.replace("\\", "/") + "/src/providers.mjs'\n")
        f.write("console.log(JSON.stringify(JUDGE_SYSTEM))\n")
    out = subprocess.run(["node", probe], capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0 or not out.stdout.strip():
        sys.stderr.write("NODE PROBE FAILED:\n" + out.stderr)
        raise SystemExit("could not import JUDGE_SYSTEM from product")
    val = json.loads(out.stdout.strip())
    return val if isinstance(val, str) else "\n".join(val)


def call_judge(text, source, effort, prompt):
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps({"source": source, "text": text}, ensure_ascii=False)},
        ],
        "reasoning_effort": effort,
    }
    last_err = None
    for attempt in range(4):
        req = urllib.request.Request(
            BASE + "/chat/completions", data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            msg = data.get("choices", [{}])[0].get("message", {})
            raw = str(msg.get("content") or msg.get("reasoning_content") or "").strip()
            fence = raw
            if raw.startswith("```"):
                rest = raw[3:].split("```", 1)
                fence = rest[0] if rest else raw
                fence = fence.replace("json", "", 1).strip()
            try:
                v = json.loads(fence)
                return True, bool(v.get("worthwhile")), str(v.get("reason", ""))[:60]
            except Exception:
                return False, None, f"unparseable: {raw[:80]}"
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            last_err = f"HTTP {e.code}: {detail}"
            if e.code in (429, 503) and attempt < 3:
                time.sleep(3 * (attempt + 1))
                continue
            return False, None, last_err
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < 3:
                time.sleep(3 * (attempt + 1))
                continue
            return False, None, last_err
    return False, None, last_err or "unknown"


def main():
    if not KEY:
        raise SystemExit("DSH_TEST_KEY is empty")
    prompt = load_judge_system()
    print(f"prompt chars={len(prompt)}  cases={len(CASES)}  model={MODEL}\n")

    rows = []
    for source, text, should in CASES:
        ok, got, reason = call_judge(text, source, "low", prompt)
        if got is None:
            got_disp = "??"
            flag = "ERR"
        else:
            got_disp = str(got)
            flag = "FP" if (got and not should) else ("FN" if (got is False and should) else "ok")
        rows.append({"source": source, "text": text, "should": should, "got": got, "reason": reason})
        print(f"{flag:>3}  should={str(should):<5} got={got_disp:<5} {reason[:44]}  | {text[:44]}")
        time.sleep(4.0)  # gentle: stay under gateway RPM

    unparsed = [r for r in rows if r["got"] is None]
    fp = [r for r in rows if r["got"] is True and not r["should"]]
    fn = [r for r in rows if r["got"] is False and r["should"]]
    tp = [r for r in rows if r["got"] is True and r["should"]]
    tn = [r for r in rows if r["got"] is False and not r["should"]]
    flagged = [r for r in rows if r["got"] is True]
    positives = sum(1 for r in rows if r["should"])
    negatives = len(rows) - positives

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(f"观察闸门真模型实测 · model={MODEL}\n")
        f.write("=" * 92 + "\n")
        f.write(f"样本 {len(rows)} 条（应处理 {positives} / 噪音 {negatives}）\n")
        f.write(f"误报（噪音被标记 -> 打扰用户）: {len(fp)}\n")
        f.write(f"漏报（真问题被忽略 -> 用户漏事）: {len(fn)}\n")
        f.write(f"解析/调用失败: {len(unparsed)}\n")
        if positives:
            f.write(f"召回率 (真问题被抓住): {len(tp)}/{positives} = {len(tp)/positives:.0%}\n")
        if flagged:
            f.write(f"精确率 (标记里真有问题): {len(tp)}/{len(flagged)} = {len(tp)/len(flagged):.0%}\n")
        if negatives:
            f.write(f"噪音正确忽略率: {len(tn)}/{negatives} = {len(tn)/negatives:.0%}\n")
        f.write("-" * 92 + "\n")
        for r in rows:
            tag = "FP" if (r["got"] and not r["should"]) else ("FN" if (r["got"] is False and r["should"]) else "ERR" if r["got"] is None else "ok")
            g = "??" if r["got"] is None else str(r["got"])
            f.write(f"{tag:>3} should={str(r['should']):<5} got={g:<5} {r['reason'][:50]:<52} {r['text'][:40]}\n")
        f.write("-" * 92 + "\n")
        if fp:
            f.write("\n误报样本（这些会打扰用户，需要收紧）：\n")
            for r in fp:
                f.write(f"  - [{r['source']}] {r['text']}  -> {r['reason']}\n")
        if fn:
            f.write("\n漏报样本（这些会让用户漏事，需要放宽）：\n")
            for r in fn:
                f.write(f"  - [{r['source']}] {r['text']}  -> {r['reason']}\n")
        if unparsed:
            f.write("\n解析/调用失败样本（多为网关限流 429，产品侧已加重排队兜底）：\n")
            for r in unparsed:
                f.write(f"  - [{r['source']}] {r['text']}  -> {r['reason']}\n")

    print(f"\nreport -> {REPORT}")
    print(f"误报 {len(fp)} / 漏报 {len(fn)} / 失败 {len(unparsed)}")
    if positives:
        print(f"召回 {len(tp)}/{positives}")
    if flagged:
        print(f"精确 {len(tp)}/{len(flagged)}")


if __name__ == "__main__":
    main()
