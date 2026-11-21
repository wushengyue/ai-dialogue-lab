"""Synthesize a known sentence locally, then recognize the generated WAV."""
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8765"
if __name__ == "__main__":
    sentence = "你好，我想学习如何清楚地介绍一个项目。"
    req = urllib.request.Request(BASE + "/api/speak", data=json.dumps({"text": sentence, "rate": 180}, ensure_ascii=False).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response: wav = response.read()
    assert wav[:4] == b"RIFF"
    print(f"本地语音合成成功：{len(wav)} bytes", flush=True)
    req = urllib.request.Request(BASE + "/api/transcribe", data=wav, headers={"Content-Type": "audio/wav"})
    with urllib.request.urlopen(req, timeout=180) as response: result = json.load(response)
    assert len(result.get("text", "")) >= 8, result
    (ROOT / "data/voice-verification.json").write_text(json.dumps({"source": sentence, "recognition": result}, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False), flush=True)
