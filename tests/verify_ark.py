"""Use the actual classroom prompt to verify the configured remote stream."""
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ark_model
import server

if __name__ == '__main__':
    config = server.config()
    settings = {**config['roles']['lecturer'], 'profile':config['profile']}
    doc = server.Session(settings).doc
    question = '为什么数学答案是对的，整条案例仍然可能不通过？请画出关键判断关系。'
    doc['messages'] = [{'role':'user','content':question}]
    user = server.compile_input(doc,'user')
    chunks = []
    started = time.monotonic()
    def on_speech(text,timing):
        chunks.append(text)
        print(json.dumps({'at_ms':round((time.monotonic()-started)*1000),'speech':text,**timing},ensure_ascii=False),flush=True)
    result,metrics = ark_model.generate(ark_model.MODEL,settings['system'],user,lambda:False,on_speech=on_speech)
    data = {'question':question,'result':result,'metrics':metrics,'speech_chunks':chunks}
    (server.DATA/'ark-verification.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    print(json.dumps(data,ensure_ascii=False),flush=True)
    assert ''.join(chunks) == result['speech']
    assert result['steps']
    ops=result['board']['operations']
    assert any(op['action'] in ('node','add') for op in ops)
