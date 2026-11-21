"""Server-side Ark Responses stream. Credentials never enter session documents."""
import json
import os
import re
from pathlib import Path
import time
import httpx
from local_models import instructions, speech_progress
from speech_markup import phrase_boundary
from board_protocol import step_progress, validate_ops, normalize

ROOT = Path(__file__).resolve().parent
KEY_FILE = ROOT / 'data/credentials/ark.key'
MODEL = 'deepseek-v4-1-flash-economy-261017'
ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses'
# Reuse TLS connections between turns. No per-utterance CLI startup.
CLIENT = httpx.Client(timeout=httpx.Timeout(90,connect=15),trust_env=False)


def api_key():
    return os.environ.get('ARK_API_KEY') or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else '')


def request_body(model,system,user_input,stream=True,max_tokens=2000):
    runtime=user_input.get('运行状态',{}) if isinstance(user_input,dict) else {}
    event=runtime.get('事件')
    turn_rule=''
    if event in ('user','continue','silence'):
        turn_rule='\n本轮不是主动开课，不得重新问候、自我介绍、复述课题或整课预告。直接按本轮行动处理学生输入或检查已讲关键内容。'
    elif event=='start' and runtime.get('角色','lecturer')=='lecturer':
        turn_rule='\n本轮为主动开课：使用学生姓名问候，自我介绍一次“我是三茅老师，一个爱穿格子衫的资深 AI 从业者”，完整说出课程标题，再依次预告几个方面，按顺序开始；await_user=false。'
    elif event=='start':
        turn_rule='\n本轮为模拟面试开场：简短问候，说明本次面试主题，提出一个实质问题后等待候选人作答，await_user=true；不预先讲解参考答案。'
    return {'model':model or MODEL,'stream':stream,'store':False,'thinking':{'type':'disabled'},'max_output_tokens':max_tokens,
            'input':[{'role':'system','content':system+'\n'+(ROOT/'stream_instructions.md').read_text()+turn_rule},
                     {'role':'user','content':json.dumps(user_input,ensure_ascii=False,separators=(',',':'))}]}


def warmup(model,system,user_input):
    # Prime the reusable connection and common lesson prefix before class. This
    # one-token preparation is never presented or counted as a student reply.
    response=CLIENT.post(ENDPOINT,json=request_body(model,system,user_input,False,1),headers={'Authorization':'Bearer '+api_key()})
    if response.status_code>=400:raise RuntimeError(f'模型连接预热失败（HTTP {response.status_code}）')
    return response.json().get('usage',{})


def generate(model, system, user_input, cancelled, on_speech=None, on_text=None, on_board=None):
    key = api_key()
    if not key: raise RuntimeError('尚未配置方舟 API 密钥')
    body=request_body(model,system,user_input)
    started = time.monotonic()
    raw = ''
    emitted,visible,boards = {},{},set()
    ttft = first_phrase = None
    usage = {}
    board_warnings = []
    completed = False
    if cancelled(): raise InterruptedError('本轮已取消')
    with CLIENT.stream('POST',ENDPOINT,json=body,headers={'Authorization':'Bearer '+key}) as response:
        if response.status_code >= 400:
            response.read()
            try: message = response.json().get('error',{}).get('message','请求被拒绝')
            except ValueError: message = '请求被拒绝'
            raise RuntimeError(f'方舟接口 {response.status_code}：' + str(message).replace(key,'[redacted]')[:400])
        for line in response.iter_lines():
            if cancelled(): raise InterruptedError('本轮已取消')
            if time.monotonic()-started > 120: raise TimeoutError('模型流式回复超时')
            if not line.startswith('data:'): continue
            data = line[5:].strip()
            if data == '[DONE]': break
            event = json.loads(data)
            kind = event.get('type')
            if kind in ('error','response.failed','response.incomplete'):
                raise RuntimeError('方舟没有完成本轮回复：'+str(event.get('error') or event.get('response',{}).get('error') or kind)[:400])
            if kind == 'response.output_text.delta':
                delta = event.get('delta','')
                if not delta: continue
                if ttft is None: ttft = round((time.monotonic()-started)*1000)
                raw += delta
                for step_id,speech,done,ops in step_progress(raw):
                    previous=visible.get(step_id,'')
                    if on_text and speech!=previous:
                        on_text(speech[len(previous):],{'ttft_ms':ttft,'step_id':step_id})
                        visible[step_id]=speech
                    tail=speech[len(emitted.get(step_id,'')):]
                    boundary=phrase_boundary(tail,first=first_phrase is None,done=done)
                    if boundary and on_speech:
                        part=tail[:boundary];emitted[step_id]=emitted.get(step_id,'')+part
                        if first_phrase is None:first_phrase=round((time.monotonic()-started)*1000)
                        on_speech(part,{'ttft_ms':ttft,'step_id':step_id,'sentence_end':done or bool(re.search(r'[.。！？!?](?:\[/(?:慢|快|重读)\])?\s*$',part))})
                    if ops is not None and step_id not in boards:
                        ops=validate_ops(ops,board_warnings);boards.add(step_id)
                        if on_board:on_board(step_id,ops)
            elif kind == 'response.completed':
                completed = True
                usage = event.get('response',{}).get('usage',{})
    if not completed: raise RuntimeError('模型连接提前结束，未收到完成事件')
    clean = raw.strip()
    if clean.startswith('```'): clean = clean.split('\n',1)[-1].rsplit('```',1)[0]
    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError:
        # Recover readable speech and complete visual steps when the metadata
        # tail is malformed. Never retry or replay speech already emitted.
        recovered=[{'speech':speech,'ops':ops or []} for _,speech,_,ops in step_progress(raw) if isinstance(speech,str) and speech.strip()]
        if not recovered: raise
        board_warnings.append('回复尾部格式不完整，已保留可读话术和有效板书；本节暂不判完成')
        parsed={'steps':recovered,'done':False,'section_complete':False}
    result = normalize(parsed,board_warnings)
    spoken=''.join(emitted[k] for k in sorted(emitted))
    if not isinstance(result.get('speech'),str) or not result['speech'].startswith(spoken):
        raise RuntimeError('模型话术的流式输出不一致')
    remainder = result['speech'][len(spoken):]
    if remainder and on_speech: on_speech(remainder,{'ttft_ms':ttft})
    return result, {'provider':'ark','model':model or MODEL,'ttft_ms':ttft,'first_text_ms':first_phrase,
                    'latency_ms':round((time.monotonic()-started)*1000),'usage':usage}
