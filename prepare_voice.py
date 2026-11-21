"""Download a pinned public model over HTTPS; verify before declaring ready."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
DESTINATION = ROOT / "models" / "whisper-base"
REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
MODEL_SHA256 = "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"
FILES = ("config.json", "tokenizer.json", "vocabulary.txt", "model.bin")


def download(name):
    target = DESTINATION / name
    if target.exists() and name != "model.bin":
        try:
            if name.endswith('.json'):
                json.loads(target.read_text())
            elif target.stat().st_size < 1000:
                raise ValueError('词表文件不完整')
            return
        except (OSError, ValueError):
            pass
    if name == "model.bin" and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == MODEL_SHA256:
        return
    print(f"下载 {name}…", flush=True)
    part = target.with_suffix(target.suffix + ".part")
    url = f"https://huggingface.co/Systran/faster-whisper-base/resolve/{REVISION}/{name}"
    subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--continue-at", "-", "--retry", "2", "--connect-timeout", "15", "--max-time", "600", "--output", str(part), url], check=True)
    if name == "model.bin":
        if hashlib.sha256(part.read_bytes()).hexdigest() != MODEL_SHA256:
            raise RuntimeError("语音模型校验失败，请重新下载")
    elif name.endswith('.json'):
        json.loads(part.read_text())
    part.replace(target)
    print(f"完成 {name} ({target.stat().st_size:,} bytes)", flush=True)


if __name__ == "__main__":
    DESTINATION.mkdir(parents=True, exist_ok=True)
    print("准备本地中文语音识别模型：使用 HTTPS 下载并校验文件。", flush=True)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(download, FILES))
    print("文件校验完成，正在验证模型能否实际加载…", flush=True)
    from faster_whisper import WhisperModel
    model = WhisperModel(str(DESTINATION), device="cpu", compute_type="int8", cpu_threads=4)
    (DESTINATION / ".ready").write_text(json.dumps({"revision": REVISION, "sha256": MODEL_SHA256}))
    print("本地语音模型已就绪。", flush=True)
