const $ = id => document.getElementById(id);
let frame = 0, level = 0, gestureTimer = null;
const labels = {off:'麦克风关闭',ready:'麦克风已开',listening:'老师在听',recognizing:'正在识别',received:'已收到',error:'未提交，请重说'};

export function listeningFeedback(state, value = 0) {
  const host = $('listeningFeedback');
  if (!host) return;
  if (host.dataset.state !== state) {
    host.dataset.state = state;
    $('listeningLabel').textContent = labels[state] || labels.off;
    host.setAttribute('aria-label', labels[state] || labels.off);
  }
  level = state === 'listening' ? Math.min(1, Math.max(0, Number(value) || 0)) : 0;
  // AudioWorklet level messages can arrive hundreds of times per second.
  // Update the visual only once per frame and keep audio processing independent.
  if (!frame) frame = requestAnimationFrame(() => {
    host.style.setProperty('--voice-amplitude', String(.16 + Math.sqrt(level) * 1.2));
    host.style.setProperty('--voice-energy', String(level));
    frame = 0;
  });
}

export function clearTeacherGesture() {
  clearTimeout(gestureTimer);
  $('teacherAvatar').dataset.gesture = '';
}

window.addEventListener('teacher-gesture', event => {
  if (event.detail?.name !== 'encourage' || $('teacherAvatar').dataset.state === 'listening') return;
  clearTeacherGesture();
  $('teacherAvatar').dataset.gesture = 'encourage';
  gestureTimer = setTimeout(clearTeacherGesture, 2800);
});
