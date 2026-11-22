import {VoiceInput} from './voice.mjs';
import {renderBoardContent, fitBoardContent} from './board.mjs';
import {initPipeline, step, beginPipeline, markFirstAudio, cancelPipeline} from './pipeline.mjs';
import {resetLiveBoard,displayedBoard,markPageTaught,showStudentQuestion,beginBoardTurn,applyBoardOps,enterSection} from './live-board.mjs';
import {listeningFeedback,clearTeacherGesture} from './teacher-feedback.mjs';
import {prepareBoardCamera,settleBoardCamera,stopBoardCamera} from './board-camera.mjs';
import {initCourseNavigation} from './course-navigation.mjs';

const $ = id => document.getElementById(id);
let config, capabilities, role = 'lecturer', sessionId = null, active = false, voiceMode = false, ended = false;
let epoch = 0, turnSequence = 0, busy = false, requestAbort = null, audio = null, speechAbort = null, playbackResolve = null;
let spokenPrefix = '', currentMessage = null, debugTab = 'events', latestDebug = {}, events = [], timer = null;
let autoStreak = 0, paused = false, startedAt = 0, transcriptDraft = '', transcriptionQueue = Promise.resolve(), cancelBarrier = Promise.resolve();
let toastTimer;
let transcript = [];
let starting = false, resumeMic = false;
let waitingSince = 0;
let pendingAsr = 0, heldPlayback = null;
let inputMode = 'open';
let currentRequestId = '', lastVoiceEndAt = 0;
let turnInFlight = false, firstAudioForTurn = false, queuedInputs = [];
initPipeline();
initCourseNavigation();
function inputReceipt(text, state) {
  $('inputReceipt').hidden=false; $('inputReceiptText').textContent=text; $('inputReceiptText').title=text; $('inputReceiptState').textContent=state;
  $('queuedInputCount').textContent=queuedInputs.length ? `已收补充 ${queuedInputs.length} 条` : '';
}
async function submitUserInput(text, input = {}) {
  if (!active) { await start(false,text); return; }
  // Protect both model generation and the path to its first audio. A later
  // utterance is a new input, not permission to discard in-flight inference.
  if (busy || turnInFlight) {
    queuedInputs.push({text,input}); inputReceipt(text,'已收到 · 排入下一轮');
    showStudentQuestion('queued',text);
    subtitle('你',text,`补充已收 ${queuedInputs.length} 条 · 当前生成继续`);
    log('补充发言已入队','当前模型请求和首声计时保持不变'); resumeHeldSpeech(); return;
  }
  inputReceipt(text,'正在提交'); await interrupt('回应新的用户发言',false); runTurn('user',text,input);
}
function flushQueuedInputs() {
  if (!active || busy || !queuedInputs.length) return false;
  const inputs=queuedInputs.splice(0), text=inputs.map(item=>item.text).join('\n');
  inputReceipt(text,'正在提交补充'); runTurn('user',text,inputs[0].input); return true;
}
const speaker = new Audio();
const SPEECH_RATE_KEY = 'classroom.speechRateMultiplier.v1';
const DEFAULT_SPEECH_RATE = 1.2;
const TTS_BASE_RATE = 200;
function setSpeechRate(value, remember = false) {
  const parsed = Number(value);
  const rate = Number.isFinite(parsed) && parsed >= .75 && parsed <= 2 ? parsed : DEFAULT_SPEECH_RATE;
  $('speechRate').value = String(rate);
  $('speechRateValue').textContent = `${rate.toFixed(2)}×`;
  $('speechRate').setAttribute('aria-valuetext', `${rate.toFixed(2)} 倍`);
  speaker.defaultPlaybackRate = rate;
  speaker.playbackRate = rate;
  speaker.preservesPitch = true;
  if (remember) { try { localStorage.setItem(SPEECH_RATE_KEY, String(rate)); } catch { /* The control still works when browser storage is unavailable. */ } }
}
let savedSpeechRate = DEFAULT_SPEECH_RATE;
try { savedSpeechRate = localStorage.getItem(SPEECH_RATE_KEY) ?? DEFAULT_SPEECH_RATE; } catch { /* Use the classroom default. */ }
setSpeechRate(savedSpeechRate);
const classroomChannel = new BroadcastChannel('ai-one-to-one-classroom');
classroomChannel.onmessage = () => { if (active) reset().then(() => toast('已切换到另一个课堂页面，本页麦克风已关闭。')); };
function resumeHeldSpeech() {
  if (heldPlayback && heldPlayback === audio && active && !paused) heldPlayback.play().catch(e => toast('恢复播报失败：' + e.message, true));
  heldPlayback = null;
}
function subtitle(who, text, state = '') {
  $('captionWho').textContent = who;
  $('captionText').textContent = who === '你' ? text : text.replace(/\[(?:\/?(?:重读|慢|快)|停顿[:：]\d+)\]/g,'').replace(/\[[^\]]*$/,'');
  $('captionState').textContent = state;
  $('captionBar').dataset.speaker = who === '你' ? 'user' : 'teacher';
}
function teacherState(type = 'idle') {
  if(type === 'listening' || type === 'thinking') clearTeacherGesture();
  $('teacherAvatar').dataset.state = type;
  const label = {speaking: role==='interviewer'?'面试交流中':'正在讲解', listening: '在听你说', thinking: '正在组织回应', idle: '三茅老师'}[type] || '三茅老师';
  $('teacherState').textContent = label; $('teacherAvatar').setAttribute('aria-label', '三茅老师，' + label);
}
async function unlockSpeaker() {
  if (!speaker.src) {
    speaker.src = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAA==';
    try { await speaker.play(); speaker.pause(); } catch { /* Actual playback reports any permission error. */ }
  }
}

