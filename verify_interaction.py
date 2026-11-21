"""Real model checks using explicit synthetic classroom histories."""
import copy
import json
from pathlib import Path

import ark_model
import server

ROOT=Path(__file__).resolve().parent

def teacher(text,question=''):
    return {'id':'fixture-teacher','role':'assistant','content':text,'heard':text,'delivery':'complete','await_user':bool(question),'phase':'轻互动' if question else '讲解','steps':[{'speech':text,'ops':[{'action':'question','text':question}]}]}

if __name__=='__main__':
    c=server.config()
    settings={**c['roles']['lecturer'],'role':'lecturer','voice':True,'profile':c['profile'],'provider':'ark','model':c['model']}
    base=server.Session(settings).doc;base['phase']='讲解'
    explanation='这张图采用 Must-have 否决制。任意一个必需项不达标，整条 FAIL；没有必需项不达标，整条 PASS。Nice-to-have 不决定整条能否通过。'
    question='所有 Must-have 都达标，只有一项 Nice-to-have 不达标，整条 PASS 还是 FAIL？为什么？'
    scenarios=[
        ('check_after_explanation',[teacher(explanation)],'continue'),
        ('correct_reason',[teacher(explanation),teacher(question,question),{'id':'fixture-answer','role':'user','content':'整条应该 PASS，因为 Must-have 全部达标，Nice-to-have 不参与否决。'}],'user'),
        ('wrong_reason',[teacher(explanation),teacher(question,question),{'id':'fixture-answer','role':'user','content':'我觉得整条 FAIL，只要有一项不达标就不能通过，不管它是哪种项。'}],'user'),
        ('grading_analogy',[{'id':'fixture-question','role':'user','content':'请用判卷的例子讲清 Rubric 和裁判模型的关系，再解释各项和整体结果怎么得到。'}],'user'),
    ]
    records=[]
    for name,messages,event in scenarios:
        doc=copy.deepcopy(base);doc['messages']=messages
        if 'lesson' in doc:
            doc['lesson']['index']=3 if name=='grading_analogy' else 4
            section=doc['settings']['course_plan']['sections'][doc['lesson']['index']]
            for message in messages:message['section_id']=section['id']
        user=server.compile_input(doc,event);chunks=[]
        result,metrics=ark_model.generate(c['model'],settings['system'],user,lambda:False,on_speech=lambda text,timing:chunks.append(text))
        assert ''.join(chunks)==result['speech']
        assert '我是三茅老师' not in result['speech'],'User and continue events must not restart the introduction'
        questions=[(i,op['text']) for i,step in enumerate(result.get('steps',[])) for op in step.get('ops',[]) if op['action']=='question' and op.get('text')]
        if questions:
            assert result['await_user']
            assert questions[-1][0]==len(result['steps'])-1,'Question must be last, without self-answering'
            assert not any(term in questions[-1][1] for term in ['想先听','想先看','希望怎么讲','听懂了吗'])
        record={'scenario':name,'synthetic_history':True,'result':result,'metrics':metrics}
        records.append(record)
        (ROOT/'data/interaction-verification.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
        print(json.dumps({'scenario':name,'speech':result['speech'],'questions':questions,'await_user':result['await_user'],'gestures':[op for op in result['board']['operations'] if op['action']=='gesture']},ensure_ascii=False),flush=True)
        if name=='check_after_explanation':assert questions,'Key content needs a comprehension question'
        if name=='wrong_reason':assert any(term in result['speech'] for term in ['必需项','Must-have'])
