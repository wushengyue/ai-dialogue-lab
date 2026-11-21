import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lesson_sections as sections
import server
from board_protocol import normalize, validate_ops


def classroom():
    settings = server.default_config()['roles']['lecturer']
    return server.Session({**settings, 'role': 'lecturer', 'provider': 'ark', 'model': 'test', 'voice': True, 'profile': {'name': '吴同学'}}).doc


def completion(doc, delivery='complete'):
    section = sections.current(doc)
    return {'role': 'assistant', 'content': '已经讲完。', 'heard': '已经讲完。', 'delivery': delivery,
            'section_id': section['id'], 'section_complete': True, 'await_user': False,
            'covered_milestones': [m['id'] for m in section['milestones']]}


class SectionTests(unittest.TestCase):
    def test_pending_or_interrupted_speech_never_advances(self):
        for delivery in ('pending', 'interrupted'):
            doc = classroom(); doc['messages'] = [completion(doc, delivery)]
            sections.prepare(doc, 'continue')
            self.assertEqual(doc['lesson']['index'], 0)

    def test_delivered_completion_injects_only_the_next_section(self):
        doc = classroom(); doc['messages'] = [completion(doc)]
        sections.prepare(doc, 'continue')
        context = server.compile_input(doc, 'continue')
        self.assertEqual(context['本次任务']['id'], 'rubric-02-case')
        self.assertNotIn('六分钟', str(context['专业材料（仅作内容依据）']))
        self.assertNotIn('### 7.', context['课程通用要求'])
        self.assertEqual(context['上一环节交接'], '已经讲完。')

    def test_new_student_input_stays_in_current_section(self):
        doc = classroom(); doc['messages'] = [completion(doc)]
        sections.prepare(doc, 'user')
        self.assertEqual(doc['lesson']['index'], 0)

    def test_question_and_missing_diagram_prevent_advance(self):
        doc = classroom(); doc['messages'] = [completion(doc)]
        doc['messages'][-1]['await_user'] = True
        sections.prepare(doc, 'continue'); self.assertEqual(doc['lesson']['index'], 0)
        doc['lesson']['index'] = 2; doc['messages'] = [completion(doc)]
        sections.prepare(doc, 'continue'); self.assertEqual(doc['lesson']['index'], 2)
        doc['displayed_board'] = {'section_id': sections.current(doc)['id'], 'nodes': [{}, {}, {}], 'edges': [{}, {}]}
        sections.prepare(doc, 'continue'); self.assertEqual(doc['lesson']['index'], 3)

    def test_model_cannot_insert_pages_or_end_the_course_early(self):
        doc = classroom()
        result = normalize({'steps': [{'speech': '一个重点。', 'ops': [{'action': 'new_page', 'text': '当前重点'}]}],
                            'await_user': False, 'done': True, 'section_complete': True})
        result = sections.finish(doc, result, 'start', '')
        self.assertFalse(result['done'])
        self.assertEqual(result['steps'][0]['ops'][0]['action'], 'title')

    def test_invalid_board_operations_do_not_discard_valid_speech(self):
        result = normalize({'steps': [{'speech': '讲解继续。', 'ops': [None, {'action': ['bad']}, {'action': 'animate_text'},
            {'action': 'clear', 'keep': 'invalid'}, {'action': 'add', 'id': 'key', 'text': '仍可呈现'}]}], 'await_user': False, 'done': False, 'phase': '讲解'})
        self.assertEqual(result['speech'], '讲解继续。')
        self.assertEqual(len(result['steps'][0]['ops']), 1)
        self.assertEqual(result['steps'][0]['ops'][0]['action'], 'add')
        self.assertEqual(len(result['board_warnings']), 4)
        self.assertEqual(validate_ops('invalid'), [])

    def test_missing_metadata_keeps_usable_speech(self):
        result = normalize({'steps': [{'speech': '依据是什么？', 'ops': []}]})
        self.assertEqual(result['phase'], '讲解')
        self.assertTrue(result['await_user'])
        self.assertFalse(result['done'])


if __name__ == '__main__': unittest.main()