function toast(text, error = false) { $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 8000 : 3000); }
async function api(path, body, options = {}) {
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function log(kind, detail = '') { events.push(`${new Date().toLocaleTimeString('zh-CN')}  ${kind}${detail ? '\n  ' + detail : ''}`); renderDebug(); }
function renderDebug() { const value = debugTab === 'events' ? events.join('\n\n') || '等待开始对话。' : debugTab === 'transcript' ? transcript.map(m => `${m.who === 'user' ? '你' : 'AI'}${m.interrupted ? '（播报被打断）' : ''}\n${m.text}`).join('\n\n') || '开始后可在这里查看隐藏的对话记录。' : latestDebug[debugTab]; $('debugContent').textContent = typeof value === 'string' ? value : value ? JSON.stringify(value, null, 2) : '本轮尚未产生数据。'; if (debugTab === 'events') $('debugContent').scrollTop = $('debugContent').scrollHeight; }
function status(title, detail, type = '') { $('statusTitle').textContent = title; $('statusDetail').textContent = detail; $('stage').className = `stage ${active ? 'compact' : ''} ${type}`; if (type !== 'speaking') teacherState(type || 'idle'); }
function profile() { return Object.fromEntries(['name','background', 'goal', 'level', 'preference'].map(k => [k, $(k).value])); }
function captureConfig() { if (!config) return; for (const field of ['system', 'task', 'material']) config.roles[role][field] = $(field).value; config.profile = profile(); config.model = $('model').value.trim(); config.provider = $('provider').value; }
function renderRole() {
  const preset = config.roles[role];
  for (const field of ['system', 'task', 'material']) $(field).value = preset[field];
  document.querySelectorAll('[data-role]').forEach(b => { b.classList.toggle('active', b.dataset.role === role); b.setAttribute('aria-pressed', String(b.dataset.role === role)); });
  document.body.dataset.mode=role;
  const rubric=/Rubric/i.test(preset.task),isInterview=role==='interviewer';
  $('sessionTitle').textContent = rubric ? 'Rubric 评测课堂' : isInterview ? '专题面试教室' : '一对一讲解教室';
  $('lessonIntroduction').textContent = rubric ? isInterview ? '本节：Rubric · 可能的面试题与针对性追问' : '本节：Rubric · 评测流程与判断依据' : '围绕本次任务，进行一对一交流';
  $('messageInput').placeholder=isInterview?'输入回答，或问“这部分面试可能怎么追问？”':'输入问题，老师仍会语音讲解并更新板书。Enter 发送';
  $('messageInput').setAttribute('aria-label',isInterview?'文字作答或讨论面试题':'文字提问，老师语音回答');
  if (!active) {
    renderBoard();
    subtitle(isInterview?'面试':'课堂',isInterview?'点击“开始面试”，围绕本节 Rubric 逐题作答；也可以先讨论可能的题目与追问。':'点击“开始上课”，老师会主动讲解；也可以先文字提问。','准备就绪');
    status('准备好就开始',isInterview?'本节 Rubric：一题一答，追问依据你的回答。':'老师会用语音讲解，并同步更新板书。');
  }
  controls();
}
function renderBoard(board = null) {
  $('liveBoard').hidden=true;$('boardDetails').hidden=false;
  const isInterview = role === 'interviewer';
  $('boardMode').textContent = isInterview ? '面试模式' : '讲解模式';
  $('liveTeacherQuestionLabel').textContent = isInterview ? '面试问题' : '说说你的理解';
  $('boardQuestionLabel').textContent = isInterview ? '当前问题' : '轻互动';
  const rubric = /Rubric/i.test($('task').value);
  const topic=isInterview ? rubric ? '围绕 Rubric，练习面试表达' : '围绕本次主题，逐题作答' : rubric ? '从一条回复看懂评测' : '今天，我们一起讲清楚';
  $('boardTitle').textContent = board?.title || topic;
  $('boardTopic').textContent = board?.title || topic;
  $('boardCourse').textContent = rubric ? isInterview ? 'Rubric 专题面试' : 'Rubric 评测课堂' : isInterview ? '专题面试' : '一对一讲解';
  $('boardTaskPreview').textContent = rubric ? isInterview ? '为什么用 Rubric？怎样设计公平对比？\n从你的回答出发，练习判断依据、取舍与追问。' : '先看评测流程，再看检查标准与汇总规则。\n最后，用你提供的爬楼案例把它们串起来。' : $('task').value.slice(0, 160);
  $('boardStandby').querySelector('span').textContent=isInterview?'逐题提问，等你回答。也可以直接讨论“面试会怎样问、怎样追问”。':'跟着讲解，一步步看清楚。随时开口，也可以用文字提问。';
  $('boardStandby').hidden = !!board;
  renderBoardContent(board);
}
function fitBoard() {
  const bounds = $('boardStage').getBoundingClientRect();
  const width = Math.max(1, Math.min(bounds.width, bounds.height * 16 / 9));
  $('blackboard').style.width = `${width}px`;
  $('blackboard').style.height = `${width * 9 / 16}px`;
  $('blackboard').style.setProperty('--board-scale', String((width - 2) / 1200));
  fitBoardContent();
}
new ResizeObserver(fitBoard).observe($('boardStage'));
function controls() {
  const remoteReady=config?.provider!=='ark'||!capabilities.warmup?.remote||['ready','error'].includes(capabilities.warmup.remote);
  const ready = !!config && !!capabilities.tts && (!capabilities.warmup || capabilities.warmup.tts === 'ready') && remoteReady;
  $('startVoice').disabled = starting || !ready;
  $('startVoice').textContent = ready ? role==='interviewer'?'开始面试':'开始上课' : capabilities.warmup?.error ? '课堂准备失败' : '课堂正在准备…';
  $('startActions').hidden = active;
  $('messageInput').disabled = !config || ended || starting || (!active && !ready);
  $('sendButton').disabled = !config || ended || starting || (!active && !ready);
  $('micButton').disabled = !active || ended;
  $('interruptButton').disabled = !active || ended;
  $('continueButton').disabled = !active || busy || ended;
  $('exportButton').disabled = !sessionId;
  $('micButton').textContent = mic.active ? '麦克风：开启' : '麦克风：关闭';
  $('micButton').classList.toggle('on', mic.active);
  $('micButton').hidden = inputMode !== 'open';
  if(!mic.active) listeningFeedback('off');
  else if(['off','ready'].includes($('listeningFeedback').dataset.state)) listeningFeedback('ready');
}
async function selectInputMode(mode) {
  if (mode === inputMode) { if (mode === 'text') $('messageInput').focus(); return; }
  await mic.stop(); resumeHeldSpeech(); inputMode = mode;
  document.querySelectorAll('[data-input-mode]').forEach(b => { const selected = b.dataset.inputMode === mode; b.setAttribute('aria-checked', String(selected)); b.classList.toggle('selected', selected); });
  $('messageForm').hidden = mode !== 'text'; $('textToggle').setAttribute('aria-expanded', String(mode === 'text'));
  if (mode === 'text') $('messageInput').focus();
  if (mode === 'open' && active && !ended && !paused) { try { await mic.start(); } catch(e) { toast(e.message, true); } }
  controls();
}
function addMessage(who, text, id = '') {
  transcript.push({who, text, id}); renderDebug();
}
function stopPlayback() {
  clearTeacherGesture();
  stopBoardCamera();
  heldPlayback = null;
  speechAbort?.abort(); speechAbort = null;
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; }
  playbackResolve?.(false); playbackResolve = null;
  teacherState();
}
async function interrupt(reason = '用户打断', pause = true) {
  clearTimeout(timer); paused = pause;
  const wasSpeaking = !!audio || !!speechAbort;
  const wasRunning = busy || wasSpeaking;
  ++turnSequence; requestAbort?.abort(); requestAbort = null; busy = false;
  stopPlayback();
  cancelPipeline();
  waitingSince = 0;
  if (sessionId && (wasRunning || currentMessage)) {
    const id = sessionId;
    const messageId = wasSpeaking ? currentMessage?.id : undefined;
    const heard = spokenPrefix;
    const board_state=displayedBoard();
    cancelBarrier = cancelBarrier.catch(() => {}).then(() => api('/api/cancel', {session_id: id, message_id: messageId, heard,board_state})).catch(e => log('中断状态同步失败', e.message));
    await cancelBarrier;
    if (wasRunning && messageId) {
      const entry = transcript.find(m => m.id === messageId);
      if (entry) entry.interrupted = true;
      renderDebug();
    }
  }
  if (wasRunning) log(reason, '已停止生成 / 播报，保留实际已播出的完整句子。');
  if (active) status(pause ? '已暂停，等你开口' : '正在听你说', pause ? '随时说话，或点击“继续”。' : '说完后稍作停顿，会自动提交。', 'listening');
  controls();
}
async function speechBlob(text, signal) {
  step('tts','running','正在合成下一段');
  try {
    // Keep one synthesis speed so current and prefetched audio respond to the
    // same playback control immediately, without another synthesis request.
    const r = await fetch('/api/speak', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text, rate: TTS_BASE_RATE}), signal});
    if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
    const blob = await r.blob(); if (signal.aborted) throw new DOMException('Aborted','AbortError');
    step('tts','done',`音频已返回 · ${Math.round(blob.size/1024)} KB`); return blob;
  } catch(e) { if (e.name !== 'AbortError') step('tts','error',e.message); throw e; }
}
async function playChunk(blob, text, sequence, runEpoch, onPlaying, beforePlay) {
  while (firstAudioForTurn && (mic.speaking || pendingAsr > 0)) { await new Promise(r => setTimeout(r,80)); if (sequence !== turnSequence || runEpoch !== epoch) return false; }
  if (!active || sequence !== turnSequence || runEpoch !== epoch) return false;
  if(beforePlay && !await beforePlay())return false;
  const url = URL.createObjectURL(blob), player = speaker; player.src=url; audio=player;
  setSpeechRate($('speechRate').value);
  status('老师正在讲解', mic.active ? '麦克风保持开启，可以随时提问。' : '可以文字提问，或切换输入方式。', 'speaking');
  try {
    const finished = await new Promise((resolve,reject) => {
      playbackResolve=resolve;
      player.onplaying=()=>{
        settleBoardCamera();
        firstAudioForTurn=true;
        onPlaying?.();
        teacherState('speaking'); subtitle('老师',text.trim(),'正在讲解'); step('play','running','正在播放');
        const latency = markFirstAudio();
        if (latency !== null && capabilities.streaming) api('/api/client-event',{session_id:sessionId,request_id:currentRequestId,kind:'first_audio',latency_ms:latency}).catch(()=>{});
      };
      player.onended=()=>{teacherState();resolve(true);};
      player.onerror=()=>reject(new Error('浏览器音频播放失败'));
      player.play().catch(reject);
    });
    if (!finished || sequence !== turnSequence || runEpoch !== epoch) return false;
    spokenPrefix+=text; return true;
  } catch(e) { step('play','error',e.message); throw e; }
  finally { URL.revokeObjectURL(url); if(audio===player) audio=null; playbackResolve=null; }
}
async function speak(message, sequence, runEpoch) {
  const chunks = message.content.match(/[^。！？!?]+[。！？!?]?/g) || [message.content];
  spokenPrefix = ''; speechAbort = new AbortController(); const controller = speechAbort;
  let pending = speechBlob(chunks[0], controller.signal);
  // Attach a handler immediately: cancellation while current audio plays must not cause an unhandled rejection.
  pending.catch(() => {});
  try {
    for (let i = 0; i < chunks.length; i++) {
      const blob = await pending;
      if (!active || sequence !== turnSequence || runEpoch !== epoch) return false;
      if (i + 1 < chunks.length) { pending = speechBlob(chunks[i + 1], controller.signal); pending.catch(() => {}); }
      if (!await playChunk(blob,chunks[i],sequence,runEpoch)) return false;
    }
    if (sequence !== turnSequence || runEpoch !== epoch) return false;
    await api('/api/delivery', {session_id: sessionId, message_id: message.id, heard: message.content});
    step('play','done','整轮播报完成'); log('播报完成'); return true;
  } finally { if (speechAbort === controller) speechAbort = null; }
}
function scheduleNext(result, runEpoch) {
  clearTimeout(timer);
  if (!active || paused || runEpoch !== epoch || mic.speaking) return;
  if (result.done) { status('本次对话已结束', '可以导出记录，或开始新会话。'); log('对话结束'); paused = true; ended = true; mic.stop().then(controls); controls(); return; }
  status(result.await_user ? '等你回答' : mic.active ? '正在听你说' : '等你提问', result.await_user ? '说说你的判断和理由，也可以告诉老师卡在哪里。' : mic.active ? '直接开口，也可以文字提问。' : '可开启麦克风，或用文字提问；老师会语音回答。', 'listening');
  if (!$('autoAdvance').checked) return;
  if (!result.await_user && autoStreak < 4) {
    timer = setTimeout(() => { if (!busy && !mic.speaking && !paused && active && epoch === runEpoch) { autoStreak++; runTurn('continue'); } }, voiceMode ? 1500 : 2800);
  } else if (result.await_user && role === 'interviewer' && voiceMode && mic.active) {
    // One neutral prompt only; the response to a silence event never schedules another silence event.
    timer = setTimeout(() => { if (!busy && !mic.speaking && !paused && active && epoch === runEpoch) runTurn('silence'); }, 25000);
  }
}
async function runTurn(event, text = '', input = {}) {
  if (!active || !sessionId || busy || ended) return;
  await cancelBarrier;
  const runEpoch = epoch; const sequence = ++turnSequence; const id = sessionId;
  clearTimeout(timer); paused = false; busy = true; controls();
  turnInFlight=true; firstAudioForTurn=false;
  prepareBoardCamera();
  beginPipeline(event === 'user' ? input.source || 'text' : 'start', input.at || performance.now());
  if (input.source === 'voice') step('asr','done',`${input.asr_ms} ms · 已识别`);
  step('submit','running','等待服务端接收'); step('model','idle');
  currentRequestId = crypto.randomUUID(); spokenPrefix=''; currentMessage=null;
  const requestId=currentRequestId;
  requestAbort = new AbortController(); const controller = requestAbort;
  if (event === 'user') { autoStreak = 0; addMessage('user', text); subtitle('你', text, '已提交 · 老师思考中'); showStudentQuestion('received',text); }
  else {showStudentQuestion('','');subtitle('老师', event === 'start' ? '正在准备 Rubric 的第一段讲解…' : '正在准备下一段讲解…', '生成中');}
  waitingSince = Date.now();
  status(role==='interviewer'?'面试官正在组织回应':'老师正在组织讲解', '结合本节材料与实际对话，准备语音和板书。', 'thinking');
  log('调用讲解模型', event === 'start' ? '主动开场' : event === 'continue' ? '继续讲解' : event === 'silence' ? '长时间静默，进行一次中性询问' : '回应用户输入');
  let streamed = false, playbackChain = Promise.resolve(), draftSpeech='';
  let activeBoardStep=-1,courseCorrection=false,sentenceFinished=false,turnSection=null;
  async function checkpoint(){
    if(!sentenceFinished||!queuedInputs.length)return true;
    const acknowledgements=queuedInputs.every(item=>/^(嗯+|好+|好的|好呀|对|对的|是的|继续|继续讲|你继续|你继续讲|没事你继续讲)[，。！？!?.\s]*$/.test(item.text.trim()));
    if(acknowledgements){
      const received=queuedInputs.splice(0).map(item=>item.text).join('，');
      inputReceipt(received,'已收到 · 接着讲');
      api('/api/ack',{session_id:id,text:received}).catch(e=>log('确认记录失败',e.message));return true;
    }
    courseCorrection=true;
    inputReceipt(queuedInputs.map(item=>item.text).join('；'),'本句已讲完 · 正在调整后续');
    log('句尾检查','检测到学生补充；后续未播出的讲解不再播放。');
    return false;
  }
  const boardOps=new Map(),appliedBoardSteps=new Set();
  function revealBoardStep(stepId){
    if(turnSection&&enterSection(turnSection)){
      log('进入下一节',`${turnSection.index}/${turnSection.total} · ${turnSection.title} · 已注入本节 User`);
      api('/api/client-event',{session_id:id,request_id:requestId,kind:'board_rendered',board_state:displayedBoard()}).catch(()=>{});
    }
    activeBoardStep=stepId;
    if(event==='user'&&!queuedInputs.length)showStudentQuestion('answering',text);
    if(!boardOps.has(stepId)||appliedBoardSteps.has(stepId))return;
    let board_state;
    appliedBoardSteps.add(stepId);
    try { board_state=applyBoardOps(boardOps.get(stepId)); }
    catch(e) { log('板书操作已跳过',e.message+'；语音讲解继续。');step('board','error','本步已跳过 · 讲解继续');return; }
    step('board','running',`跟随讲解 · 第 ${stepId+1} 步`);
    api('/api/client-event',{session_id:id,request_id:requestId,kind:'board_rendered',board_state}).catch(()=>{});
  }
  const streamSpeech = new AbortController();
  try {
    let result;
    const payload = {session_id:id,event,text,request_id:currentRequestId};
    if (capabilities.streaming) {
      speechAbort=streamSpeech;
      const response=await fetch('/api/turn/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
      if (!response.ok) throw new Error((await response.json()).error);
      const reader=response.body.getReader(),decoder=new TextDecoder(); let buffer='';
      while (true) {
        const read=await reader.read(); buffer+=decoder.decode(read.value || new Uint8Array(),{stream:!read.done});
        let newline;
        while ((newline=buffer.indexOf('\n'))>=0) {
          const line=buffer.slice(0,newline); buffer=buffer.slice(newline+1); if(!line.trim()) continue;
          const item=JSON.parse(line);
          if(sequence!==turnSequence || runEpoch!==epoch) return;
          if(item.type==='model_started') { turnSection=item.section||null;step('submit','done',turnSection?.enter?`已注入第 ${turnSection.index} 节 User`:'服务端已接收'); if(event==='user' && !queuedInputs.length) inputReceipt(text,'模型已接收'); step('model','running'); currentMessage={id:item.message_id,content:''}; }
          if(item.type==='text_delta') {
            waitingSince=0;
            draftSpeech+=item.text; step('model','running',`首字 ${(item.ttft_ms/1000).toFixed(2)}s · 生成中`);
            $('ttftMetric').textContent=`TTFT：${(item.ttft_ms/1000).toFixed(2)}s`;
            if(!firstAudioForTurn && draftSpeech) subtitle('三茅老师',draftSpeech,'文字生成中 · 首段语音准备中');
          }
          if(item.type==='speech') {
            streamed=true; currentMessage.content+=item.text; step('model','running',item.ttft_ms === undefined ? '已出话术 · 继续生成' : `首字 ${(item.ttft_ms/1000).toFixed(2)}s · 生成中`);
            const chunk=speechBlob(item.text,streamSpeech.signal); chunk.catch(()=>{});
            playbackChain=playbackChain.then(async()=>{
              if(courseCorrection)return false;
              const blob=await chunk;
              const played=await playChunk(blob,item.text,sequence,runEpoch,()=>revealBoardStep(item.step_id??0),checkpoint);
              if(played){sentenceFinished=item.sentence_end??/[.。！？!?]\s*$/.test(item.text);await checkpoint();}
              return played;
            }); playbackChain.catch(()=>{});
          }
          if(item.type==='board_ops') {boardOps.set(item.step_id,item.ops);if(item.step_id===activeBoardStep)revealBoardStep(item.step_id);}
          if(item.type==='result') result=item.data;
          if(item.type==='error') throw new Error(item.error);
        }
        if(read.done) break;
      }
      if(!result) throw new Error('模型连接结束，未收到完整回复');
    } else {
      // Compatibility while an older local service is finishing its current session.
      result = await api('/api/turn',payload,{signal:controller.signal});
      step('submit','done','服务端已返回');
    }
    if (runEpoch !== epoch || sequence !== turnSequence || result.cancelled) return;
    waitingSince = 0; busy = false; controls(); latestDebug = result.debug; currentMessage = result.message;
    step('model','done',`${(result.metrics.latency_ms/1000).toFixed(1)}s · 回复完整`);
    if(Number.isFinite(result.metrics.ttft_ms))$('ttftMetric').textContent=`TTFT：${(result.metrics.ttft_ms/1000).toFixed(2)}s`;
    $('phase').textContent = result.message.phase;
    $('latency').textContent = `${(result.metrics.latency_ms / 1000).toFixed(1)} 秒`;
    $('adaptation').textContent = result.message.adaptation || '模型未提供调整说明。';
    $('connection').textContent = result.metrics.provider === 'ark' ? 'DeepSeek 流式 · 中文男声' : result.metrics.provider === 'local' ? '本地模型已连接' : 'Codex 已连接';
    log('模型已返回', `${result.metrics.latency_ms} ms · ${result.message.phase}`); renderDebug();
    if(result.message.board_warnings?.length)log('板书兼容处理',result.message.board_warnings.join('；')+'。语音讲解继续。');
    addMessage('assistant', result.message.content, result.message.id);
    if(!result.message.steps){renderBoard(result.message.board);requestAnimationFrame(()=>{if(sequence===turnSequence) step('board','done','已呈现');});}
    if (!streamed) subtitle('老师', result.message.content, '正在准备语音');
    if (streamed) {
      await playbackChain;
      if(sequence!==turnSequence || runEpoch!==epoch) return;
      if(courseCorrection && spokenPrefix!==result.message.content){
        streamSpeech.abort();
        await api('/api/cancel',{session_id:id,message_id:result.message.id,heard:spokenPrefix,board_state:displayedBoard()});
        setTimeout(flushQueuedInputs,0);return;
      }
      await api('/api/delivery',{session_id:id,message_id:result.message.id,heard:spokenPrefix,board_state:displayedBoard()});
      if(result.message.steps){markPageTaught();step('board','done','已随讲解逐步呈现');api('/api/client-event',{session_id:id,request_id:requestId,kind:'board_rendered',board_state:displayedBoard()}).catch(()=>{});}
      step('play','done','整轮播报完成'); log('播报完成');
      if(event==='user'&&!queuedInputs.length)showStudentQuestion('answered','');
    } else if (voiceMode) {
      const completed = await speak(result.message, sequence, runEpoch);
      if (!completed) return;
    } else spokenPrefix = result.message.content;
    if(runEpoch===epoch && sequence===turnSequence && queuedInputs.length) setTimeout(flushQueuedInputs,0);
    else if (runEpoch === epoch && sequence === turnSequence && event !== 'silence') scheduleNext(result.message, runEpoch);
    else if (event === 'silence') status('留一点时间思考', '准备好后直接开口，不会继续催促。', 'listening');
  } catch (e) {
    streamSpeech.abort();
    if (e.name !== 'AbortError' && runEpoch === epoch && sequence === turnSequence) { await interrupt('停止失败轮次');turnInFlight=false;step('model','error',e.message); toast(e.message, true); log('运行出错', e.message); paused = true; status('这一轮没有完成', '点击“继续”重试，错误详情可在运行检查中查看。'); $('captionState').textContent = '本轮失败，可重试'; }
  } finally { if(speechAbort===streamSpeech) speechAbort=null; if (sequence === turnSequence) { turnInFlight=false; waitingSince = 0; busy = false; requestAbort = null; controls(); } }
}

const mic = new VoiceInput({
  onStart: () => {
    if (!active) return;
    clearTimeout(timer);
    if (audio && !audio.paused) { heldPlayback = audio; audio.pause(); }
    $('liveTranscript').textContent = '正在听…'; subtitle('你', '正在听你说话…', '收音中');
    showStudentQuestion('listening','请说，我在听。');
    listeningFeedback('listening');
    step('capture','running','正在收音');
    status('正在听你说', '说完后自动识别并提交。', 'listening');
  },
  onLevel: value => {
    if(active && mic.active && mic.speaking) listeningFeedback('listening',value);
    else if(!mic.active || !active) listeningFeedback('off');
    else if($('listeningFeedback').dataset.state === 'listening') listeningFeedback(pendingAsr ? 'recognizing' : 'ready');
  },
  onDiscard: () => { listeningFeedback(mic.active ? 'ready' : 'off'); if (active) { $('liveTranscript').textContent = ''; resumeHeldSpeech(); if (busy) { status('老师正在组织讲解', '刚才的短声音没有中断老师。', 'thinking'); } else if (!audio && currentMessage && !paused) scheduleNext(currentMessage, epoch); } },
  onSegment: (wav, final, timing = {}) => {
    const runEpoch = epoch;
    if(final) { lastVoiceEndAt=timing.endedAt || performance.now(); step('capture','done','录音已发送'); }
    pendingAsr++;
    if(final) listeningFeedback('recognizing');
    transcriptionQueue = transcriptionQueue.catch(() => {}).then(async () => {
      if (!active || runEpoch !== epoch) return;
      $('liveTranscript').textContent = transcriptDraft || '正在本地识别语音…';
      subtitle('你', transcriptDraft || '正在把刚才的声音转成文字…', '识别中');
      showStudentQuestion('recognizing',transcriptDraft||'正在识别，请稍候。');
      step('asr','running');
      status('正在识别你的语音', '识别完成后会自动提交给老师。', 'listening');
      try {
        const response = await fetch('/api/transcribe', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: wav});
        const result = await response.json(); if (!response.ok) throw new Error(result.error);
        if (!active || runEpoch !== epoch) return;
        transcriptDraft += result.text;
        step('asr','done',`${result.model || 'Whisper'} · ${result.latency_ms} ms`);
        log('本地语音识别', `${result.model || 'Whisper'} · ${result.latency_ms} ms${result.text ? '' : ' · 未检测到有效语音'}`);
        $('liveTranscript').textContent = transcriptDraft;
        subtitle('你', transcriptDraft || '没有识别到有效语音。', final ? '识别完成' : '继续听你说');
        if (final && !mic.speaking) {
          const text = transcriptDraft.trim(); transcriptDraft = ''; $('liveTranscript').textContent = '';
          if (text) { listeningFeedback('received'); await submitUserInput(text,{source:'voice',asr_ms:result.latency_ms,at:lastVoiceEndAt}); }
          else { listeningFeedback('error'); resumeHeldSpeech(); subtitle('你', '没有识别到有效内容，这次没有提交。', '请再说一次'); status(busy ? '老师正在组织讲解' : '正在听你说', '未识别到有效内容，保留原来的讲解。', busy ? 'thinking' : 'listening'); }
        }
      } catch (e) { listeningFeedback('error'); step('asr','error',e.message); resumeHeldSpeech(); toast('语音识别失败：' + e.message, true); log('语音识别失败', e.message); $('liveTranscript').textContent = ''; subtitle('你', '这次识别失败，没有提交。可重说或文字提问。', '识别失败'); }
    }).finally(() => { pendingAsr = Math.max(0, pendingAsr - 1); });
  }
});

