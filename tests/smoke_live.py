"""Explicit live check: calls the signed-in Codex model with synthetic data."""
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8765"

def request(path, data=None):
    raw = None if data is None else json.dumps(data, ensure_ascii=False).encode()
    req = urllib.request.Request(BASE + path, data=raw, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=150) as response:
        return json.load(response)

if __name__ == "__main__":
    if "--followup" in sys.argv:
        records = json.loads((ROOT / "data/verification.json").read_text())
        replies = {
            "lecturer": "我对这个方法完全不熟，请少用术语，拿一个具体例子说。",
            "interviewer": "我做过一个新用户引导项目，主要负责调研和方案设计，但是上线数据是运营同事统计的，我不知道最终提升了多少。"
        }
        for record in records:
            result = request("/api/turn", {"session_id": record["session_id"], "event": "user", "text": replies[record["role"]]})
            record["followup"] = result
            print(json.dumps({"role": record["role"], "speech": result["message"]["content"]}, ensure_ascii=False), flush=True)
        (ROOT / "data/verification.json").write_text(json.dumps(records, ensure_ascii=False, indent=2))
        sys.exit(0)
    conf = request("/api/config")["config"]
    results = []
    for role in ("lecturer", "interviewer"):
        settings = dict(role=role, **conf["roles"][role], model=conf["model"], profile=conf["profile"], voice=False)
        session = request("/api/session", settings)
        print("正在验证 " + role, flush=True)
        result = request("/api/turn", dict(session_id=session["session_id"], event="start"))
        assert result["message"]["content"]
        if role == "interviewer": assert result["message"]["await_user"] is True
        results.append(dict(role=role, session_id=session["session_id"], **result))
        print(json.dumps({"role": role, "speech": result["message"]["content"], "metrics": result["metrics"]}, ensure_ascii=False), flush=True)
    (ROOT / "data/verification.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print("两个角色的真实 Codex 调用均成功。", flush=True)
