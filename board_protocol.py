"""Read complete speech steps as JSON arrives; board ops never execute code."""
import json
import re
from local_models import speech_progress

ACTIONS={'new_page','title','add','remove','clear','highlight','layout','node','edge','question','student_question','gesture'}


def step_progress(raw):
    match=re.search(r'"steps"\s*:\s*\[',raw)
    if not match:
        text,done=speech_progress(raw)
        return [(0,text,done,None)] if text else []
    position=match.end();output=[];decoder=json.JSONDecoder()
    while position<len(raw):
        while position<len(raw) and raw[position] in ' \r\n\t,':position+=1
        if position>=len(raw) or raw[position]==']':break
        if raw[position]!='{':break
        try:
            step,end=decoder.raw_decode(raw,position)
        except json.JSONDecodeError:
            text,done=speech_progress(raw[position:]);output.append((len(output),text,done,None));break
        output.append((len(output),step.get('speech',''),True,step.get('ops',[])))
        position=end
    return output


def validate_ops(ops, warnings=None):
    """Invalid visual operations are isolated; valid speech must keep playing."""
    warnings = warnings if warnings is not None else []
    def skip(reason):
        if reason not in warnings: warnings.append(reason)
    if not isinstance(ops,list):
        skip('板书操作不是数组，已跳过本步板书'); return []
    valid=[]
    if len(ops)>12: skip('本步超过 12 条板书操作，已忽略超出部分')
    for op in ops[:12]:
        if not isinstance(op,dict):
            skip('板书操作格式无效，已跳过'); continue
        action=op.get('action')
        if not isinstance(action,str) or action not in ACTIONS:
            skip('不支持的板书操作已跳过：'+str(action)[:60]); continue
        if any(isinstance(value,str) and len(value)>600 for value in op.values()):
            skip('板书文字过长，已跳过该操作'); continue
        if action=='clear':
            keep=op.get('keep',[])
            if not isinstance(keep,list) or len(keep)>30 or any(not isinstance(item,str) or len(item)>80 for item in keep):
                skip('清板保留项无效，已跳过清板'); continue
        valid.append(op)
    return valid


def normalize(result, warnings=None):
    if 'steps' not in result:return result
    steps=result['steps']
    if not isinstance(steps,list) or not 1<=len(steps)<=8:raise ValueError('讲解步骤格式不正确')
    warnings = warnings if warnings is not None else []
    for step in steps:
        if not isinstance(step.get('speech'),str) or not step['speech'].strip():raise ValueError('讲解步骤缺少话术')
        step['ops']=validate_ops(step.get('ops',[]),warnings)
    result['speech']=''.join(step['speech'] for step in steps)
    result['board']={'type':'staged','operations':[op for step in steps for op in step.get('ops',[])]}
    if result.get('phase') not in ('开场','讲解','轻互动','提问','追问','结束'):
        result['phase']='讲解'
        warnings.append('模型未提供有效阶段，按讲解继续')
    if not isinstance(result.get('await_user'),bool):result['await_user']=bool(re.search(r'[？?]',steps[-1]['speech']))
    if not isinstance(result.get('done'),bool):result['done']=False
    if not isinstance(result.get('adaptation'),str):result['adaptation']=''
    questions=[op for op in result['board']['operations'] if op['action']=='question']
    if questions and str(questions[-1].get('text','')).strip():
        result['await_user']=True
        result['done']=False
    if warnings: result['board_warnings']=list(warnings)
    return result