async function start(useMic = true, firstText = '') {
  if (!config || active || starting) return;
  if (useMic && !capabilities.asr) {
    try { capabilities = (await api('/api/config')).capabilities; } catch(e) { toast(e.message, true); return; }
    if (!capabilities.asr) { toast('语音识别模型尚未准备好，可以先文字提问，老师仍会语音回答。'); return; }
  }
  starting = true; $('startVoice').disabled = true; controls();
  try {
    classroomChannel.postMessage('starting');
    await unlockSpeaker(); captureConfig(); voiceMode = true;
    if (useMic) { status('正在打开麦克风', '请在浏览器提示中允许访问麦克风。'); await mic.start(); }
    const result = await api('/api/session', {role, ...config.roles[role], model: config.model, provider: config.provider || 'ark', profile: profile(), voice: true});
    sessionId = result.session_id; active = true; paused = false; ended = false; autoStreak = 0; startedAt = Date.now(); ++epoch;
    $('sessionMeta').textContent = `本机会话 · ${sessionId.slice(0, 8)}`;
    controls(); log('会话开始', `${config.roles[role].name} · ${useMic ? '全开麦' : '文字提问 + 语音回答'}`);
    runTurn(firstText ? 'user' : 'start', firstText);
  } catch (e) { await mic.stop(); toast(e.message, true); status('暂时无法开始', e.message); }
  finally { starting = false; controls(); }
}
async function reset() {
  queuedInputs=[]; turnInFlight=false; $('inputReceipt').hidden=true; $('queuedInputCount').textContent='';
  ++epoch; await interrupt('结束当前会话'); active = false; ended = false; await mic.stop(); sessionId = null; currentMessage = null; latestDebug = {}; events = []; autoStreak = 0; transcriptDraft = ''; startedAt = 0;
  transcript = []; resetLiveBoard(); renderBoard(); $('liveTranscript').textContent = ''; $('phase').textContent = '未开始'; $('latency').textContent = '—'; $('elapsed').textContent = ''; $('sessionMeta').textContent = '板书在课堂展示 · 对话记录默认隐藏';
  subtitle('课堂', '点击“开始上课”，老师会主动讲解；也可以先文字提问。', '准备就绪');
  $('adaptation').textContent = '开始后，显示模型依据哪些已知信息调整表达。'; renderDebug(); renderRole();
}

