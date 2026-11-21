"""Verify real male TTS with English and mixed-language source text."""
import json
import time
import wave
from pathlib import Path

import local_models

ROOT=Path(__file__).resolve().parent

if __name__=='__main__':
    directory=ROOT/'data/audio';directory.mkdir(parents=True,exist_ok=True)
    local_models.synthesize('准备检查英文朗读。',directory/'verify-english-warmup.wav')
    english_g2p=local_models._g2p.en_callable
    spans=[]
    def record_english(text):
        phonemes=english_g2p(text)
        assert phonemes.strip(),f'English pronunciation missing: {text}'
        spans.append({'text':text,'phonemes':phonemes})
        return phonemes
    local_models._g2p.en_callable=record_english
    sources=[
        ('english','Let us review the Rubric. Must-have criteria are required. Nice-to-have criteria are optional. A case can PASS or FAIL.'),
        ('mixed','这个 case 的 Must-have 没有通过，结果是 FAIL。Rubric，也就是量规。N/A 表示不适用。'),
    ]
    records=[]
    for name,text in sources:
        spans.clear();path=directory/f'verify-{name}-male.wav';started=time.monotonic()
        local_models.synthesize(text,path,200)
        with wave.open(str(path),'rb') as audio:
            assert audio.getnchannels()==1 and audio.getnframes()>2400
            duration=audio.getnframes()/audio.getframerate()
        joined=' '.join(s['text'] for s in spans)
        for term in ['Rubric','Must-have','case','FAIL']:
            assert term in joined,f'Original English term was lost: {term}'
        records.append({'source':text,'voice':local_models.MALE_VOICE,'english_spans':list(spans),'audio':str(path),'audio_seconds':duration,'synthesis_ms':round((time.monotonic()-started)*1000)})
    result={'real_inference':True,'records':records}
    (ROOT/'data/english-voice-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False),flush=True)
