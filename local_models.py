"""Resident Apple Silicon LLM and local Chinese male TTS; no remote inference."""
from concurrent.futures import ThreadPoolExecutor
import json
import re
import time
import wave
from pathlib import Path
from speech_markup import parts, phrase_boundary

ROOT = Path(__file__).resolve().parent
LLM_PATH = ROOT / 'models/qwen3-4b'
TTS_PATH = ROOT / 'models/kokoro-zh'
MODEL_NAME = 'Qwen3-4B-Instruct-2507 · 4bit'
MALE_VOICE = 'zm_011'
WORKER = ThreadPoolExecutor(max_workers=1, thread_name_prefix='local-llm')
_model = _tokenizer = _cache = None
_last_tokens = []
_tts = _g2p = None


def speech_progress(raw):
    """Decode a possibly incomplete JSON speech string without evaluating code."""
    match = re.search(r'"speech"\s*:\s*"', raw)
    if not match:
        return '', False
    output, i = [], match.end()
    while i < len(raw):
        char = raw[i]
        if char == '"':
            return json.loads(raw[match.end() - 1:i + 1]), True
        if char == '\\':
            if i + 1 >= len(raw): break
            escape = raw[i + 1]
            if escape == 'u':
                if i + 6 > len(raw): break
                try: output.append(chr(int(raw[i + 2:i + 6], 16)))
                except ValueError: break
                i += 6; continue
            output.append({'n':'\n','t':'\t','r':'\r','b':'\b','f':'\f'}.get(escape, escape)); i += 2
        else:
            output.append(char); i += 1
    # Do not expose a trailing half of an escaped UTF-16 surrogate pair.
    text = ''.join(output).encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='ignore')
    return text, False


def partial_speech(raw):
    return speech_progress(raw)[0]


def _ensure_llm():
    global _model, _tokenizer, _cache
    from mlx_lm import load
    from mlx_lm.models.cache import make_prompt_cache
    if _model is None:
        _model, _tokenizer = load(str(LLM_PATH), tokenizer_config={'trust_remote_code': False})
        _cache = make_prompt_cache(_model)


def instructions(system):
    rules = (ROOT / 'runtime_instructions.md').read_text()
    schema = json.loads((ROOT / 'response.schema.json').read_text())
    return rules + '\n' + system + '\n输出 JSON，speech 必须是第一个字段。首句要有实质内容：讲师解释概念或直接回答，面试官直接提问；面试不为抢首声提前说参考答案。简短问候可以合并，但禁止只用自我介绍、“收到”“我想想”“我们来看看”等作为首段。第一句通常 15—24 个汉字，句号后再展开；本轮话术通常最多 100 字，用户要求拆题可适当展开。学生关键问题写入 student_question，讲师关键讲法写入 solution，默认模拟面试不展示解法，需要关系图时返回 diagram。板书简短，不复制话术。\nSchema：' + json.dumps(schema, ensure_ascii=False, separators=(',', ':'))


def _prompt(system, user_input):
    messages = [{'role':'system','content':instructions(system)}, {'role':'user','content':json.dumps(user_input, ensure_ascii=False, separators=(',', ':'))}]
    return _tokenizer.encode(_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True) + '{"speech":"')


def _reuse_prefix(tokens):
    global _cache, _last_tokens
    from mlx_lm.models.cache import make_prompt_cache, trim_prompt_cache
    offset, common = int(_cache[0].offset), 0
    for a, b in zip(tokens, _last_tokens[:offset]):
        if a != b: break
        common += 1
    common = min(common, len(tokens) - 1)
    if offset > common:
        if trim_prompt_cache(_cache, offset - common) != offset - common:
            _cache = make_prompt_cache(_model); common = 0
    _last_tokens = tokens[:]
    return common


def warmup(system, user_input):
    """Load and prefill on the same worker used by live turns, before class starts."""
    return WORKER.submit(_warmup, system, user_input).result(timeout=180)


def _warmup(system, user_input):
    from mlx_lm import stream_generate
    from mlx_lm.models.cache import trim_prompt_cache
    _ensure_llm()
    tokens = _prompt(system, user_input)
    common = _reuse_prefix(tokens)
    for _ in stream_generate(_model, _tokenizer, prompt=tokens[common:], prompt_cache=_cache, max_tokens=1):
        pass
    excess = int(_cache[0].offset) - len(tokens)
    if excess > 0: trim_prompt_cache(_cache, excess)
    return {'prompt_tokens':len(tokens), 'cached_prompt_tokens':int(_cache[0].offset)}


