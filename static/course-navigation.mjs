// Course selection stays on the only prepared content pack, Rubric.
export function initCourseNavigation() {
  const shell=document.getElementById('classroomShell'),nav=document.getElementById('courseNav');
  const button=document.getElementById('courseToggle'),list=document.getElementById('courseList');
  const compact=matchMedia('(max-width:900px)'),key='classroom.courseDirectory.collapsed.v1';
  let collapsed=compact.matches;
  try { const saved=localStorage.getItem(key);if(saved!==null&&!compact.matches)collapsed=saved==='true'; } catch { /* Use the viewport default. */ }
  function render(remember=false) {
    shell.dataset.courses=collapsed?'collapsed':'expanded';list.hidden=collapsed;
    button.setAttribute('aria-expanded',String(!collapsed));
    button.setAttribute('aria-label',collapsed?'展开课程目录':'收起课程目录');button.title=button.getAttribute('aria-label');
    if(remember)try{localStorage.setItem(key,String(collapsed));}catch{ /* Navigation still works without storage. */ }
  }
  button.onclick=()=>{collapsed=!collapsed;render(true);};
  nav.addEventListener('keydown',event=>{if(event.key==='Escape'&&!collapsed){collapsed=true;render(true);button.focus();}});
  compact.addEventListener('change',event=>{if(event.matches){collapsed=true;render();}});
  new ResizeObserver(()=>nav.style.setProperty('--course-top',`${document.querySelector('.topbar').getBoundingClientRect().bottom+8}px`)).observe(document.querySelector('.topbar'));
  render();
}
