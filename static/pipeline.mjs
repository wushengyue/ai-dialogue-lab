const steps = [['capture','收音 / 输入'],['asr','语音转文字'],['submit','提交模型'],['model','生成回复'],['tts','生成语音'],['board','呈现板书'],['play','语音播放']];
const times = new Map();
let origin = 0, firstAudio = false;
export function initPipeline() {
  const host = document.getElementById('pipelineSteps');
  for (const [id,label] of steps) {
    const item = document.createElement('li'); item.id = 'pipe-'+id; item.dataset.state='idle';
    const name = document.createElement('span'); name.className='pipe-name'; name.textContent=label;
    const detail = document.createElement('small'); detail.textContent='等待'; item.append(name,detail); host.append(item);
  }
}
export function step(id, state, detail = '') {
  const el = document.getElementById('pipe-'+id); if (!el) return;
  if (state === 'running' && !times.has(id)) times.set(id,performance.now());
  el.dataset.state=state;
  const duration = times.has(id) ? (performance.now()-times.get(id))/1000 : 0;
  el.querySelector('small').textContent=detail || ({idle:'等待',running:'进行中',done:duration ? `完成 ${duration.toFixed(1)}s` : '完成',error:'失败',skip:'无需此步',cancelled:'已中断'}[state]);
  el.title = el.querySelector('.pipe-name').textContent + '：' + el.querySelector('small').textContent;
}
export function beginPipeline(mode, at = performance.now()) {
  times.clear(); origin=at; firstAudio=false;
  for (const [id] of steps) step(id,'idle');
  document.getElementById('firstAudioMetric').textContent='首声：等待';
  document.getElementById('ttftMetric').textContent='TTFT：等待';
  step('capture', mode === 'start' ? 'skip' : 'done', mode === 'text' ? '文字已输入' : mode === 'voice' ? '录音已结束' : '老师主动开场');
  if (mode !== 'voice') step('asr','skip','无需识别');
}
export function markFirstAudio() {
  if (firstAudio) return null;
  firstAudio=true; const ms=Math.round(performance.now()-origin);
  document.getElementById('firstAudioMetric').textContent=`首声：${(ms/1000).toFixed(2)}s`;
  return ms;
}
export function cancelPipeline() {
  for (const [id] of steps) if (document.getElementById('pipe-'+id)?.dataset.state==='running') step(id,'cancelled');
}
