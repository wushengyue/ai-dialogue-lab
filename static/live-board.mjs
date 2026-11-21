// Board operations are released by audio playback, never by model completion.
import {enterBoardPage,stopBoardCamera} from './board-camera.mjs';
const $=id=>document.getElementById(id), NS='http://www.w3.org/2000/svg';
let pages=[],view=-1,following=true,questionMode='';
let organizedQuestion='';
const current=()=>pages.at(-1);
function svg(tag,attrs={},text){const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function page(title){return {title,blocks:[],nodes:[],edges:[],layout:{columns:3,rows:2},question:'',taught:false};}
function ensure(){if(!pages.length){pages.push(page('跟着讲解看板书'));view=0;}return current();}
function controls(){
  $('boardPageCount').textContent=pages.length?`第 ${view+1} 页 · 已讲 ${pages.filter(p=>p.taught).length} 页`:'待开课 · 已讲 0 页';
  $('boardPrev').disabled=view<=0;$('boardNext').disabled=view>=pages.length-1;
  $('boardFollow').hidden=!pages.length || (following && view===pages.length-1);
}
export function resetLiveBoard(){stopBoardCamera();pages=[];view=-1;following=true;questionMode='';organizedQuestion='';$('blackboard').classList.remove('has-live-board');$('boardTopic').textContent='一对一课堂 / 板书';$('liveBoard').hidden=true;showStudentQuestion('','');controls();}
export function displayedBoard(){return pages.length?JSON.parse(JSON.stringify({...current(),page:pages.length})):{};}
export function enterSection(section){
  if(!section?.id||current()?.section_id===section.id)return false;
  beginBoardTurn();
  if(current())current().taught=true;
  const next=page(section.title);next.section_id=section.id;pages.push(next);
  following=true;view=pages.length-1;organizedQuestion='';showStudentQuestion('','');
  $('boardBody').scrollTo({top:0,behavior:'instant'});paint(new Set(),true);enterBoardPage();return true;
}
export function markPageTaught(){if(current())current().taught=true;controls();}
export function showStudentQuestion(state,text,organized=false){
  questionMode=state;
  if(!state||state==='listening'||state==='received'||state==='recognizing')organizedQuestion='';
  if(organized)organizedQuestion=text;
  $('questionActivity').hidden=!state;$('questionActivity').dataset.state=state;
  $('questionActivity').textContent={listening:'学生发言中',recognizing:'正在识别',received:'发言已收到',queued:'补充已收到',answering:'老师正在回应',answered:'已回应'}[state]||'';
  const host=$('studentQuestionWrap');host.hidden=!organizedQuestion;host.dataset.state=state;
  $('studentQuestionLabel').textContent={listening:'正在听你提问',recognizing:'正在识别你的问题',received:'你的问题已收到',queued:'补充问题已收到 · 稍后回应',answering:'正在回答你的问题',answered:'刚才讨论的问题'}[state]||'你的问题';
  $('studentQuestion').textContent=organizedQuestion;
}
export function beginBoardTurn(){
  $('blackboard').classList.add('has-live-board');
  for(const child of $('boardContent').children)if(!['studentQuestionWrap','liveBoard'].includes(child.id))child.hidden=true;
  $('liveBoard').hidden=false;
}
function markedText(el,block){
  const signature=JSON.stringify([block.text,block.highlights||[]]);
  if(el.dataset.signature===signature)return;
  el.dataset.signature=signature;el.replaceChildren();
  const terms=(block.highlights||[]).filter(h=>h.phrase&&block.text.includes(h.phrase));let cursor=0;
  while(cursor<block.text.length){
    const hit=terms.map(h=>({...h,index:block.text.indexOf(h.phrase,cursor)})).filter(h=>h.index>=0).sort((a,b)=>a.index-b.index)[0];
    if(!hit){el.append(document.createTextNode(block.text.slice(cursor)));break;}
    el.append(document.createTextNode(block.text.slice(cursor,hit.index)));
    const mark=document.createElement('mark');mark.dataset.intent=hit.intent;mark.dataset.markStyle=hit.style||'marker';mark.textContent=hit.phrase;el.append(mark);cursor=hit.index+hit.phrase.length;
  }
}
function drawDiagram(p,added){
  const host=$('liveDiagram');host.hidden=!p.nodes.length;host.replaceChildren();if(!p.nodes.length)return;
  const cols=Math.max(2,Math.min(5,p.layout.columns)),rows=Math.max(1,Math.min(3,p.layout.rows)),width=1040,height=rows*76,nodeW=Math.min(218,(width-42*(cols-1))/cols),nodeH=52;
  const positions=new Map(p.nodes.map(n=>[n.id,{x:n.col*(width-nodeW)/(cols-1),y:n.row*76+10}]));
  const root=svg('svg',{viewBox:`-4 -30 ${width+8} ${height+34}`,role:'img','aria-label':'随讲解逐步绘制的结构图'});
  const defs=svg('defs'),marker=svg('marker',{id:'live-arrow',markerWidth:7,markerHeight:7,refX:6,refY:3.5,orient:'auto'});marker.append(svg('path',{d:'M0 0L7 3.5L0 7Z',fill:'#7591bb'}));defs.append(marker);root.append(defs);
  for(const edge of p.edges){const a=positions.get(edge.from),b=positions.get(edge.to);if(!a||!b)continue;
    let x1=a.x+nodeW,y1=a.y+nodeH/2,x2=b.x-4,y2=b.y+nodeH/2,path,labelY=(y1+y2)/2-8;
    if(a.x===b.x){
      x1=a.x+nodeW/2;x2=b.x+nodeW/2;y1=a.y+(b.y>a.y?nodeH:0);y2=b.y+(b.y>a.y?-4:nodeH+4);
      path=`M${x1} ${y1}L${x2} ${y2}`;labelY=(y1+y2)/2;
    }else{
      if(b.x<a.x){x1=a.x;x2=b.x+nodeW+4;}
      const m=(x1+x2)/2;
      const crossesNode=a.y===b.y && [...positions.values()].some(at=>at.y===a.y && at.x>Math.min(a.x,b.x) && at.x<Math.max(a.x,b.x));
      if(crossesNode){
        const direction=Math.sign(x2-x1),laneY=Math.min(a.y,b.y)-24;
        path=`M${x1} ${y1}C${x1+20*direction} ${y1} ${x1+20*direction} ${laneY} ${x1+40*direction} ${laneY}L${x2-40*direction} ${laneY}C${x2-20*direction} ${laneY} ${x2-20*direction} ${y2} ${x2} ${y2}`;labelY=laneY-7;
      }else path=`M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
    }
    root.append(svg('path',{'data-edge-id':edge.id,d:path,fill:'none',stroke:'#7591bb','stroke-width':2,'marker-end':'url(#live-arrow)'}));
    if(edge.text)root.append(svg('text',{x:(x1+x2)/2,y:labelY,'text-anchor':'middle','font-size':15,fill:'#5e7594'},edge.text));
  }
  for(const n of p.nodes){const at=positions.get(n.id),g=svg('g',{'data-node-id':n.id,class:added.has(n.id)?'board-reveal':''});
    const marked=!!n.intent,style=n.markStyle||'marker';
    g.append(svg('rect',{...at,width:nodeW,height:nodeH,rx:10,fill:marked&&style==='marker'?'#fff1ad':'#eef4ff',stroke:marked&&style==='box'?'#c28e39':'#b8cceb','stroke-width':marked&&style==='box'?2.5:1}));
    if(marked&&style==='circle')g.append(svg('ellipse',{cx:at.x+nodeW/2,cy:at.y+nodeH/2,rx:nodeW/2-4,ry:nodeH/2-3,fill:'none',stroke:'#c28e39','stroke-width':2.5}));
    if(marked&&style==='underline')g.append(svg('path',{d:`M${at.x+18} ${at.y+nodeH-6}L${at.x+nodeW-18} ${at.y+nodeH-6}`,fill:'none',stroke:'#c28e39','stroke-width':2.5}));
    const lines=n.text.match(/.{1,10}/gu)?.slice(0,2)||[];lines.forEach((line,i)=>g.append(svg('text',{x:at.x+nodeW/2,y:at.y+nodeH/2+6+(i-(lines.length-1)/2)*22,'text-anchor':'middle','font-size':21,fill:'#2e527e'},line)));root.append(g);
  }host.append(root);
}
function followFocus(p){
  if(!following||view!==pages.length-1||!p.focus)return;
  const f=p.focus,body=$('boardBody');
  const target=f.kind==='question'?$('liveTeacherQuestion'):f.kind==='student'?$('studentQuestionWrap'):
    [...$(f.kind==='node'?'liveDiagram':'liveRows').querySelectorAll(f.kind==='node'?'[data-node-id]':'[data-block-id]')].find(el=>(el.dataset.nodeId||el.dataset.blockId)===f.id);
  if(!target||target.hidden||!target.getClientRects().length)return;
  const area=body.getBoundingClientRect(),rect=target.getBoundingClientRect(),scale=area.width/body.offsetWidth||1,pad=16*scale;
  let top=body.scrollTop;
  if(rect.top<area.top+pad||rect.height>area.height-pad*2)top+=(rect.top-area.top-pad)/scale;
  else if(rect.bottom>area.bottom-pad)top+=(rect.bottom-area.bottom+pad)/scale;
  else return;
  body.scrollTo({top:Math.max(0,top),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
function paint(added=new Set(),force=false){
  controls();if(view<0)return;const p=pages[view];$('boardTitle').textContent=p.title;$('boardTopic').textContent=p.title;
  const rows=$('liveRows');if(force)rows.replaceChildren();
  const existing=new Map([...rows.querySelectorAll('[data-block-id]')].map(e=>[e.dataset.blockId,e]));
  const groups=new Map();for(const b of p.blocks){if(!groups.has(b.row))groups.set(b.row,[]);groups.get(b.row).push(b);}
  const alive=new Set();for(const [id,blocks] of groups){
    let row=[...rows.children].find(e=>e.dataset.rowId===id);if(!row){row=document.createElement('div');row.className='live-row';row.dataset.rowId=id;}
    for(const b of blocks){let el=existing.get(b.id);if(!el){el=document.createElement('section');el.dataset.blockId=b.id;el.className='live-block board-reveal';}
      el.dataset.role=b.role;el.dataset.intent=b.intent||'';markedText(el,b);row.append(el);alive.add(b.id);
    }rows.append(row);
  }
  for(const [id,el] of existing)if(!alive.has(id))el.remove();for(const row of [...rows.children])if(!row.children.length)row.remove();
  drawDiagram(p,added);
  $('liveTeacherQuestion').hidden=!p.question;$('liveTeacherQuestionText').textContent=p.question;
  followFocus(p);
}
export function applyBoardOps(ops){
  beginBoardTurn();let p=ensure(),changedPage=false,cleared=false,focusPriority=0;const added=new Set();
  const focus=(kind,id,priority)=>{if(priority>=focusPriority){p.focus={kind,id};focusPriority=priority;}};
  // A reference follows the current spoken step; persistent emphasis remains.
  for(const b of p.blocks){if(b.intent==='reference')b.intent='';b.highlights=(b.highlights||[]).filter(h=>h.intent!=='reference');}
  for(const n of p.nodes)if(n.intent==='reference')n.intent='';
  for(const op of ops){
    const text=String(op.text||'').slice(0,600),id=String(op.id||'').slice(0,80);
    if(op.action==='new_page'){
      if(!p.blocks.length&&!p.nodes.length&&!p.question){p.title=text||p.title;}
      else {p.taught=true;p=page(text||'继续讲解');pages.push(p);changedPage=true;}
      if(following)view=pages.length-1;
      focusPriority=0;
    }else if(op.action==='clear'){
      const keep=new Set(Array.isArray(op.keep)?op.keep:[]);
      p.blocks=p.blocks.filter(b=>keep.has(b.id));p.nodes=p.nodes.filter(n=>keep.has(n.id));
      const nodes=new Set(p.nodes.map(n=>n.id));p.edges=p.edges.filter(e=>nodes.has(e.from)&&nodes.has(e.to));
      p.focus=null;focusPriority=0;
      cleared=true;
    }else if(op.action==='title')p.title=text;
    else if(op.action==='add'&&id){
      let block=p.blocks.find(b=>b.id===id),anchor=p.blocks.find(b=>b.id===(op.rightOf||op.belowOf));
      if(block){block.text=text;block.role=op.role||block.role;}
      else {const lastRow=p.blocks.at(-1)?.row;block={id,text,role:op.role||'knowledge',row:op.rightOf&&anchor?.row===lastRow?lastRow:id,highlights:[]};
        p.blocks.push(block);added.add(id);}
      focus('block',id,1);
    }else if(op.action==='remove'){p.blocks=p.blocks.filter(b=>b.id!==id);p.nodes=p.nodes.filter(n=>n.id!==id);p.edges=p.edges.filter(e=>e.id!==id&&e.from!==id&&e.to!==id);}
    else if(op.action==='highlight'){
      const block=p.blocks.find(b=>b.id===id),node=p.nodes.find(n=>n.id===id),intent=['reference','inquiry','emphasis'].includes(op.intent)?op.intent:'reference';
      const style=['marker','underline','circle','box'].includes(op.style)?op.style:'marker';
      if(block){const phrase=String(op.phrase||block.text);block.highlights=(block.highlights||[]).filter(h=>h.phrase!==phrase);block.highlights.push({phrase,intent,style});}
      if(node){node.intent=intent;node.markStyle=style;}
      if(block||node)focus(node?'node':'block',id,intent==='emphasis'?2:3);
    }else if(op.action==='gesture' && op.name==='encourage'){
      window.dispatchEvent(new CustomEvent('teacher-gesture',{detail:{name:'encourage'}}));
    }else if(op.action==='layout')p.layout={columns:Number(op.columns)||3,rows:Number(op.rows)||2};
    else if(op.action==='node'&&id){const node={id,text,col:Math.max(0,Math.min(p.layout.columns-1,Number(op.col)||0)),row:Math.max(0,Math.min(p.layout.rows-1,Number(op.row)||0))};const previous=p.nodes.find(n=>n.id===id);if(previous)Object.assign(previous,node);else{p.nodes.push(node);added.add(id);}focus('node',id,1);}
    else if(op.action==='edge'&&id){const edge={id,from:String(op.from||''),to:String(op.to||''),text};const old=p.edges.find(e=>e.id===id);if(old)Object.assign(old,edge);else p.edges.push(edge);}
    else if(op.action==='question'){p.question=text;if(text)focus('question','',4);}
    else if(op.action==='student_question'&&!['queued','listening','recognizing'].includes(questionMode)){showStudentQuestion('answering',text,true);if(text)focus('student','',4);}
  }
  if(following)view=pages.length-1;
  if((cleared||changedPage)&&following)$('boardBody').scrollTo({top:0,behavior:'instant'});
  paint(added,changedPage);if(changedPage&&following)enterBoardPage();return displayedBoard();
}
$('boardPrev').onclick=()=>{if(view>0){view--;following=false;paint(new Set(),true);$('boardBody').scrollTop=0;enterBoardPage(-1);}};
$('boardNext').onclick=()=>{if(view<pages.length-1){view++;following=view===pages.length-1;paint(new Set(),true);if(!following)$('boardBody').scrollTop=0;enterBoardPage();}};
$('boardFollow').onclick=()=>{following=true;view=pages.length-1;paint(new Set(),true);};
function manualScroll(){following=false;stopBoardCamera();$('boardBody').scrollTo({top:$('boardBody').scrollTop,behavior:'instant'});controls();}
$('boardBody').addEventListener('wheel',manualScroll,{passive:true});
$('boardBody').addEventListener('touchstart',manualScroll,{passive:true});
$('boardBody').addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))manualScroll();});
controls();
