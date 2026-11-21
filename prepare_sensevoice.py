"""Pinned Chinese-oriented ASR assets; downloading is separate from validation."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from prepare_local_models import download

ROOT = Path(__file__).resolve().parent
MODEL = ROOT / 'models/sensevoice-small'
REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07'
REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'

if __name__ == '__main__':
    base = f'https://huggingface.co/{REPO}/resolve/{REVISION}/'
    items = [
        (base+'model.int8.onnx', MODEL/'model.int8.onnx', 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', 239233841),
        (base+'tokens.txt', MODEL/'tokens.txt', None, 315894),
        (base+'test_wavs/zh.wav', MODEL/'test-zh.wav', None, 178988),
    ]
    with ThreadPoolExecutor(max_workers=3) as workers:
        list(workers.map(download, items))
    (MODEL/'source.json').write_text(json.dumps({'repo':REPO,'revision':REVISION},indent=2))
    (MODEL/'.downloaded').write_text(REVISION)
    print('SenseVoice 文件校验完成，等待实际转写验证。',flush=True)
