from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
import tomllib
import local_models
import ark_model
import speech_recognition
import lesson_sections
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
SESSIONS = DATA / "sessions"
AUDIO = DATA / "audio"
EMPTY = DATA / "runtime"
VOICE_MODEL = ROOT / "models" / "whisper-base"
for directory in (SESSIONS, AUDIO, EMPTY):
    directory.mkdir(parents=True, exist_ok=True)

CODEX = os.environ.get("DIALOGUE_CODEX_BIN") or shutil.which("codex")
if not CODEX:
    candidate = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
    CODEX = candidate if Path(candidate).exists() else None
DEFAULT_MODEL = os.environ.get("DIALOGUE_MODEL", "gpt-6-astra")
try:
    conf = tomllib.loads((Path.home() / ".codex/config.toml").read_text())
    DEFAULT_MODEL = os.environ.get("DIALOGUE_MODEL") or conf.get("model") or DEFAULT_MODEL
except (OSError, ValueError):
    pass

REGISTRY: dict[str, "Session"] = {}
REGISTRY_LOCK = threading.Lock()
TTS_LOCK = threading.Lock()
WARMUP = {'llm':'waiting', 'remote':'waiting','tts':'waiting', 'asr':'waiting', 'error':''}


def atomic_json(path: Path, value):
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(path)


def default_config():
    lesson = ROOT / 'content/rubric'
    result = {
        "model": DEFAULT_MODEL,
        "profile": {"background": "我有 3 年产品工作经验。", "goal": "把自己的项目经历讲得清楚、有重点。", "level": "了解 STAR 的名字，但不熟悉具体怎么用。", "preference": "用实际例子解释，表达简洁。"},
        "roles": {
            "lecturer": {
                "name": "一对一讲师", "system": (ROOT / "prompts/lecturer.md").read_text(),
                "task": "讲清如何用 STAR 结构介绍一段项目经历。按背景与目标、个人行动、结果与反思的顺序讲解，每次只讲一小段，可用简短确认和用户插问互动。",
                "material": "示例内容包｜STAR 项目表达\n\n内容边界：这是通用表达方法的演示材料，不是任何公司的官方面试标准。\n\n核心内容：S（情境）说明背景与关键约束；T（任务）说明目标和自己的责任；A（行动）讲清自己做了什么、为什么这么选；R（结果）提供实际结果，区分个人贡献与团队成果。\n\n讲解重点：围绕本次沟通目的选信息；用具体行动替代‘负责、参与、推动’等笼统描述；没有可靠数据时如实说明，不编造提升比例。\n\n可用示例（虚构示例）：一个团队希望改善用户首次使用体验。讲解时可以围绕‘如何定位问题、比较方案、实施验证’展开，不预设收益数字。\n\n轻互动：可询问‘你更容易卡在讲背景，还是讲个人贡献？’，依据实际回答调整。不要安排练习或测验。"
            },
            "interviewer": {
                "name": "Rubric 专题面试", "system": (ROOT / "prompts/interviewer.md").read_text(),
                "task": (lesson / "interview-task.md").read_text(),
                "material": (lesson / "material.md").read_text() + '\n\n' + (lesson / "interview-guide.md").read_text()
            }
        }
    }
    result['roles']['lecturer']['task'] = (lesson / 'user-task.md').read_text().split('## 内容推进')[0].strip()
    result['roles']['lecturer']['course_id'] = 'rubric-intro'
    result['roles']['lecturer']['material'] = (lesson / 'material.md').read_text()
    result['profile']['background'] = '未提供；不推断年龄、年级或专业经历。'
    result['profile']['name'] = '吴同学'
    result['profile']['goal'] = '理解 Rubric 评测流程、逐项判定和汇总规则。'
    result['profile']['level'] = '对 Rubric 的具体了解程度尚未确认。'
    result['provider'] = 'ark' if ark_model.api_key() else 'local' if (local_models.LLM_PATH / '.ready').exists() else 'codex'
    if result['provider'] == 'ark': result['model'] = ark_model.MODEL
    return result


