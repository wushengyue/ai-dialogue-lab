"""Explicit live checks: synthetic candidate answers, actual configured Ark model."""
import copy
import json

import ark_model
import server


if __name__ == '__main__':
    config=server.config()
    settings={**config['roles']['interviewer'],'role':'interviewer','profile':config['profile'],'provider':'ark','voice':False,'model':config['model']}
    base=server.Session(settings).doc
    question='某检查项在 10 条 case 中有 6 条达标、2 条不达标、2 条不适用，单项通过率怎么算？'
    teacher={'id':'fixture-question','role':'assistant','content':question,'heard':question,'delivery':'complete','phase':'提问','await_user':True,'steps':[{'speech':question,'ops':[{'action':'question','text':question}]}]}
    scenarios=[
        ('wrong_denominator',[teacher,{'id':'fixture-answer','role':'user','content':'应该是 60%，分母就是全部 10 条，不适用也放进去。'}],'user'),
        ('discuss_questions',[{'id':'fixture-request','role':'user','content':'Rubric 这部分面试可能怎么问？先给一道具体题，再说面试官会怎样追问、为什么。先不要考我。'}],'user'),
    ]
    records=[]
    for name,messages,event in scenarios:
        doc=copy.deepcopy(base);doc['messages']=messages;doc['phase']='提问'
        result,metrics=ark_model.generate(config['model'],settings['system'],server.compile_input(doc,event),lambda:False)
        questions=[op['text'] for step in result.get('steps',[]) for op in step.get('ops',[]) if op['action']=='question' and op.get('text')]
        records.append({'scenario':name,'synthetic_history':True,'result':result,'metrics':metrics})
        (server.DATA/'interview-verification.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
        print(json.dumps({'scenario':name,'speech':result['speech'],'phase':result['phase'],'questions':questions},ensure_ascii=False),flush=True)
        assert not any(term in result['speech'] for term in ['请介绍一个项目','介绍一段真实经历','我是三茅老师'])
        if name=='wrong_denominator':
            assert questions and result['await_user']
            assert any(mark in result['speech'] for mark in ['？','?']),'The candidate must hear the question, not only see it on the board'
            assert any(term in result['speech'] for term in ['不适用','分母'])
            assert '75%' not in result['speech'] and '百分之七十五' not in result['speech'],'Follow up on the mistake before supplying the answer'
            assert '不计入分母' not in result['speech'] and '不计入分母' not in ''.join(questions),'Do not state the corrected denominator before asking for the reasoning'
        else:
            assert '追问' in result['speech']
            assert 'Rubric' in result['speech'] and any(mark in result['speech'] for mark in ['？','?']),'Speak the concrete example question before discussing followups'
            assert result['phase']=='讲解','An explicit request to discuss questions should not keep interrogating the candidate'
            assert not questions,'Example interview questions should be explained, not treated as a live answer checkpoint'
