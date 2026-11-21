"""Session-scoped lesson tasks. Only delivered turns can advance a section."""
import copy
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent


def attach(doc):
    settings = doc['settings']
    if settings.get('course_id') != 'rubric-intro' or settings.get('role') != 'lecturer' or settings.get('provider') != 'ark':
        return
    settings['course_plan'] = json.loads((ROOT / 'content/rubric/sections.json').read_text())
    doc['lesson'] = {'index': 0, 'completed': [], 'reason': '首次进入课程'}


def current(doc):
    plan = doc['settings'].get('course_plan')
    if not plan or 'lesson' not in doc:
        return None
    return plan['sections'][doc['lesson']['index']]


def delivered(message):
    return message.get('delivery') == 'text' or (message.get('delivery') == 'complete' and message.get('heard') == message.get('content'))


def covered(doc, section):
    allowed = {m['id'] for m in section['milestones']}
    return sorted({item for m in doc['messages'] if m.get('section_id') == section['id'] and delivered(m)
                   for item in m.get('covered_milestones', []) if item in allowed})


def board_complete(doc, section):
    if section['id'] != 'rubric-03-generation':
        return True
    board = doc.get('displayed_board', {})
    return board.get('section_id') == section['id'] and len(board.get('nodes', [])) >= 3 and len(board.get('edges', [])) >= 2


def prepare(doc, event):
    section = current(doc)
    if not section:
        return
    state, plan = doc['lesson'], doc['settings']['course_plan']
    if event == 'user' and state['index'] == 0 and not any(m['role'] == 'assistant' for m in doc['messages']):
        state.update(index=1, reason='学生直接提问，先回应问题，不强制开场')
        return
    last = next((m for m in reversed(doc['messages']) if m['role'] == 'assistant'), {})
    if event != 'continue' or last.get('section_id') != section['id'] or not delivered(last) or not last.get('section_complete') or last.get('await_user'):
        return
    goals = {m['id'] for m in section['milestones']}
    if not last.get('section_skipped') and (not goals.issubset(covered(doc, section)) or not board_complete(doc, section)):
        return
    if state['index'] < len(plan['sections']) - 1:
        state['completed'].append({'id': section['id'], 'status': 'skipped' if last.get('section_skipped') else 'delivered'})
        state['index'] += 1
        state['reason'] = '上一节已播完，问题已处理，注入下一节 User；已讲完不等于已掌握'


def info(doc):
    section = current(doc)
    if not section:
        return None
    return {'id': section['id'], 'title': section['title'], 'index': doc['lesson']['index'] + 1,
            'total': len(doc['settings']['course_plan']['sections']),
            'enter': doc.get('displayed_board', {}).get('section_id') != section['id']}


def scope_input(doc, result):
    section = current(doc)
    if not section:
        return result
    plan, state = doc['settings']['course_plan'], doc['lesson']
    result['本次任务'] = copy.deepcopy(section)
    result['本次任务'].pop('material', None)
    result['课程通用要求'] = doc['settings']['task']
    result['专业材料（仅作内容依据）'] = section['material']
    if doc['settings']['material'] != (ROOT / 'content/rubric/material.md').read_text():
        result['用户编辑的补充资料'] = doc['settings']['material']
    result['课程'] = {'id': plan['course_id'], 'title': plan['spoken_title'], 'preview': plan['preview'],
                    'teacher_intro': plan['teacher_intro'], 'outline': [{'id': s['id'], 'title': s['title']} for s in plan['sections']]}
    result['运行状态']['当前环节'] = {**info(doc), '已实际讲过的目标': covered(doc, section),
        '已完成环节': state['completed'], '进入原因': state['reason'], '图示要求已呈现': board_complete(doc, section)}
    # Preserve actual student turns and a short spoken handoff, without putting
    # the entire course script and every previous answer into the next task.
    pairs = list(zip(doc['messages'], result['对话历史']))
    result['对话历史'] = [view for raw, view in pairs if raw.get('section_id') == section['id']][-12:]
    previous = next((m for m in reversed(doc['messages']) if m['role'] == 'assistant' and m.get('section_id') != section['id'] and delivered(m)), None)
    result['上一环节交接'] = previous.get('heard', previous.get('content', ''))[-600:] if previous else ''
    pending = result['运行状态']['尚未处理的学生发言']
    # Small, explicit retrieval for an interruption about another topic.
    keywords = {'rubric-03-generation': ['两路', '两版', '配置', 'Prompt'], 'rubric-04-judge': ['裁判', '评分标准', '判卷', '维度'],
                'rubric-05-gate': ['PASS', 'FAIL', 'Must-have', '必需项', '否决'], 'rubric-06-rates': ['分母', '通过率', 'N/A'],
                'rubric-07-comparison': ['爬楼', '楼层', '数学答案', 'V2']}
    text = ' '.join(pending).casefold()
    related = [s for s in plan['sections'] if s['id'] != section['id'] and any(k.casefold() in text for k in keywords.get(s['id'], []))][:2]
    if related:
        result['针对插问补充的资料'] = [{'section_id': s['id'], 'material': s['material']} for s in related]
    result['本轮行动'] += ' 当前环节规定默认教学顺序，不是拒答边界。学生主动问到后续内容时，先用补充资料直接回答，不得用“下一节再讲”挡回，也不得强迫先回答旧问题；回答后再衔接本节。没有跨节插问时不自行展开后续内容。只有本节目标完成且没有待回答问题，才报告 section_complete=true；下一节由后端另发 User。'
    return result


def page_ops(doc, ops):
    if not current(doc):
        return ops
    # The runtime owns page transitions; the model can refine the current title.
    return [{**op, 'action': 'title'} if op.get('action') == 'new_page' else op for op in ops]


def finish(doc, result, event, text):
    section = current(doc)
    if not section:
        return result
    result['section_id'] = section['id']
    allowed = {m['id'] for m in section['milestones']}
    reported = result.get('covered_milestones', [])
    result['covered_milestones'] = [m for m in reported if isinstance(m, str) and m in allowed] if isinstance(reported, list) else []
    result['section_complete'] = result.get('section_complete') is True and not result['await_user']
    result['section_skipped'] = bool(event == 'user' and re.fullmatch(r'(?:请)?(?:跳过(?:这[一]?节|当前环节)?|直接(?:进入)?下一节)[。！!\s]*', text)) and result['section_complete']
    result['done'] = bool(doc['lesson']['index'] == len(doc['settings']['course_plan']['sections']) - 1 and result['section_complete'] and
                          allowed.issubset(set(covered(doc, section)) | set(result['covered_milestones'])))
    for step in result.get('steps', []):
        step['ops'] = page_ops(doc, step.get('ops', []))
    if result.get('steps'):
        result['board']['operations'] = [op for step in result['steps'] for op in step['ops']]
    return result
