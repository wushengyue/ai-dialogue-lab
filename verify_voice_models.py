"""Run real voice inference before marking downloaded assets ready."""
import json
from pathlib import Path
import time
import wave
import local_models
import speech_recognition

ROOT=Path(__file__).resolve().parent
if __name__=='__main__':
    directory=ROOT/'data/audio';directory.mkdir(parents=True,exist_ok=True)
    sample=directory/'verify-current-male.wav'
    started=time.monotonic()
    local_models.synthesize('我想先看同一个案例分两路生成回复的过程。',sample,200)
    (local_models.TTS_PATH/'.ready').write_text('Verified Chinese male voice '+local_models.MALE_VOICE)
    recognition=speech_recognition.transcribe(sample.read_bytes(),provider='sensevoice')
    if not recognition['text']:raise RuntimeError('识别模型未返回有效文本')
    (speech_recognition.SENSE_PATH/'.ready').write_text('Verified SenseVoice inference')
    marked=directory/'verify-prosody.wav'
    local_models.synthesize('[慢]先看[重读]必需项[/重读]。[/慢][停顿:300][快]再看加分项。[/快]',marked,200)
    with wave.open(str(marked),'rb') as audio:duration=audio.getnframes()/audio.getframerate()
    result={'voice':local_models.MALE_VOICE,'recognition':recognition,'prosody_audio_seconds':duration,'elapsed_ms':round((time.monotonic()-started)*1000)}
    (ROOT/'data/voice-model-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False),flush=True)
