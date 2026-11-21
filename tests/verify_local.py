"""Real model smoke check, including streaming callbacks and prompt cache."""
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_models
import server

if __name__ == '__main__':
    c = server.config()
    settings = {**c['roles']['lecturer'], 'profile':c['profile']}
    doc = server.Session(settings).doc
    user = server.compile_input(doc, 'start')
    started = time.monotonic()
    print('预热本地讲解模型…', flush=True)
    print(local_models.warmup(settings['system'], user), flush=True)
    print('warmup_seconds', round(time.monotonic()-started,2), flush=True)
    started = time.monotonic()
    chunks = []
    def on_speech(text, timing):
        chunks.append(text)
        print(json.dumps({'at_ms':round((time.monotonic()-started)*1000), 'speech':text, **timing},ensure_ascii=False),flush=True)
    result, metrics = local_models.generate(settings['system'], user, lambda:False, on_speech=on_speech)
    print(json.dumps({'result':result,'metrics':metrics},ensure_ascii=False),flush=True)
    assert result['board']['question'] and result['await_user']
    assert ''.join(chunks) == result['speech']
    (server.DATA/'local-verification.json').write_text(json.dumps({'result':result,'metrics':metrics,'speech_chunks':chunks},ensure_ascii=False,indent=2))
    (local_models.LLM_PATH/'.ready').write_text(local_models.MODEL_NAME)
