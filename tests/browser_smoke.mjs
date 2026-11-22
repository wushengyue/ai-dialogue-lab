// Runs against a dedicated headless Chrome on port 9227, never a personal profile.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
// Each run gets its own tab so fixture injection can never contaminate live tests.
const tab = await (await fetch('http://127.0.0.1:9227/json/new?about:blank', {method:'PUT'})).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0;
const calls = new Map(), errors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && calls.has(message.id)) { const {resolve, reject} = calls.get(message.id); calls.delete(message.id); message.error ? reject(message.error) : resolve(message.result); }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
};
const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; calls.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params})); });
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(400); }
  throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText.slice(-2500)'));
}
async function click(id) {
  const box = await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchMouseEvent', {type:'mousePressed', ...box, button:'left', clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased', ...box, button:'left', clickCount:1});
}
const records = [];
try {
  await call('Runtime.enable'); await call('Page.enable');
  if(process.argv.includes('--voice')) await call('Page.addScriptToEvaluateOnNewDocument',{source:`
    navigator.mediaDevices.getUserMedia=async()=>{window.__micContext=new AudioContext();await __micContext.resume();window.__micDestination=__micContext.createMediaStreamDestination();return __micDestination.stream;};
    window.__feedStudent=async()=>{const r=await fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'我想先看同一个案例分两路生成回复的过程。',rate:200})});if(!r.ok)throw new Error('Could not prepare synthetic test speech');const buffer=await __micContext.decodeAudioData(await r.arrayBuffer());const source=__micContext.createBufferSource();source.buffer=buffer;source.connect(__micDestination);source.start();return {synthetic:true,duration:buffer.duration};};
  `});
  if(process.argv.includes('--queue')||process.argv.includes('--staged')) await call('Page.addScriptToEvaluateOnNewDocument',{source:`
    const staged=${process.argv.includes('--staged')};
    const realFetch=window.fetch.bind(window);
    window.__qa={turns:[],cancels:0,delivery:0,firstAudio:[],boards:[]};
    const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    window.fetch=async (url,options={})=>{
      const path=String(url),body=options.body && typeof options.body==='string' ? JSON.parse(options.body) : {};
      if(path==='/api/config'){const d=await (await realFetch(url,options)).json();d.capabilities.streaming=true;d.capabilities.local_model=true;d.config.provider='local';return json(d);}
      if(path==='/api/session')return json({session_id:'11111111111111111111111111111111'});
      if(path==='/api/cancel'){__qa.cancels++;return json({ok:true});}
      if(path==='/api/client-event'){if(body.kind==='first_audio')__qa.firstAudio.push(body);if(body.kind==='board_rendered')__qa.boards.push(body.board_state);return json({ok:true});}
      if(path==='/api/delivery'){__qa.delivery++;return json({ok:true});}
      if(path==='/api/speak'){
        const samples=8000,buffer=new ArrayBuffer(44+samples*2),v=new DataView(buffer),str=(n,s)=>[...s].forEach((x,i)=>v.setUint8(n+i,x.charCodeAt(0)));
        str(0,'RIFF');v.setUint32(4,buffer.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,samples*2,true);
        return new Response(buffer,{headers:{'Content-Type':'audio/wav'}});
      }
      if(path==='/api/turn/stream'){
        const record={...body,aborted:false};__qa.turns.push(record);options.signal.addEventListener('abort',()=>record.aborted=true);
        if(staged){
          const first=__qa.turns.length===1,id='staged-'+__qa.turns.length;
          const steps=[{speech:'必需项有一项不达标，整条案例就不通过。',ops:[{action:'new_page',text:first?'第一个解释':'结合补充讲案例'},{action:'add',id:'first',role:'knowledge',text:first?'任一必需项失败 → 整条失败':'回应补充：先看案例'}]},{speech:'接下来我们看案例里板书没有达标的地方。',ops:[{action:'add',id:'later',role:'process',text:first?'尚未讲到的旧说明':'新案例：板书缺少点段关系',rightOf:'first'},{action:'highlight',id:'first',phrase:first?'必需项':'案例',intent:'emphasis'}]}];
          const encoder=new TextEncoder();
          return new Response(new ReadableStream({start(c){const emit=x=>c.enqueue(encoder.encode(JSON.stringify(x)+'\\n'));emit({type:'model_started',message_id:id});
            setTimeout(()=>{emit({type:'text_delta',text:steps[0].speech,ttft_ms:750});emit({type:'speech',message_id:id,step_id:0,sentence_end:true,text:steps[0].speech,ttft_ms:750});emit({type:'board_ops',step_id:0,ops:steps[0].ops});},800);
            setTimeout(()=>{emit({type:'speech',message_id:id,step_id:1,sentence_end:true,text:steps[1].speech,ttft_ms:750});emit({type:'board_ops',step_id:1,ops:steps[1].ops});},900);
            setTimeout(()=>{const content=steps.map(s=>s.speech).join('');emit({type:'result',data:{message:{id,content,steps,phase:'讲解',await_user:true,done:false,adaptation:'fixture',board:{}},metrics:{provider:'ark',model:'TEST FIXTURE',latency_ms:1500,ttft_ms:750},debug:{}}});c.close();},1500);
          }}),{headers:{'Content-Type':'application/x-ndjson'}});
        }
        const id='test-'+__qa.turns.length,speech='这是交互回归测试的语音片段。',encoder=new TextEncoder();
        return new Response(new ReadableStream({start(c){const emit=x=>c.enqueue(encoder.encode(JSON.stringify(x)+'\\n'));
          emit({type:'model_started',message_id:id});
          setTimeout(()=>emit({type:'speech',message_id:id,text:speech,ttft_ms:500}),800);
          setTimeout(()=>{emit({type:'result',data:{message:{id,content:speech,speech,phase:'轻互动',await_user:true,done:false,adaptation:'测试输入队列',board:{title:'交互回归测试',points:['真实课堂使用实际模型输出；此页为测试夹具'],example:'',question:'你想先看评分流程，还是案例？',flow:[],table:{columns:[],rows:[]},highlight:[],diagram:{nodes:[{id:'a',label:'同一个 case'},{id:'b',label:'回复 A'},{id:'c',label:'回复 B'}],edges:[{from:'a',to:'b',label:''},{from:'a',to:'c',label:''}]}}},metrics:{provider:'local',model:'TEST FIXTURE',latency_ms:1500},debug:{}}});c.close();},1500);
        }}),{headers:{'Content-Type':'application/x-ndjson'}});
      }
      return realFetch(url,options);
    };
  `});
  await call('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate', {url:'http://127.0.0.1:8765/?qa=classroom'});
  await until('document.getElementById("connection")?.classList.contains("ready")');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.course-name')].map(e=>e.textContent)`),['整体架构','Rubric','板书','学习系统','实时教学系统','教具','自动化内容生产']);
  assert.equal(await evaluate(`document.querySelector('.course-item[aria-current="page"]').dataset.course`),'rubric');
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('courseNav')).backgroundColor`),'rgba(0, 0, 0, 0)');
  if(await evaluate(`document.getElementById('courseToggle').getAttribute('aria-expanded')==='false'`))await click('courseToggle');
  await click('courseToggle');assert.ok(await evaluate(`document.getElementById('courseList').hidden`));
  await click('courseToggle');assert.ok(await evaluate(`!document.getElementById('courseList').hidden`));
  for (const [width,height] of [[1280,800],[1366,768],[1024,768],[800,600],[390,844]]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false}); await sleep(250);
    const sizes = await evaluate(`(()=>{const r=document.getElementById('blackboard').getBoundingClientRect(),a=document.getElementById('teacherAvatar').getBoundingClientRect(),c=document.querySelector('.composer-area').getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,board:{x:r.x,y:r.y,width:r.width,height:r.height},avatarWidth:a.width,controlsBottom:c.bottom}})()`);
    assert.ok(Math.abs(sizes.board.width / sizes.board.height - 16/9) < .01, JSON.stringify(sizes));
    assert.ok(sizes.scrollHeight <= height + 1 && sizes.scrollWidth <= width + 1, JSON.stringify(sizes));
    assert.ok(sizes.controlsBottom <= height, JSON.stringify(sizes));
    assert.ok(sizes.avatarWidth < 90, JSON.stringify(sizes));
    assert.ok(await evaluate(`(()=>{const a=document.getElementById('teacherAvatar').getBoundingClientRect(),t=document.getElementById('boardTopic').getBoundingClientRect(),b=document.getElementById('blackboard').getBoundingClientRect();return a.left>=b.left&&a.right<=t.left&&(t.top+t.height/2)-(a.top+a.height/2)>1&&(t.top+t.height/2)-(a.top+a.height/2)<10&&a.bottom<=b.bottom})()`),'Teacher must sit just before the board topic');
    records.push(sizes);
  }
  await call('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false}); await sleep(250);
  if(await evaluate(`document.getElementById('courseToggle').getAttribute('aria-expanded')==='false'`))await click('courseToggle');
  await sleep(250);
  let screenshot = await call('Page.captureScreenshot'); await fs.writeFile('data/classroom-ready.png', Buffer.from(screenshot.data,'base64'));
  console.log('Layout verified at five viewport sizes, board 16:9, avatar under 90px.');
  if(process.argv.includes('--interview')){
    await click('interviewerRole');await until(`document.getElementById('boardMode').textContent==='面试模式'`);
    assert.equal(await evaluate(`document.getElementById('interviewerRole').getAttribute('aria-pressed')`),'true');
    assert.equal(await evaluate(`document.getElementById('boardCourse').textContent`),'Rubric 专题面试');
    assert.ok(await evaluate(`document.getElementById('lessonIntroduction').textContent.includes('Rubric')`));
    await until(`document.getElementById('startVoice').textContent==='开始面试'&&!document.getElementById('startVoice').disabled`,60000);
    await click('autoAdvance');await click('textToggle');await click('startVoice');
    await until(`document.getElementById('debugContent').textContent.includes('播报完成')`,90000);
    const firstQuestion=await evaluate(`document.getElementById('liveTeacherQuestionText').textContent`);
    assert.ok(/Rubric/.test(firstQuestion),firstQuestion);
    assert.ok(!/介绍.*项目|真实经历/.test(firstQuestion),firstQuestion);
    await evaluate(`document.getElementById('messageInput').value='Rubric 把讲得好拆成可以逐项判断的标准，裁判结合上下文判定并给理由，能够定位哪一项变差，而不只是整体选优。'`);
    await click('sendButton');
    await until(`(document.getElementById('debugContent').textContent.match(/播报完成/g)||[]).length>=2`,90000);
    const actual=await evaluate(`(async()=>{const prefix=document.getElementById('sessionMeta').textContent.split(' · ')[1],all=await(await fetch('/api/sessions')).json(),id=all.find(s=>s.id.startsWith(prefix)).id;return(await fetch('/api/sessions/'+id)).json()})()`);
    const answers=actual.messages.filter(m=>m.role==='assistant');
    assert.equal(actual.settings.role,'interviewer');assert.equal(actual.settings.provider,'ark');
    for(const answer of answers){assert.equal(answer.await_user,true);assert.ok(answer.steps.some(s=>s.ops.some(op=>op.action==='question'&&op.text)));}
    const followup=await evaluate(`document.getElementById('liveTeacherQuestionText').textContent`);assert.ok(followup&&followup!==firstQuestion);
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-interview.png',Buffer.from(screenshot.data,'base64'));
    records.push({rubric_interview:true,firstQuestion,followup,answers:answers.map(m=>m.content),events:actual.events.filter(e=>['first_audio','model_complete'].includes(e.kind))});
    console.log(JSON.stringify({rubric_interview:true,firstQuestion,followup}));
    await click('lecturerRole');await until(`document.getElementById('boardMode').textContent==='讲解模式'`);
    assert.equal(await evaluate(`document.getElementById('boardCourse').textContent`),'Rubric 评测课堂');
    assert.equal(await evaluate(`document.querySelector('.course-item[aria-current="page"]').dataset.course`),'rubric');
  }
  if (process.argv.includes('--queue')) {
    await click('autoAdvance'); await click('textToggle');
    await evaluate('document.getElementById("messageInput").value="请介绍 Rubric。"'); await click('sendButton');
    await until('__qa.turns.length===1');
    await evaluate('document.getElementById("messageInput").value="补充一下，我想先看案例。"'); await click('sendButton');
    await until('document.getElementById("queuedInputCount").textContent.includes("1")');
    assert.equal(await evaluate('__qa.cancels'),0);
    assert.equal(await evaluate('__qa.turns[0].aborted'),false);
    await until('__qa.delivery===2');
    assert.equal(await evaluate('__qa.turns.length'),2);
    assert.equal(await evaluate('__qa.turns[1].text'),'补充一下，我想先看案例。');
    assert.equal(await evaluate('__qa.turns[0].aborted'),false);
    assert.equal(await evaluate('__qa.firstAudio.length'),2);
    assert.equal(await evaluate('document.querySelectorAll("#boardDiagram rect").length'),3);
    await click('interruptButton'); await until('document.getElementById("statusTitle").textContent==="课堂已暂停"');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-input-mode]")].map(e=>e.dataset.inputMode)'),['open','text']);
    assert.equal(await evaluate('!!document.getElementById("holdToTalk")'),false);
    records.push({fixture:true,queued_input_preserves_generation:true,delivered_in_order:true,pause:true,two_input_modes:true});
    console.log('Queue regression passed: no cancellation before first audio, two ordered replies, pause and two input modes.');
  }
  if (process.argv.includes('--live')) {
    await until('!document.getElementById("startVoice").disabled',30000);
    await click('autoAdvance'); await click('textToggle');
    await evaluate('document.getElementById("messageInput").value="为什么数学答案是对的，整条案例仍然可能不通过？请画出关键判断关系。"');
    await click('sendButton'); console.log('Submitted text; waiting for a real model reply and audio playback.');
    await until('document.getElementById("teacherAvatar").dataset.state === "speaking"', 150000);
    const speaking = await evaluate('({subtitle:document.getElementById("captionText").textContent,firstAudio:document.getElementById("firstAudioMetric").textContent,state:document.getElementById("teacherAvatar").dataset.state,modelState:document.getElementById("pipe-model").dataset.state,mouthAnimation:getComputedStyle(document.querySelector(".avatar-mouth")).animationName})');
    assert.ok(speaking.subtitle.length>=12, JSON.stringify(speaking));
    assert.equal(speaking.modelState,'running','Voice must start before the full JSON/board is finished');
    assert.equal(speaking.mouthAnimation,'mouth-open-close');
    await until('document.querySelectorAll("#liveRows [data-block-id],#liveDiagram [data-node-id]").length>0');
    assert.ok(await evaluate('document.getElementById("boardPageCount").textContent.includes("第 1 页")'));
    screenshot = await call('Page.captureScreenshot'); await fs.writeFile('data/classroom-speaking.png', Buffer.from(screenshot.data,'base64'));
    records.push({speaking}); console.log(JSON.stringify({speaking}));
    await until('document.getElementById("debugContent").textContent.includes("播报完成")', 100000);
    await evaluate('document.getElementById("messageInput").value="那不适用算错吗？单项通过率的分母怎么算？"');
    await click('sendButton');
    await until('(document.getElementById("debugContent").textContent.match(/播报完成/g)||[]).length>=2',60000);
    await click('continueButton');
    await until('(document.getElementById("debugContent").textContent.match(/播报完成/g)||[]).length>=3',60000);
    const actual=await evaluate(`(async()=>{const prefix=document.getElementById('sessionMeta').textContent.split(' · ')[1],all=await(await fetch('/api/sessions')).json(),id=all.find(s=>s.id.startsWith(prefix)).id;return (await fetch('/api/sessions/'+id)).json()})()`);
    assert.equal(actual.settings.provider,'ark');
    for(const complete of actual.events.filter(e=>e.kind==='model_complete')){
      const first=actual.events.find(e=>e.kind==='first_audio' && e.request_id===complete.request_id);
      assert.ok(first && first.at<complete.at,'Audio should precede complete model output');
    }
    const answers=actual.messages.filter(m=>m.role==='assistant').map(m=>m.content);
    assert.ok(answers[0].includes('吴同学'),'New class greets the configured student');
    assert.notEqual(answers[1],answers[2],'Continue must advance beyond the answered question');
    assert.ok(actual.handled_user_ids.length>=2);
    records.push({real_pipeline:actual.events.filter(e=>['model_start','model_complete','first_audio'].includes(e.kind)),answers,board:actual.displayed_board,pageCounter:await evaluate('document.getElementById("boardPageCount").textContent')});
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-speaking.png',Buffer.from(screenshot.data,'base64'));
    await click('interruptButton');
    await until('document.getElementById("statusTitle").textContent==="课堂已暂停"');
    assert.equal(await evaluate('document.getElementById("statusTitle").textContent'),'课堂已暂停');
    assert.notEqual(await evaluate('document.getElementById("teacherAvatar").dataset.state'),'speaking');
    records.push({text_to_voice:true,delivery_complete:true,pause:true});
    console.log('Real audio playback finished; pause stops the avatar and classroom.');
  }
  if(process.argv.includes('--staged')){
    await click('autoAdvance');await click('textToggle');
    await evaluate('document.getElementById("messageInput").value="为什么必需项失败会影响整条？"');await click('sendButton');
    await until('document.querySelector("[data-block-id=first]") && document.getElementById("teacherAvatar").dataset.state==="speaking"');
    assert.equal(await evaluate('!!document.querySelector("[data-block-id=later]")'),false,'Future board text must stay hidden');
    await evaluate('document.getElementById("messageInput").value="补充一下，请先讲那个板书的案例。"');await click('sendButton');
    await until('__qa.turns.length===2 && __qa.delivery===1');
    assert.equal(await evaluate('__qa.turns[0].aborted'),false,'Do not reset first-turn generation');
    assert.equal(await evaluate('__qa.cancels'),1,'Discard remaining speech only at the completed sentence');
    assert.equal(await evaluate('__qa.boards.some(b=>b?.blocks?.some(x=>x.text==="尚未讲到的旧说明"))'),false);
    assert.ok(await evaluate('document.getElementById("boardPageCount").textContent.includes("第 2 页")'));
    const font=await evaluate('getComputedStyle(document.querySelector(".live-block")).fontSize');
    await evaluate(`(async()=>{const b=await import('/live-board.mjs');b.applyBoardOps(Array.from({length:12},(_,i)=>({action:'add',id:'scroll-'+i,role:'note',text:'长内容继续往下写，字号保持不变。'})))})()`);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".live-block")).fontSize'),font);
    assert.ok(await evaluate('document.getElementById("boardBody").scrollHeight>document.getElementById("boardBody").clientHeight'));
    await sleep(700);
    assert.ok(await evaluate(`(()=>{const b=document.getElementById('boardBody');return Math.abs(b.scrollHeight-b.clientHeight-b.scrollTop)<2})()`),'New content follows the bottom');
    await evaluate(`import('/live-board.mjs').then(b=>b.applyBoardOps([{action:'highlight',id:'first',intent:'reference'}]))`);
    await sleep(700);
    assert.ok(await evaluate(`(()=>{const a=document.querySelector('[data-block-id=first]').getBoundingClientRect(),b=document.getElementById('boardBody').getBoundingClientRect();return a.top>=b.top-2&&a.bottom<=b.bottom+2})()`),'Revisiting a point must scroll back to it');
    await evaluate(`import('/live-board.mjs').then(b=>b.applyBoardOps([{action:'add',id:'resumed-tail',text:'回讲之后，新的讲解继续接在末尾。'},{action:'highlight',id:'resumed-tail',intent:'emphasis'}]))`);
    await sleep(700);
    assert.ok(await evaluate(`(()=>{const b=document.getElementById('boardBody');return Math.abs(b.scrollHeight-b.clientHeight-b.scrollTop)<2})()`),'Resuming new content returns to the bottom');
    await evaluate(`(()=>{const b=document.getElementById('boardBody');b.scrollTo({top:b.scrollHeight,behavior:'instant'});b.dispatchEvent(new WheelEvent('wheel'));})()`);
    await evaluate(`import('/live-board.mjs').then(b=>b.applyBoardOps([{action:'highlight',id:'first',intent:'reference'}]))`);await sleep(400);
    assert.ok(await evaluate(`document.getElementById('boardBody').scrollTop>100`),'Manual review must not be overridden');
    await click('boardFollow');await sleep(700);
    assert.ok(await evaluate(`document.getElementById('boardBody').scrollTop<50`));
    await click('boardPrev');assert.ok(await evaluate('document.getElementById("boardPageCount").textContent.includes("第 1 页")'));
    await sleep(850);await click('boardNext');await until('document.getElementById("boardPageCount").textContent.includes("第 2 页")');
    records.push({fixture:true,board_follows_audio:true,sentence_checkpoint:true,unspoken_board_hidden:true,fixed_font_and_scroll:true,page_review:true});
    console.log('Staged board and sentence checkpoint verified, with fixed font, scroll and page review.');
    await click('interruptButton');
    await evaluate(`(async()=>{const b=await import('/live-board.mjs');b.applyBoardOps([{action:'new_page',text:'Rubric：评分标准与阅卷老师'},...['荧光笔','下划线','圈选','方框'].map((s,i)=>({action:'add',id:'pen-'+i,text:s+'强调关键依据，其余文字保持清爽。'})),...['marker','underline','circle','box'].map((style,i)=>({action:'highlight',id:'pen-'+i,phrase:['荧光笔','下划线','圈选','方框'][i],intent:'emphasis',style}))]);document.getElementById('boardBody').scrollTop=0;document.getElementById('teacherAvatar').dataset.state='speaking';b.applyBoardOps([{action:'gesture',name:'encourage'}]);})()`);
    const pen=await evaluate(`({styles:[...document.querySelectorAll('#liveRows mark')].map(e=>e.dataset.markStyle),heart:getComputedStyle(document.querySelector('.teacher-hearts')).display,titleSize:getComputedStyle(document.getElementById('boardTopic')).fontSize,avatarParent:document.getElementById('teacherAvatar').parentElement.className})`);
    assert.deepEqual(pen.styles,['marker','underline','circle','box']);assert.equal(pen.heart,'block');assert.equal(pen.titleSize,'28px');assert.equal(pen.avatarParent,'board-topic');
    await sleep(600);
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-teacher-caption.png',Buffer.from(screenshot.data,'base64'));
    await evaluate(`import('/board-camera.mjs').then(c=>c.prepareBoardCamera())`);await sleep(350);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('liveBoard')).transform`),'none');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.board-reveal')).animationName`),'none');
    await evaluate(`import('/board-camera.mjs').then(c=>c.enterBoardPage())`);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('boardBody')).transform`),'none');
    await evaluate(`document.getElementById('teacherAvatar').dataset.state='thinking'`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.hair-one')).animationName`),'hair-loading');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.avatar-character')).animationName`),'none');
    records.push({fixture:true,pen,teacher_before_title:true,stable_words:true,no_page_animation:true,hair_loading:true,loading_colors:await evaluate(`[...document.querySelectorAll('.hair')].map(e=>getComputedStyle(e).stroke)`),follow_current_content:true});
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-colored-loading.png',Buffer.from(screenshot.data,'base64'));
    await evaluate(`(async()=>{const b=await import('/live-board.mjs');b.applyBoardOps([{action:'layout',columns:3,rows:1},{action:'node',id:'standard',text:'评分标准',col:0},{action:'node',id:'judge',text:'裁判模型',col:1},{action:'node',id:'old-node',text:'旧例子',col:2},{action:'edge',id:'use',from:'standard',to:'judge',text:'依据'},{action:'edge',id:'old-edge',from:'judge',to:'old-node'}]);b.applyBoardOps([{action:'clear',keep:['pen-0','standard','judge']},{action:'add',id:'pen-0',text:'Rubric 定义具体标准；裁判模型执行判断。'},{action:'title',text:'评分标准与裁判的分工'},{action:'question',text:''}]);})()`);
    assert.equal(await evaluate(`document.querySelectorAll('#liveRows [data-block-id]').length`),1);
    assert.equal(await evaluate(`document.querySelectorAll('#liveDiagram [data-node-id]').length`),2);
    assert.equal(await evaluate(`document.querySelectorAll('#liveDiagram [data-edge-id]').length`),1);
    assert.equal(await evaluate(`document.getElementById('boardCourse').textContent`),'Rubric 评测课堂');
    const focused=await evaluate(`import('/live-board.mjs').then(b=>b.displayedBoard())`);
    await click('boardPrev');assert.ok(await evaluate(`document.getElementById('liveRows').textContent.includes('回应补充')`),'Clearing current content must preserve the previous page');
    await click('boardNext');await sleep(600);
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-focus-board.png',Buffer.from(screenshot.data,'base64'));
    records.push({fixture:true,focused,selective_clear_preserves_history:true});
  }
  if(process.argv.includes('--english')){
    await until('!document.getElementById("startVoice").disabled',60000);
    await click('autoAdvance');await click('textToggle');
    await evaluate('document.getElementById("messageInput").value="先按英文原文读 Rubric, Must-have, Nice-to-have, PASS, FAIL, case，不要翻译。再用中文解释同一个 case 分成新旧两路生成回复，并画出分支图。"');
    await click('sendButton');
    await until('document.getElementById("teacherAvatar").dataset.state==="speaking"',60000);
    const speaking=await evaluate('({subtitle:document.getElementById("captionText").textContent,mouth:getComputedStyle(document.querySelector(".avatar-mouth")).animationName})');
    assert.equal(speaking.mouth,'mouth-open-close');
    await until('document.getElementById("debugContent").textContent.includes("播报完成")',90000);
    const actual=await evaluate(`(async()=>{const prefix=document.getElementById('sessionMeta').textContent.split(' · ')[1],all=await(await fetch('/api/sessions')).json(),id=all.find(s=>s.id.startsWith(prefix)).id;return (await fetch('/api/sessions/'+id)).json()})()`);
    const answer=actual.messages.find(m=>m.role==='assistant').content;
    for(const word of ['Rubric','Must-have','Nice-to-have','PASS','FAIL','case'])assert.ok(answer.toLowerCase().includes(word.toLowerCase()),answer);
    const appearance=await evaluate(`({largeTitle:getComputedStyle(document.getElementById('boardTitle')).display,topic:document.getElementById('boardTopic').textContent,page:document.getElementById('boardPageCount').textContent,blocks:[...document.querySelectorAll('.live-block')].map(e=>({text:e.textContent,background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderWidth})),marks:[...document.querySelectorAll('#blackboard mark')].map(e=>getComputedStyle(e).backgroundColor),questionBackground:getComputedStyle(document.getElementById('studentQuestionWrap')).backgroundColor,nodes:document.querySelectorAll('#liveDiagram [data-node-id]').length,edges:document.querySelectorAll('#liveDiagram path[marker-end]').length})`);
    assert.equal(appearance.largeTitle,'none');
    for(const block of appearance.blocks){assert.equal(block.background,'rgba(0, 0, 0, 0)');assert.equal(block.border,'0px');}
    for(const background of appearance.marks)assert.equal(background,'rgba(0, 0, 0, 0)');
    assert.equal(appearance.questionBackground,'rgba(0, 0, 0, 0)');
    assert.ok(appearance.nodes>=2 && appearance.edges>=1,JSON.stringify(appearance));
    records.push({real_pipeline:true,english_preserved:true,answer,appearance,events:actual.events.filter(e=>['model_complete','first_audio'].includes(e.kind))});
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-english-clean-board.png',Buffer.from(screenshot.data,'base64'));
    await click('interruptButton');
    console.log(JSON.stringify({english_preserved:true,male_audio_played:true,answer,appearance}));
  }
  if(process.argv.includes('--voice')){
    await until('!document.getElementById("startVoice").disabled',60000);
    await click('autoAdvance');await click('startVoice');
    await until('(document.getElementById("debugContent").textContent.match(/播报完成/g)||[]).length>=1',60000);
    await click('continueButton');
    await until('document.getElementById("boardPageCount").textContent.includes("第 2 页")',60000);
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-section-turn.png',Buffer.from(screenshot.data,'base64'));
    await until('(document.getElementById("debugContent").textContent.match(/播报完成/g)||[]).length>=2',60000);
    assert.ok(await evaluate('document.getElementById("boardPageCount").textContent.includes("第 2 页")'),'A new section gets a new page');
    const source=await evaluate('__feedStudent()');
    await until('document.getElementById("listeningFeedback").dataset.state==="listening"');
    const listening=await evaluate('({label:document.getElementById("listeningLabel").textContent,energy:Number(document.getElementById("listeningFeedback").style.getPropertyValue("--voice-energy")),hair:getComputedStyle(document.querySelector(".listening-hair")).display,hairAnimation:getComputedStyle(document.querySelector(".listening-hair")).animationName})');
    assert.equal(listening.label,'老师在听');assert.equal(listening.hair,'block');assert.equal(listening.hairAnimation,'none');
    screenshot=await call('Page.captureScreenshot');await fs.writeFile('data/classroom-listening.png',Buffer.from(screenshot.data,'base64'));
    await until('(document.getElementById("debugContent").textContent.match(/播报完成/g)||[]).length>=3',90000);
    const actual=await evaluate(`(async()=>{const prefix=document.getElementById('sessionMeta').textContent.split(' · ')[1],all=await(await fetch('/api/sessions')).json(),id=all.find(s=>s.id.startsWith(prefix)).id;return (await fetch('/api/sessions/'+id)).json()})()`);
    const user=actual.messages.find(m=>m.role==='user');assert.ok(user && /案例/.test(user.content) && /生成/.test(user.content),JSON.stringify(user));
    assert.equal(actual.settings.provider,'ark');
    assert.equal(actual.lesson.index,1);
    assert.ok(actual.events.some(e=>e.kind==='section_user_injected'&&e.section_id==='rubric-02-case'));
    const opening=actual.messages.find(m=>m.role==='assistant');
    for(const token of ['吴同学','Rubric','第一','第二','第三','格子衫','资深'])assert.ok(opening.content.includes(token),opening.content);
    assert.equal(opening.await_user,false,'The opening previews the course and then proceeds');
    const begin=actual.events.find(e=>e.kind==='model_start'&&e.event==='user');
    const first=actual.events.find(e=>e.kind==='first_audio'&&e.request_id===begin.request_id);
    const model=actual.events.find(e=>e.kind==='model_complete'&&e.request_id===begin.request_id);
    records.push({full_voice_pipeline:true,section_transition:true,listening,source,recognized:user.content,first_audio_ms:first.latency_ms,ttft_ms:model.ttft_ms,model_total_ms:model.latency_ms,events:actual.events,answers:actual.messages.filter(m=>m.role==='assistant').map(m=>m.content)});
    console.log(JSON.stringify({full_voice_pipeline:true,synthetic:true,recognized:user.content,first_audio_ms:first.latency_ms,ttft_ms:model.ttft_ms}));
    await click('interruptButton');await until('document.getElementById("statusTitle").textContent==="课堂已暂停"');
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(process.argv.includes('--interview') ? 'data/browser-interview-verification.json' : process.argv.includes('--english') ? 'data/browser-english-verification.json' : process.argv.includes('--live') ? 'data/browser-live-verification.json' : process.argv.includes('--voice') ? 'data/browser-voice-verification.json' : process.argv.includes('--staged') ? 'data/browser-staged-verification.json' : 'data/browser-verification.json', JSON.stringify(records,null,2));
} finally { ws.close(); await fetch('http://127.0.0.1:9227/json/close/'+tab.id); }
