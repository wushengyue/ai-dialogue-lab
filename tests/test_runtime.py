import sys
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def settings():
    return dict(role="lecturer", model="test", system="仅讲解", task="说明一个概念", material="核实过的材料", profile={"level": "未知"}, voice=True)


class RuntimeTests(unittest.TestCase):
    def test_interrupted_history_uses_only_heard_prefix(self):
        session = server.Session(settings())
        session.doc["messages"] = [{"role": "assistant", "content": "第一句。第二句。", "delivery": "interrupted", "heard": "第一句。"}]
        context = server.compile_input(session.doc, "user")
        text = context["对话历史"][0]["content"]
        self.assertIn("第一句。", text)
        self.assertNotIn("第二句。", text)

    def test_generated_but_unplayed_audio_is_not_assumed_heard(self):
        session = server.Session(settings())
        session.doc["messages"] = [{"role": "assistant", "content": "尚未播出的讲解", "delivery": "pending", "heard": ""}]
        context = server.compile_input(session.doc, "continue")
        self.assertNotIn("尚未播出的讲解", context["对话历史"][0]["content"])

    def test_cancelled_late_response_never_enters_history(self):
        entered, release = threading.Event(), threading.Event()
        session = server.Session(settings())
        server.REGISTRY[session.doc["id"]] = session
        returned = []
        def fake_model(*args):
            entered.set(); release.wait(3)
            return dict(speech="旧回复", phase="讲解", await_user=False, done=False, adaptation=""), {}
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, "SESSIONS", Path(tmp)), patch.object(server, "codex_turn", fake_model):
            worker = threading.Thread(target=lambda: returned.append(server.perform_turn({"session_id": session.doc["id"], "event": "start"})))
            worker.start(); self.assertTrue(entered.wait(2))
            with session.guard: session.generation += 1
            release.set(); worker.join(3)
        self.assertEqual(returned, [{"cancelled": True}])
        self.assertEqual(session.doc["messages"], [])

    def test_busy_turn_rejected_before_user_message_is_appended(self):
        session = server.Session(settings()); server.REGISTRY[session.doc["id"]] = session
        session.busy.acquire()
        try:
            with self.assertRaises(ValueError):
                server.perform_turn({"session_id": session.doc["id"], "text": "新回答"})
            self.assertEqual(session.doc["messages"], [])
        finally: session.busy.release()

    def test_session_identifier_cannot_read_arbitrary_files(self):
        for name in ("../config", "/etc/passwd", ""):
            with self.assertRaises(ValueError): server.session_for(name)

    def test_unheard_question_is_not_treated_as_already_asked(self):
        session=server.Session(settings())
        teacher={'role':'assistant','content':'讲解。为什么？','heard':'讲解。','delivery':'interrupted','await_user':True,'steps':[{'speech':'为什么？','ops':[{'action':'question','text':'关键依据是什么？'}]}]}
        session.doc['messages']=[teacher]
        self.assertEqual(server.compile_input(session.doc,'user')['上个已播出的老师问题'],'')
        teacher.update(delivery='complete',heard=teacher['content'])
        self.assertEqual(server.compile_input(session.doc,'user')['上个已播出的老师问题'],'关键依据是什么？')

    def test_content_question_requires_waiting_instead_of_autoadvancing(self):
        from board_protocol import normalize
        result=normalize({'steps':[{'speech':'你会怎样判断？','ops':[{'action':'question','text':'判断依据是什么？'}]}],'await_user':False,'done':True})
        self.assertTrue(result['await_user']);self.assertFalse(result['done'])


if __name__ == "__main__": unittest.main()
