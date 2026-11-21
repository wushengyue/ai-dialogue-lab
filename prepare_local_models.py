"""Download pinned local model assets into this project, with resumable downloads."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent
QWEN_COMMIT = "50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b"
QWEN_REPO = "mlx-community/Qwen3-4B-Instruct-2507-4bit"
QWEN = ROOT / "models/qwen3-4b"
KOKORO = ROOT / "models/kokoro-zh"


def download(item):
    url, path, checksum, size = item
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and (not size or path.stat().st_size == size):
        if not checksum or hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == checksum:
            print("已就绪：" + path.name, flush=True)
            return
    partial = path.with_suffix(path.suffix + ".part")
    # Recompute the resume offset on every retry; curl's internal retries can
    # truncate the progress made since the command first started.
    for attempt in range(4):
        result = subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--continue-at", "-", "--connect-timeout", "20", "--max-time", "1800", url, "-o", str(partial)])
        if result.returncode == 0:
            break
        if attempt == 3:
            result.check_returncode()
        time.sleep(2)
    if size and partial.stat().st_size != size:
        raise RuntimeError(f"{path.name} 大小不完整")
    if checksum and hashlib.file_digest(partial.open('rb'), 'sha256').hexdigest() != checksum:
        raise RuntimeError(f"{path.name} 校验失败")
    partial.replace(path)
    print("下载并校验完成：" + path.name, flush=True)


def main():
    metadata_path = ROOT / "data/qwen-source.json"
    if not metadata_path.exists():
        download((f"https://huggingface.co/api/models/{QWEN_REPO}/revision/{QWEN_COMMIT}?blobs=true", metadata_path, None, None))
    metadata = json.loads(metadata_path.read_text())
    if metadata["sha"] != QWEN_COMMIT:
        raise RuntimeError("模型版本与固定版本不一致")
    items = []
    for file in metadata["siblings"]:
        name = file["rfilename"]
        if "/" not in name and name.endswith((".json", ".jinja", ".txt", ".safetensors")):
            items.append((f"https://huggingface.co/{QWEN_REPO}/resolve/{QWEN_COMMIT}/{name}?download=true", QWEN / name, file.get("lfs", {}).get("sha256"), file.get("size")))
    release = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"
    items.extend([
        (release + "/kokoro-v1.1-zh.onnx", KOKORO / "model.onnx", "859f9ded9f53be16c24857cdab3254a45da53c3afd5ba6ef134c7de3f822e326", None),
        (release + "/voices-v1.1-zh.bin", KOKORO / "voices.bin", None, None),
        ("https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/raw/main/config.json", KOKORO / "config.json", None, None),
    ])
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, items))
    (QWEN / "source.json").write_text(json.dumps({"repo": QWEN_REPO, "revision": QWEN_COMMIT}, indent=2))
    (QWEN / ".downloaded").write_text(QWEN_COMMIT)
    (KOKORO / ".downloaded").write_text("kokoro-onnx model-files-v1.1")
    print("模型文件准备完成，仍需实际推理验证。", flush=True)


if __name__ == "__main__":
    main()