def config():
    try:
        return json.loads((DATA / "config.json").read_text())
    except (OSError, ValueError):
        return default_config()


def short_text(value, maximum=30000):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError("输入内容格式不正确或过长")
    return value


class Session:
    def __init__(self, settings, restored=None):
        self.guard = threading.RLock()
        self.busy = threading.Lock()
        self.process = None
        self.generation = 0
        self.doc = restored or {"id": uuid4().hex, "created": time.time(), "settings": settings, "messages": [], "events": [], "phase": "未开始", "done": False}
        if not restored:
            lesson_sections.attach(self.doc)

    def save(self):
        atomic_json(SESSIONS / f"{self.doc['id']}.json", self.doc)

    def event(self, kind, **fields):
        self.doc["events"].append({"at": time.time(), "kind": kind, **fields})


def session_for(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise ValueError("无效会话")
    with REGISTRY_LOCK:
        if identifier not in REGISTRY:
            path = SESSIONS / f"{identifier}.json"
            if not path.exists():
                raise ValueError("会话不存在，请开始新会话")
            REGISTRY[identifier] = Session(None, json.loads(path.read_text()))
        return REGISTRY[identifier]


def compile_input(doc, event):
    settings = doc["settings"]
    is_interview = settings.get('role') == 'interviewer'
    messages = []
    for message in doc["messages"]:
        if message["role"] == "assistant":
            delivery = message.get("delivery", "text")
            text = message["content"]
            if delivery in ("interrupted", "pending"):
                text = message.get("heard", "") + "\n[运行状态：此轮未完整播报；其余生成内容不能视为用户已听到。]"
            messages.append({"role": "assistant", "content": text})
        else:
            messages.append({"role": "user", "content": message["content"]})
    handled=set(doc.get('handled_user_ids',[]))
    pending=[m['content'] for m in doc['messages'] if m['role']=='user' and m.get('id') not in handled]
    first=event=='start' and not any(m['role']=='assistant' and m.get('heard',m.get('delivery')=='text') for m in doc['messages'])
    action={
        'start':'主动开课：按姓名问候，完整说出课程标题，用第一、第二、第三预告几个方面，再按顺序进入第一部分，await_user=false。不开场问讲解偏好，不考尚未讲过的内容。' if settings.get('role')!='interviewer' else '开始模拟面试：简短问候，说明本次主题后提出一个实质问题，等待候选人作答，不透露参考答案。',
        'user':'回应尚未处理的学生发言；若是在回答老师的问题，先依据真实内容检查判断和理由，充分则确认推进、缺依据只追问、有误针对卡点补讲。若是新问题或反馈，优先回应并调整后续，不重复开场。',
        'continue':'开场预告后先讲第一部分，不考尚未讲授的内容。刚讲清一个关键点且未得到理解证据时，围绕它提一个内容问题并等待；已经答清则按预告顺序推进新点，不问讲解偏好、不重复考。若用户明确跳过检查，继续但不认定已掌握。',
        'silence':'只进行一次中性询问，不重新讲上一轮答案。'
    }[event]
    last_teacher=next((m for m in reversed(doc['messages']) if m['role']=='assistant'),None)
    if event=='continue' and last_teacher and last_teacher.get('phase')!='开场' and not is_interview:
        action='本轮已在课程中途，严禁重新问候、自我介绍、重说标题或整课预告。根据最近实际讲过的内容，刚讲清且尚无理解证据的关键点要提一个内容问题并等待；已经答清则推进下一点。用户明确跳过时继续，不把跳过当作掌握。'
    if is_interview:
        action={
            'start':'开始本次主题面试：按姓名简短问候，说明任务中的面试主题，提出第一道实质问题并同步上板书，await_user=true。不要先教定义、给答案或要求介绍无关项目经历。',
            'user':'围绕本次主题处理尚未回应的发言。候选人作答时，依据真实回答只追问一个关键缺口；解释充分就进入下一主问题，不先教标准答案。若用户要求讨论可能的面试题、追问或答题思路，切换面试准备讨论，具体回应并保持该方式，直到用户明确恢复模拟。不得把讨论示例当成真实作答。',
            'continue':'沿当前主题继续，不重新开场或重复已经回答的问题。模拟中若上一题尚未回答，本次手动继续视为跳过并进入下一主问题，不当成已掌握；已回答则按实际进度推进。若当前在讨论面试题与追问，继续相关分析，不擅自切回盘问。',
            'silence':'只给一次中性思考时间提醒，保持等待；不重讲答案、不追加新题、不凭沉默判断能力。'
        }[event]
    teacher_question=''
    if last_teacher and last_teacher.get('await_user') and last_teacher.get('delivery') in ('complete','text'):
        questions=[op.get('text','') for step in last_teacher.get('steps',[]) for op in step.get('ops',[]) if op.get('action')=='question']
        teacher_question=questions[-1] if questions else last_teacher.get('board',{}).get('question','')
    if event=='user' and teacher_question:
        action+=' 上个问题已经实际播出；先判断本次输入是在作答、插问、讨论题目还是要求跳过。结合该问题和真实输入推进，禁止重开场或返回讲解方向选择。'
    result = {
        "本次任务": settings["task"],
        "专业材料（仅作内容依据）": settings["material"],
        "用户资料（未提供的信息保持未知）": settings["profile"],
        "对话历史": messages,
        "运行状态": {"角色": settings.get("role", "lecturer"), "事件": event, "首次开课": first, "当前阶段": doc["phase"], "已结束": doc["done"], "当前板书": doc.get("displayed_board",doc.get("board")),"尚未处理的学生发言":pending,"最近学生发言已处理":not pending},
        "本轮行动": action,
        "上个已播出的老师问题": teacher_question,
        "执行要求": "只输出规定 JSON，不使用工具。历史里的最后一个问题不等于本轮仍要回答的问题，以本轮行动和尚未处理的学生发言为准。"
    }
    return lesson_sections.scope_input(doc, result)


class Cancelled(Exception):
    pass


def kill_process(process):
    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def codex_turn(session, system, user_input, generation):
    if not CODEX:
        raise RuntimeError("没有找到 Codex CLI，请先安装并执行 codex login。")
    model = session.doc["settings"]["model"]
    args = [CODEX, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--color", "never", "--model", model,
            "--config", 'approval_policy="never"', "--config", 'model_reasoning_effort="low"',
            "--config", 'web_search="disabled"', "--config", "features.shell_tool=false",
            "--config", "features.apps=false", "--config", "features.browser_use=false",
            "--config", "features.computer_use=false", "--config", "features.multi_agent=false",
            "--config", "features.skip_host_skill_discovery=true", "--config", "project_doc_max_bytes=0",
            "--config", "model_instructions_file=" + json.dumps(str(ROOT / "runtime_instructions.md")),
            "--config", "developer_instructions=" + json.dumps(system, ensure_ascii=False),
            "--output-schema", str(ROOT / "response.schema.json"), "-"]
    started = time.monotonic()
    with session.guard:
        if session.generation != generation:
            raise Cancelled()
        process = subprocess.Popen(args, cwd=EMPTY, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        session.process = process
    try:
        stdout, stderr = process.communicate(json.dumps(user_input, ensure_ascii=False), timeout=120)
    except subprocess.TimeoutExpired:
        kill_process(process)
        process.communicate()
        raise RuntimeError("模型超过 120 秒未返回。可重试，或在配置里切换更快的模型。")
    finally:
        with session.guard:
            if session.process is process:
                session.process = None
    with session.guard:
        if session.generation != generation:
            raise Cancelled()
    final = None
    usage = {}
    errors = []
    for line in stdout.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if item.get("type") == "item.completed" and item.get("item", {}).get("type") == "agent_message":
            final = item["item"].get("text")
        if item.get("type") == "turn.completed":
            usage = item.get("usage", {})
        if item.get("type") in ("error", "turn.failed"):
            errors.append(str(item.get("message") or item.get("error", {}).get("message", "模型调用失败")))
    if process.returncode or not final:
        detail = "\n".join(errors) or stderr[-1200:]
        detail = re.sub(r"sk-[\w-]+", "[已隐藏密钥]", detail)
        raise RuntimeError("Codex 调用失败：" + detail[:1200])
    result = json.loads(final)
    if not isinstance(result.get("speech"), str) or not result["speech"].strip():
        raise RuntimeError("模型没有返回可播报内容，请重试")
    if not isinstance(result.get("await_user"), bool) or not isinstance(result.get("done"), bool):
        raise RuntimeError("模型输出格式不正确")
    result["speech"] = result["speech"][:5000]
    return result, {"provider": "codex", "latency_ms": round((time.monotonic() - started) * 1000), "usage": usage, "model": model}


def perform_turn(payload, emit=None):
    session = session_for(payload.get("session_id"))
    if not session.busy.acquire(blocking=False):
        raise ValueError("上一轮正在退出，请稍后再试")
    request_id = short_text(payload.get('request_id', ''), 100)
    message_id = uuid4().hex
    partial = None
    try:
        event = payload.get("event", "user")
        if event not in {"start", "user", "continue", "silence"}:
            raise ValueError("不支持的运行事件")
        with session.guard:
            if session.doc["done"]:
                raise ValueError("本次对话已结束，请开始新会话")
            lesson_sections.prepare(session.doc, event)
            section = lesson_sections.info(session.doc)
            if event == "user":
                text = short_text(payload.get("text", ""), 16000).strip()
                if not text:
                    raise ValueError("请输入内容")
                session.doc["messages"].append({"id": uuid4().hex, "role": "user", "content": text, "at": time.time(), 'section_id': section['id'] if section else None})
            generation = session.generation
            responding_to=[m['id'] for m in session.doc['messages'] if m['role']=='user' and m['id'] not in session.doc.get('handled_user_ids',[])]
            user_input = compile_input(session.doc, event)
            system = session.doc["settings"]["system"]
            session.event("model_start", event=event, request_id=request_id)
            if section and section['enter']:
                session.event('section_user_injected', section_id=section['id'], index=section['index'], reason=session.doc['lesson']['reason'])
            session.doc['active_request_id']=request_id
            session.save()
        if emit: emit({'type':'model_started','message_id':message_id,'request_id':request_id,'section':section})
        def on_text(text,timing):
            if session.generation != generation: raise Cancelled()
            if emit: emit({'type':'text_delta','text':text,**timing})
        def on_speech(text, timing=None):
            nonlocal partial
            with session.guard:
                if session.generation != generation: raise Cancelled()
                if partial is None:
                    partial = {'id':message_id,'role':'assistant','content':'','at':time.time(),'delivery':'pending','heard':'','section_id':section['id'] if section else None}
                    session.doc['messages'].append(partial)
                partial['content'] += text
                session.save()
            if emit:
                try: emit({'type':'speech','text':text,'message_id':message_id, **(timing or {})})
                except (BrokenPipeError, ConnectionResetError):
                    with session.guard: session.generation += 1
                    raise Cancelled()
        def on_board(step_id,ops):
            if session.generation != generation:raise Cancelled()
            if emit:emit({'type':'board_ops','step_id':step_id,'ops':lesson_sections.page_ops(session.doc,ops)})
        if session.doc['settings'].get('provider') == 'ark':
            try:
                result, metrics = ark_model.generate(session.doc['settings']['model'], system, user_input, lambda: session.generation != generation, on_speech if emit else None, on_text if emit else None, on_board if emit else None)
            except InterruptedError: raise Cancelled()
        elif session.doc['settings'].get('provider') == 'local':
            if not (local_models.LLM_PATH / '.downloaded').exists(): raise RuntimeError('本地讲解模型仍在准备')
            try:
                result, metrics = local_models.generate(system, user_input, lambda: session.generation != generation, on_speech if emit else None, on_text if emit else None)
            except InterruptedError: raise Cancelled()
        else:
            result, metrics = codex_turn(session, system, user_input, generation)
        with session.guard:
            if session.generation != generation: raise Cancelled()
        if not isinstance(result.get('speech'),str) or not result['speech'].strip() or not isinstance(result.get('await_user'),bool) or not isinstance(result.get('done'),bool) or not isinstance(result.get('board'),dict):
            raise RuntimeError('模型回复格式不完整，请重试')
        result = lesson_sections.finish(session.doc, result, event, payload.get('text', ''))
        with session.guard:
            if session.generation != generation:
                raise Cancelled()
            message = {"id": message_id, "role": "assistant", "content": result["speech"], "at": time.time(), "delivery": "pending" if session.doc["settings"]["voice"] else "text", "heard": "", "responding_to":responding_to, **result}
            if partial is not None: partial.update(message); message = partial
            else: session.doc["messages"].append(message)
            session.doc["phase"] = result["phase"]
            session.doc["board"] = result.get("board")
            session.doc["done"] = result["done"]
            session.event("model_complete", request_id=request_id, **metrics)
            if result.get('board_warnings'): session.event('board_warning', request_id=request_id, details=result['board_warnings'])
            session.save()
            return {"message": message, "metrics": metrics, "debug": {"system": system, "user": user_input, "output": result}}
    except Cancelled:
        return {"cancelled": True}
    except Exception as exc:
        with session.guard:
            session.event('model_error', request_id=request_id, error=str(exc)[:500]); session.save()
        raise
    finally:
        session.busy.release()


def transcribe(audio):
    if not speech_recognition.ready(): raise RuntimeError('本地识别模型尚未准备好')
    return speech_recognition.transcribe(audio)


def speech_file(text, rate):
    text = short_text(text, 1200).strip()
    if not text:
        raise ValueError("没有可播报的内容")
    rate = max(130, min(260, int(rate)))
    key = hashlib.sha256(f"kokoro-original-language-v3:{local_models.MALE_VOICE}:{rate}:{text}".encode()).hexdigest()
    path = AUDIO / f"{key}.wav"
    with TTS_LOCK:
        if not path.exists():
            if not (local_models.TTS_PATH / '.ready').exists():
                raise RuntimeError('中文男声音色正在准备，暂不使用女声替代。')
            local_models.synthesize(text, path, rate)
    return path


def warm_services():
    """Cold starts happen before the user begins the latency-critical turn."""
    try:
        if (local_models.TTS_PATH / '.downloaded').exists():
            WARMUP['tts'] = 'loading'
            with TTS_LOCK:
                local_models.synthesize('Rubric 是一组具体的检查标准。', AUDIO / 'warmup-male.wav')
            WARMUP['tts'] = 'ready'
        if speech_recognition.ready():
            WARMUP['asr'] = 'loading'
            # The public transcribe path also validates PCM conversion.
            if (AUDIO / 'warmup-male.wav').exists():
                transcribe((AUDIO / 'warmup-male.wav').read_bytes())
            WARMUP['asr'] = 'ready'
        if config().get('provider') == 'local' and (local_models.LLM_PATH / '.downloaded').exists():
            WARMUP['llm'] = 'loading'
            c = config()
            settings = {**c['roles']['lecturer'], 'profile':c['profile']}
            result = local_models.warmup(settings['system'], compile_input(Session(settings).doc, 'start'))
            WARMUP['llm'] = 'ready'
            print('本地模型预热完成：' + json.dumps(result), flush=True)
        if config().get('provider')=='ark' and ark_model.api_key():
            WARMUP['remote']='loading'
            c=config();settings={**c['roles']['lecturer'],'profile':c['profile']}
            ark_model.warmup(c['model'],settings['system'],compile_input(Session(settings).doc,'start'))
            WARMUP['remote']='ready'
            print('课堂语音与模型连接已预热',flush=True)
    except Exception as exc:
        WARMUP['error'] = str(exc)
        for key in ('tts','asr','llm','remote'):
            if WARMUP[key] == 'loading': WARMUP[key] = 'error'
        print('模型预热失败：' + str(exc), flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Do not log user utterances, request bodies, or credentials.
        print(f"{self.log_date_time_string()} {fmt % args}", flush=True)

    def send(self, body, status=200, mime="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def body(self):
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            raise ValueError("仅支持从本地调试页面调用")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 16_000_000:
            raise ValueError("请求过大")
        return self.rfile.read(length)

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/config":
                self.send({"config": config(), "capabilities": {'streaming':True,'ark':bool(ark_model.api_key()),"codex": bool(CODEX), "asr": speech_recognition.ready(), 'asr_model':speech_recognition.model_name(), "tts": (local_models.TTS_PATH / '.ready').exists(), 'local_model':(local_models.LLM_PATH / '.ready').exists(), 'voice':'Kokoro 中文男声 · ' + local_models.MALE_VOICE, 'warmup':dict(WARMUP)}})
            elif path.startswith('/api/progress/'):
                s = session_for(path.rsplit('/',1)[-1])
                with s.guard:
                    self.send({'events':s.doc['events'][-12:], 'generation':s.generation})
            elif path == "/api/sessions":
                records = []
                for file in sorted(SESSIONS.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
                    d = json.loads(file.read_text())
                    records.append({"id": d["id"], "created": d["created"], "role": d["settings"]["role"], "task": d["settings"]["task"], "turns": len(d["messages"]), "done": d["done"]})
                self.send(records)
            elif path.startswith("/api/sessions/"):
                s = session_for(path.rsplit("/", 1)[-1])
                with s.guard:
                    self.send(s.doc)
            else:
                relative = "index.html" if path == "/" else path.lstrip("/")
                file = (ROOT / "static" / relative).resolve()
                if not file.is_relative_to(ROOT / "static") or not file.is_file():
                    self.send({"error": "未找到页面"}, 404)
                    return
                mime = mimetypes.guess_type(file)[0] or "application/octet-stream"
                self.send(file.read_bytes(), mime=mime)
        except Exception as exc:
            self.send({"error": str(exc)}, 400)

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            raw = self.body()
            if path == "/api/transcribe":
                self.send(transcribe(raw))
                return
            data = json.loads(raw or b"{}")
            if path == '/api/turn/stream':
                self.send_response(200); self.send_header('Content-Type','application/x-ndjson; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.send_header('Connection','close'); self.end_headers(); self.close_connection = True
                def emit(item):
                    self.wfile.write((json.dumps(item,ensure_ascii=False)+'\n').encode()); self.wfile.flush()
                try:
                    result = perform_turn(data, emit)
                    emit({'type':'result', 'data':result})
                except (BrokenPipeError, ConnectionResetError): pass
                except Exception as exc:
                    try: emit({'type':'error','error':str(exc)})
                    except (BrokenPipeError, ConnectionResetError): pass
                return
            if path == "/api/config":
                defaults = default_config()
                for role in defaults["roles"]:
                    for field in ("system", "task", "material"):
                        defaults["roles"][role][field] = short_text(data["roles"][role][field])
                defaults["model"] = short_text(data["model"], 150)
                defaults['provider'] = data.get('provider') if data.get('provider') in ('ark','local','codex') else defaults['provider']
                defaults["profile"] = {k: short_text(data.get("profile", {}).get(k, ""), 5000) for k in defaults["profile"]}
                atomic_json(DATA / "config.json", defaults)
                self.send({"saved": True})
            elif path == "/api/session":
                role = data.get("role")
                if role not in ("lecturer", "interviewer"):
                    raise ValueError("请选择讲师或面试官")
                settings = {k: short_text(data.get(k, "")) for k in ("system", "task", "material")}
                model = short_text(data.get("model", DEFAULT_MODEL), 150)
                if not re.fullmatch(r"[a-zA-Z0-9_.:/-]+", model):
                    raise ValueError("模型名称格式不正确")
                provider = data.get('provider') if data.get('provider') in ('ark','local','codex') else config().get('provider','ark')
                settings.update(role=role, model=model, provider=provider, voice=bool(data.get("voice")), profile={k: short_text(data.get("profile", {}).get(k, ""), 5000) for k in ("name","background", "goal", "level", "preference")})
                if data.get('course_id') == 'rubric-intro': settings['course_id'] = 'rubric-intro'
                s = Session(settings)
                s.save()
                with REGISTRY_LOCK:
                    REGISTRY[s.doc["id"]] = s
                self.send({"session_id": s.doc["id"]})
            elif path == "/api/turn":
                self.send(perform_turn(data))
            elif path == '/api/client-event':
                s=session_for(data.get('session_id'))
                kind=data.get('kind')
                if kind not in ('first_audio','board_rendered','playback_complete'): raise ValueError('不支持的客户端事件')
                with s.guard:
                    if kind=='board_rendered' and data.get('request_id')==s.doc.get('active_request_id'):
                        board_state=data.get('board_state')
                        if isinstance(board_state,dict) and len(json.dumps(board_state))<30000:s.doc['displayed_board']=board_state
                    s.event(kind, request_id=short_text(data.get('request_id',''),100), latency_ms=max(0,min(300000,int(data.get('latency_ms',0))))); s.save()
                self.send({'ok':True})
            elif path=='/api/ack':
                s=session_for(data.get('session_id'))
                with s.guard:
                    identifier=uuid4().hex
                    s.doc['messages'].append({'id':identifier,'role':'user','content':short_text(data.get('text',''),1000),'at':time.time()})
                    s.doc.setdefault('handled_user_ids',[]).append(identifier)
                    s.event('student_acknowledgement');s.save()
                self.send({'ok':True})
            elif path in ("/api/cancel", "/api/delivery"):
                s = session_for(data.get("session_id"))
                with s.guard:
                    if path == "/api/cancel":
                        s.generation += 1
                        kill_process(s.process)
                        s.event("interrupted")
                    if isinstance(data.get('board_state'),dict) and len(json.dumps(data['board_state']))<30000:s.doc['displayed_board']=data['board_state']
                    for m in reversed(s.doc["messages"]):
                        if m["role"] == "assistant" and m["id"] == data.get("message_id"):
                            m["delivery"] = "interrupted" if path == "/api/cancel" else "complete"
                            heard = short_text(data.get("heard", ""), 5000)
                            m["heard"] = heard if m["content"].startswith(heard) else ""
                            if path=='/api/delivery' and heard==m['content']:
                                s.doc['handled_user_ids']=list(dict.fromkeys(s.doc.get('handled_user_ids',[])+m.get('responding_to',[])))
                            if path == "/api/cancel" and m.get("done"):
                                s.doc["done"] = False
                            break
                    s.save()
                self.send({"ok": True})
            elif path == "/api/speak":
                self.send(speech_file(data.get("text", ""), data.get("rate", 200)).read_bytes(), mime="audio/wav")
            else:
                self.send({"error": "接口不存在"}, 404)
        except (ValueError, KeyError, TypeError) as exc:
            self.send({"error": str(exc)}, 400)
        except Exception as exc:
            self.send({"error": str(exc)}, 500)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"AI 一对一内容调试台：http://127.0.0.1:{args.port}", flush=True)
    threading.Thread(target=warm_services, name='model-warmup', daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for session in REGISTRY.values():
            kill_process(session.process)
        server.server_close()


if __name__ == "__main__":
    main()
