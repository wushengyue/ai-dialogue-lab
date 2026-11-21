import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import httpx

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import ark_model
import local_models
from local_models import speech_progress
from speech_markup import parts,plain_text,phrase_boundary


class StreamingTests(unittest.TestCase):
    def test_incomplete_escaped_speech_does_not_leak_json_or_surrogates(self):
        raw = '{"speech":"先看\\"必需项\\"。\\ud83d'
        self.assertEqual(speech_progress(raw),('先看"必需项"。',False))
        self.assertEqual(speech_progress(raw+'\\ude00"'),('先看"必需项"。😀',True))

    def test_speech_end_is_available_before_board(self):
        self.assertEqual(speech_progress('{"speech":"不适用不算错。","board":'),('不适用不算错。',True))

    def test_prosody_markers_never_become_spoken_words(self):
        text='[慢]先看[重读]必需项[/重读]。[/慢][停顿:300][快]再看加分项。[/快]'
        result=parts(text)
        self.assertEqual(''.join(p.text for p in result),'先看必需项。再看加分项。')
        self.assertEqual(sum(p.pause_ms for p in result),300)
        stress=next(p for p in result if p.text=='必需项')
        self.assertLess(stress.speed,1);self.assertGreater(stress.gain,1)
        self.assertEqual(plain_text(text),'先看必需项。再看加分项。')

    def test_stream_never_splits_a_prosody_span(self):
        raw='[慢]整条案例通过与否，要逐一检查必需项。'
        self.assertEqual(phrase_boundary(raw,first=True),0)
        self.assertEqual(phrase_boundary(raw+'[/慢]',first=True),len(raw+'[/慢]'))

    def test_english_stream_keeps_words_and_decimal_numbers_intact(self):
        text='First we review the important evaluation Rubric criteria together.'
        boundary=phrase_boundary(text,first=True)
        self.assertGreater(boundary,0)
        self.assertTrue(text[boundary-1].isspace())
        self.assertFalse(text[boundary-1].isalpha() and text[boundary].isalpha())
        self.assertEqual(phrase_boundary('The score is 3.5 and rising',first=True),0)
        sentence='The Rubric defines each criterion.'
        self.assertEqual(phrase_boundary(sentence+' Next we compare both replies.',first=True),len(sentence))

    def test_tts_preserves_english_terms_instead_of_translating(self):
        import numpy as np
        from unittest.mock import Mock
        text='Rubric, Must-have, Nice-to-have, PASS, FAIL, case, N/A。中文解释另说。'
        g2p=Mock(return_value=('test phonemes',None))
        tts=Mock();tts.create.return_value=(np.zeros(2400,dtype=np.float32),24000)
        with tempfile.TemporaryDirectory() as directory,patch.object(local_models,'_tts',tts),patch.object(local_models,'_g2p',g2p):
            local_models.synthesize(text,Path(directory)/'speech.wav')
        g2p.assert_called_once_with(text)
        self.assertEqual(tts.create.call_args.kwargs['voice'],'zm_011')

    def test_remote_stream_forwards_phrase_before_final_board(self):
        observed=[]
        result={'speech':'数学正确还不能代表整条案例通过。','board':{},'await_user':False,'done':False}
        prefix=json.dumps({'speech':result['speech']},ensure_ascii=False)[:-1]+','
        def transport(request):
            body=json.loads(request.content)
            self.assertTrue(body['stream']);self.assertEqual(body['thinking'],{'type':'disabled'})
            self.assertNotIn('tools',body)
            def events():
                yield ('data: '+json.dumps({'type':'response.output_text.delta','delta':prefix})+'\n\n').encode()
                self.assertTrue(observed,'Speech must reach TTS before the board finishes')
                tail=json.dumps(result,ensure_ascii=False).split(',',1)[1]
                yield ('data: '+json.dumps({'type':'response.output_text.delta','delta':tail})+'\n\n').encode()
                yield b'data: {"type":"response.completed","response":{"usage":{}}}\n\n'
            return httpx.Response(200,content=events())
        with patch.object(ark_model,'CLIENT',httpx.Client(transport=httpx.MockTransport(transport))),patch.object(ark_model,'api_key',return_value='fixture-key'):
            actual,_=ark_model.generate('test','',{},lambda:False,lambda text,timing:observed.append(text))
        self.assertEqual(actual,result)
        self.assertEqual(''.join(observed),result['speech'])

    def test_malformed_metadata_tail_preserves_streamed_speech(self):
        observed=[]
        raw='{"steps":[{"speech":"先按标准逐项判断。","ops":[{"action":"not_supported"},{"action":"add","id":"key","text":"逐项判断"}]}],"phase":'
        events='data: '+json.dumps({'type':'response.output_text.delta','delta':raw})+'\n\n'
        events+='data: {"type":"response.completed","response":{"usage":{}}}\n\n'
        client=httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(200,text=events)))
        with patch.object(ark_model,'CLIENT',client),patch.object(ark_model,'api_key',return_value='fixture-key'):
            result,_=ark_model.generate('test','',{},lambda:False,lambda text,timing:observed.append(text))
        self.assertEqual(''.join(observed),'先按标准逐项判断。')
        self.assertEqual(result['speech'],''.join(observed))
        self.assertEqual(result['board']['operations'][0]['action'],'add')
        self.assertFalse(result['section_complete'])
        self.assertTrue(result['board_warnings'])


if __name__=='__main__':unittest.main()