def generate(system, user_input, cancelled, on_speech=None, on_text=None):
    return WORKER.submit(_generate, system, user_input, cancelled, on_speech, on_text).result(timeout=180)


def _generate(system, user_input, cancelled, on_speech, on_text):
    global _model, _tokenizer, _cache, _last_tokens
    from mlx_lm import stream_generate
    from mlx_lm.models.cache import trim_prompt_cache
    from mlx_lm.sample_utils import make_sampler
    started = time.monotonic()
    if cancelled(): raise InterruptedError('已取消的请求不进入推理')
    _ensure_llm()
    prefix = '{"speech":"'
    tokens = _prompt(system, user_input)
    common = _reuse_prefix(tokens)
    raw, emitted, first_text_ms, count, ttft_ms, visible = prefix, '', None, 0, None, ''
    try:
        for response in stream_generate(_model, _tokenizer, prompt=tokens[common:], prompt_cache=_cache, max_tokens=1400, sampler=make_sampler(temp=.25)):
            if cancelled(): raise InterruptedError('用户已中断本轮')
            if time.monotonic() - started > 150: raise TimeoutError('本地模型生成超时')
            count += 1; raw += response.text
            if ttft_ms is None: ttft_ms = round((time.monotonic()-started)*1000)
            speech, speech_done = speech_progress(raw)
            if on_text and (speech != visible or count == 1):
                on_text(speech[len(visible):], {'ttft_ms':ttft_ms})
                visible = speech
            tail = speech[len(emitted):]
            # First phrase starts sooner; later chunks are longer for natural prosody.
            boundary = phrase_boundary(tail,first=not emitted,done=speech_done)
            if boundary and on_speech:
                part = tail[:boundary]; emitted += part
                if first_text_ms is None: first_text_ms = round((time.monotonic() - started) * 1000)
                on_speech(part, {'ttft_ms':ttft_ms})
        result = json.loads(raw)
        if not result['speech'].startswith(emitted): raise ValueError('流式话术与最终结果不一致')
        remainder = result['speech'][len(emitted):]
        if remainder and on_speech: on_speech(remainder, {'ttft_ms':ttft_ms})
        # Generated tokens differ from the next request's history. Only cache the
        # known shared prompt, rather than accidentally reusing a different turn.
        excess = int(_cache[0].offset) - len(tokens)
        if excess > 0: trim_prompt_cache(_cache, excess)
        return result, {'provider':'local','model':MODEL_NAME,'latency_ms':round((time.monotonic()-started)*1000),'ttft_ms':ttft_ms,'first_text_ms':first_text_ms,'cached_prompt_tokens':common,'generated_tokens':count}
    except BaseException:
        excess = int(_cache[0].offset) - len(tokens)
        if excess > 0: trim_prompt_cache(_cache, excess)
        raise


def synthesize(text, path, rate=200, voice=MALE_VOICE):
    global _tts, _g2p
    import numpy as np
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    from misaki import zh
    if _tts is None:
        options = ort.SessionOptions(); options.intra_op_num_threads = 3; options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(TTS_PATH / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        _tts = Kokoro.from_session(session, str(TTS_PATH / 'voices.bin'), vocab_config=str(TTS_PATH / 'config.json'))
        _g2p = zh.ZHG2P(version='1.1', en_callable=lambda word: _tts.tokenizer.phonemize(word, lang='en-us'))
    # Preserve the spoken text's language. The English G2P callback above reads
    # English spans; translating terminology here would disagree with captions.
    if not voice.startswith('zm_'): raise ValueError('三茅老师只使用中文男声')
    chunks, sample_rate = [], 24000
    for part in parts(text):
        if part.pause_ms:
            chunks.append(np.zeros(round(sample_rate*part.pause_ms/1000),dtype=np.float32));continue
        if not part.text: continue
        spoken = part.text
        spoken=re.sub(r'(?<=\d)\s*×\s*(?=\d)','乘以',spoken).replace('×','不达标').replace('✓','达标')
        phonemes,_=_g2p(spoken)
        samples,sample_rate=_tts.create(phonemes,voice=voice,speed=max(.65,min(1.5,rate/190*part.speed)),is_phonemes=True)
        samples=np.asarray(samples,dtype=np.float32)
        if part.gain!=1: samples=np.clip(samples*part.gain,-.98,.98)
        chunks.append(samples)
    samples=np.concatenate(chunks) if chunks else np.array([])
    if not samples.size or not np.isfinite(samples).all(): raise RuntimeError('本地男声模型未产生有效音频')
    with wave.open(str(path),'wb') as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(sample_rate)
        output.writeframes((np.clip(samples,-1,1)*32767).astype('<i2').tobytes())
