"""Resident ASR with Chinese SenseVoice as the preferred local recognizer."""
import io
from pathlib import Path
import threading
import time
import wave

ROOT = Path(__file__).resolve().parent
SENSE_PATH = ROOT/'models/sensevoice-small'
WHISPER_PATH = ROOT/'models/whisper-base'
LOCK = threading.Lock()
_sense = _whisper = None


def ready():
    return any((path/'.ready').exists() for path in (SENSE_PATH,WHISPER_PATH))


def model_name():
    return 'SenseVoice Small · 中文优先' if (SENSE_PATH/'.ready').exists() else 'Whisper base · 备用'


def pcm_samples(audio):
    import numpy as np
    if len(audio)<44 or audio[:4]!=b'RIFF': raise ValueError('需要 WAV 音频')
    with wave.open(io.BytesIO(audio),'rb') as stream:
        if stream.getsampwidth()!=2 or stream.getnchannels() not in (1,2):
            raise ValueError('需要 16 位 PCM 单声道或双声道 WAV')
        rate=stream.getframerate()
        samples=np.frombuffer(stream.readframes(stream.getnframes()),dtype='<i2').astype(np.float32)/32768.0
        if stream.getnchannels()==2: samples=samples.reshape(-1,2).mean(axis=1)
    if rate!=16000:
        samples=np.interp(np.arange(round(len(samples)*16000/rate))*rate/16000,np.arange(len(samples)),samples).astype(np.float32)
    return samples


def transcribe(audio, provider=None):
    global _sense,_whisper
    started=time.monotonic()
    samples=pcm_samples(audio)
    provider=provider or ('sensevoice' if (SENSE_PATH/'.ready').exists() else 'whisper')
    with LOCK:
        if provider=='sensevoice':
            import sherpa_onnx
            from faster_whisper.vad import get_speech_timestamps
            if _sense is None:
                _sense=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=str(SENSE_PATH/'model.int8.onnx'),tokens=str(SENSE_PATH/'tokens.txt'),language='zh',use_itn=True,num_threads=4,provider='cpu')
            # A volume trigger can be a chair/noise. Require speech before ASR;
            # a silent recording must never invent a student utterance.
            if get_speech_timestamps(samples):
                stream=_sense.create_stream();stream.accept_waveform(16000,samples)
                _sense.decode_stream(stream);text=stream.result.text.strip()
            else: text=''
        else:
            from faster_whisper import WhisperModel
            if _whisper is None:
                _whisper=WhisperModel(str(WHISPER_PATH),device='cpu',compute_type='int8',cpu_threads=4)
            segments,_=_whisper.transcribe(samples,language='zh',beam_size=3,vad_filter=True,condition_on_previous_text=False,initial_prompt='Rubric，量规，案例，板书，评分，必需项，加分项，三茅老师。')
            text=''.join(s.text for s in segments if s.no_speech_prob<.65).strip()
    return {'text':text,'latency_ms':round((time.monotonic()-started)*1000),'model':provider,'audio_ms':round(len(samples)/16)}