document.querySelectorAll('[data-role]').forEach(b => b.addEventListener('click', async () => { if (!config || starting || role === b.dataset.role) return; captureConfig(); await reset(); role = b.dataset.role; renderRole(); }));
document.querySelectorAll('[data-pane]').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('[data-pane]').forEach(t => { t.classList.toggle('selected', t === b); t.setAttribute('aria-selected', String(t === b)); $(t.dataset.pane).hidden = t !== b; }); }));
document.querySelectorAll('[data-debug]').forEach(b => b.addEventListener('click', () => { debugTab = b.dataset.debug; document.querySelectorAll('[data-debug]').forEach(t => { t.classList.toggle('selected', t === b); t.setAttribute('aria-selected', String(t === b)); }); renderDebug(); }));
$('startVoice').onclick = () => start(inputMode === 'open');
$('newButton').onclick = () => reset();
$('interruptButton').onclick = async () => { resumeMic = mic.active; await interrupt('暂停课堂'); await mic.stop(); status('课堂已暂停', '点击“继续”接着讲，或用文字提问。'); controls(); };
$('continueButton').onclick = async () => { await unlockSpeaker(); await interrupt('手动继续', false); if (resumeMic) { try { await mic.start(); } catch (e) { toast(e.message, true); } resumeMic = false; } autoStreak = 0; if(!flushQueuedInputs()) runTurn('continue'); };
$('micButton').onclick = async () => { try { if (mic.active) { await mic.stop(); clearTimeout(timer); } else await mic.start(); controls(); } catch (e) { toast(e.message, true); } };
$('sensitivity').oninput = e => { mic.threshold = Number(e.target.value); $('sensitivityValue').textContent = mic.threshold.toFixed(3); };
$('speechRate').oninput = e => setSpeechRate(e.target.value, true);
$('autoAdvance').onchange = () => { clearTimeout(timer); if ($('autoAdvance').checked && currentMessage && !audio && !busy) scheduleNext(currentMessage, epoch); };
$('saveButton').onclick = async () => { try { captureConfig(); await api('/api/config', config); $('saveStatus').textContent = '已保存 · 新会话生效'; toast('配置已保存到本机'); } catch (e) { toast(e.message, true); } };
$('studentName').oninput=()=>{$('name').value=$('studentName').value;};
$('name').oninput=()=>{$('studentName').value=$('name').value;};
$('provider').onchange = () => {
  config.provider=$('provider').value;
  if(config.provider==='ark') $('model').value='deepseek-v4-1-flash-economy-261017';
  else if(config.provider==='codex' && $('model').value.startsWith('deepseek-')) $('model').value='gpt-6-astra';
};
document.querySelectorAll('[data-input-mode]').forEach(b => b.onclick = () => selectInputMode(b.dataset.inputMode));
$('messageForm').onsubmit = async e => { e.preventDefault(); const text = $('messageInput').value.trim(); if (!text || starting || ended) return; await unlockSpeaker(); $('messageInput').value = ''; inputReceipt(text,'正在提交'); await submitUserInput(text,{source:'text',at:performance.now()}); };
$('messageInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('messageForm').requestSubmit(); } };
$('exportButton').onclick = async () => { try { const data = await api(`/api/sessions/${sessionId}`); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'})); const link = document.createElement('a'); link.href = url; link.download = `dialogue-${sessionId.slice(0, 8)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) { toast(e.message, true); } };
$('historyButton').onclick = async () => { try { const records = await api('/api/sessions'); $('historyDetail').hidden = true; $('historyList').replaceChildren(); if (!records.length) $('historyList').textContent = '还没有对话记录。'; for (const record of records) { const button = document.createElement('button'); button.className = 'history-item'; button.textContent = `${record.role === 'lecturer' ? '讲师' : '面试官'} · ${record.task.slice(0, 45)}`; const meta = document.createElement('small'); meta.textContent = `${new Date(record.created * 1000).toLocaleString('zh-CN')} · ${record.turns} 条消息`; button.append(meta); button.onclick = async () => { try { const detail = await api(`/api/sessions/${record.id}`); $('historyDetail').textContent = detail.messages.map(m => `${m.role === 'user' ? '你' : 'AI'}${m.delivery === 'interrupted' ? '（播报被打断）' : ''}\n${m.content}`).join('\n\n'); $('historyDetail').hidden = false; } catch(e) { toast(e.message, true); } }; $('historyList').append(button); } $('historyDialog').showModal(); } catch (e) { toast(e.message, true); } };
$('closeHistory').onclick = () => $('historyDialog').close();
$('editToggle').onclick = () => { const expanded = document.body.classList.toggle('show-settings'); $('editToggle').setAttribute('aria-expanded', String(expanded)); };
$('inspectToggle').onclick = () => { const expanded = document.body.classList.toggle('show-inspector'); $('inspectToggle').setAttribute('aria-expanded', String(expanded)); };
setInterval(() => { if (startedAt) { const seconds = Math.floor((Date.now() - startedAt) / 1000); $('elapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; } }, 1000);
setInterval(() => { if (waitingSince && busy) $('captionState').textContent = `已提交 · 等待 ${Math.floor((Date.now() - waitingSince) / 1000)} 秒`; }, 1000);
window.addEventListener('pagehide', () => { if (sessionId) navigator.sendBeacon('/api/cancel', JSON.stringify({session_id: sessionId, message_id: currentMessage?.id, heard: spokenPrefix})); mic.stream?.getTracks().forEach(t => t.stop()); });
const readinessTimer = setInterval(async () => {
  try {
    const state = await api('/api/config');
    capabilities=state.capabilities;
    $('asrStatus').textContent = capabilities.asr_model || (capabilities.asr ? '本地识别已就绪' : '模型待准备');
    if(capabilities.warmup?.error && !active) status('模型准备失败',capabilities.warmup.error);
    controls();
    if(capabilities.asr && capabilities.tts && (!capabilities.warmup || capabilities.warmup.tts==='ready') && (config?.provider!=='ark'||['ready','error'].includes(capabilities.warmup?.remote))) clearInterval(readinessTimer);
  } catch { /* Keep user edits intact while the local server restarts. */ }
}, 1500);

try {
  const data = await api('/api/config'); config = data.config; capabilities = data.capabilities;
  for (const [key, value] of Object.entries(config.profile)) $(key).value = value;
  $('studentName').value=config.profile.name||'';
  $('model').value = config.model; $('provider').value = config.provider || 'ark'; renderRole(); controls();
  $('connection').textContent = config.provider==='ark' ? 'DeepSeek 流式 · 中文男声' : config.provider==='local' ? '本地 Qwen · 中文男声' : 'Codex · 中文男声'; $('connection').classList.add('ready');
  $('asrStatus').textContent = capabilities.asr_model || (capabilities.asr ? '本地识别已就绪' : '模型待准备');
  if(capabilities.asr) $('audioNote').textContent = `${capabilities.asr_model || '本地识别'} · 建议戴耳机`;
  if (!capabilities.asr) $('audioNote').textContent = '语音模型还未就绪，可先使用文字调试。';
} catch (e) { $('connection').textContent = '本地服务未连接'; toast(e.message, true); }
