const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
function svg(name, attributes = {}, value) {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, String(v));
  if (value !== undefined) el.textContent = value;
  return el;
}

function highlight(el, value, phrases) {
  const text = String(value || '');
  const terms = phrases.filter(x => typeof x === 'string' && x && text.includes(x));
  el.replaceChildren();
  let cursor = 0;
  while (cursor < text.length) {
    const found = terms.map(t => ({t, i: text.indexOf(t, cursor)})).filter(v => v.i >= 0).sort((a, b) => a.i - b.i || b.t.length - a.t.length)[0];
    if (!found) { el.append(document.createTextNode(text.slice(cursor))); break; }
    el.append(document.createTextNode(text.slice(cursor, found.i)));
    const mark = document.createElement('mark'); mark.textContent = found.t; el.append(mark); cursor = found.i + found.t.length;
  }
}

function renderDiagram(diagram) {
  const host = $('boardDiagram'); host.replaceChildren();
  const nodes = Array.isArray(diagram?.nodes) ? diagram.nodes.filter(n => n?.id && n?.label).slice(0, 8) : [];
  host.hidden = !nodes.length;
  if (!nodes.length) return;
  const ids = new Set(nodes.map(n => n.id));
  const edges = (Array.isArray(diagram.edges) ? diagram.edges : []).filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).slice(0, 12);
  const level = new Map(nodes.map(n => [n.id, 0]));
  // Bounded passes also make malformed cyclic graphs safe to render.
  for (let pass = 0; pass < nodes.length - 1; pass++) for (const e of edges) level.set(e.to, Math.min(nodes.length - 1, Math.max(level.get(e.to), level.get(e.from) + 1)));
  const groups = [...new Set(level.values())].sort((a, b) => a - b).map(k => nodes.filter(n => level.get(n.id) === k));
  const rowCount = Math.max(...groups.map(g => g.length));
  const height = Math.max(110, rowCount * 62), width = 1000, nodeW = Math.min(200, (width - (groups.length - 1) * 42) / groups.length), nodeH = 46;
  const positions = new Map();
  groups.forEach((group, column) => group.forEach((node, row) => positions.set(node.id, {x: groups.length === 1 ? (width - nodeW) / 2 : column * (width - nodeW) / (groups.length - 1), y: (row + .5) * height / group.length - nodeH / 2})));
  const root = svg('svg', {viewBox: `-3 -4 ${width + 6} ${height + 8}`, role: 'img', 'aria-label': nodes.map(n => n.label).join('；')});
  const defs = svg('defs'), marker = svg('marker', {id: 'diagram-arrow', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto'});
  marker.append(svg('path', {d: 'M0 0L7 3.5L0 7Z', fill: '#93a9d0'})); defs.append(marker); root.append(defs);
  edges.forEach(e => {
    const a = positions.get(e.from), b = positions.get(e.to), x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x - 4, y2 = b.y + nodeH / 2, mid = (x1 + x2) / 2;
    root.append(svg('path', {d: `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`, fill: 'none', stroke: '#93a9d0', 'stroke-width': 2, 'marker-end': 'url(#diagram-arrow)'}));
    if (e.label) root.append(svg('text', {x: mid, y: (y1 + y2) / 2 - 9, 'text-anchor': 'middle', fill: '#7d90ad', 'font-size': 12}, String(e.label).slice(0, 10)));
  });
  nodes.forEach(n => {
    const p = positions.get(n.id); root.append(svg('rect', {x: p.x, y: p.y, width: nodeW, height: nodeH, rx: 9, fill: '#f1f5ff', stroke: '#cbd9f3'}));
    const lines = String(n.label).match(/.{1,10}/gu)?.slice(0, 2) || [];
    lines.forEach((line, i) => root.append(svg('text', {x: p.x + nodeW / 2, y: p.y + nodeH / 2 + (i - (lines.length - 1) / 2) * 21 + 6, 'text-anchor': 'middle', fill: '#35588f', 'font-size': 20}, line)));
  });
  host.append(root);
}

export function renderBoardContent(board) {
  const phrases = Array.isArray(board?.highlight) ? board.highlight.slice(0, 5) : [];
  $('studentQuestionWrap').hidden=!board?.student_question; highlight($('studentQuestion'),board?.student_question,phrases);
  const solution=Array.isArray(board?.solution) ? board.solution.slice(0,3) : [];
  $('boardSolutionWrap').hidden=!solution.length; $('boardSolution').replaceChildren();
  solution.forEach(text=>{const li=document.createElement('li');highlight(li,text,phrases);$('boardSolution').append(li);});
  $('boardPoints').replaceChildren();
  const points = Array.isArray(board?.points) ? board.points.slice(0, 5) : [];
  points.forEach(p => { const li = document.createElement('li'); highlight(li, p, phrases); $('boardPoints').append(li); });
  $('boardPoints').hidden = !points.length;
  $('boardDetails').dataset.single = String(!points.length || !solution.length);
  const flow = Array.isArray(board?.flow) ? board.flow.slice(0, 5) : [];
  $('boardFlow').replaceChildren();
  flow.forEach(p => { const li = document.createElement('li'); highlight(li, p, phrases); $('boardFlow').append(li); });
  $('boardFlow').hidden = !flow.length;
  renderDiagram(board?.diagram);
  const columns = Array.isArray(board?.table?.columns) ? board.table.columns.slice(0, 4) : [];
  const rows = Array.isArray(board?.table?.rows) ? board.table.rows.slice(0, 5) : [];
  $('boardTable').replaceChildren(); $('boardTableWrap').hidden = !columns.length || !rows.length;
  if (columns.length && rows.length) {
    const head = document.createElement('thead'), body = document.createElement('tbody'), header = document.createElement('tr');
    columns.forEach(c => { const th = document.createElement('th'); highlight(th, c, phrases); header.append(th); }); head.append(header);
    rows.forEach(row => { const tr = document.createElement('tr'); columns.forEach((c, i) => { const td = document.createElement('td'); highlight(td, row.cells?.[i] || '', phrases); tr.append(td); }); body.append(tr); });
    $('boardTable').append(head, body);
  }
  $('boardExampleWrap').hidden = !board?.example; highlight($('boardExample'), board?.example, phrases);
  $('boardQuestionWrap').hidden = !board?.question; highlight($('boardQuestion'), board?.question, phrases);
  requestAnimationFrame(fitBoardContent);
}

export function fitBoardContent() {
  const content = $('boardContent'), body = content.parentElement;
  content.style.transform = '';
  content.style.setProperty('--content-density',1);
}
