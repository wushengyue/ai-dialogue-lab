"""Small explicit prosody syntax; no inferred emotions or arbitrary SSML."""
from dataclasses import dataclass
import re

TAG = re.compile(r'\[(/?)(重读|慢|快)\]|\[停顿[:：](\d{1,4})\]')


@dataclass
class Part:
    text: str = ''
    speed: float = 1.0
    gain: float = 1.0
    pause_ms: int = 0


def plain_text(text):
    return TAG.sub('',text)


def parts(text):
    result, stack, cursor = [], [], 0
    def append(value):
        if value.strip():
            speed = .84 if '慢' in stack else 1.18 if '快' in stack else 1.0
            if '重读' in stack: speed *= .94
            result.append(Part(value,speed,1.22 if '重读' in stack else 1.0))
    for match in TAG.finditer(text):
        append(text[cursor:match.start()]); cursor=match.end()
        closing,name,pause=match.groups()
        if pause is not None: result.append(Part(pause_ms=min(int(pause),2000)))
        elif closing:
            if name in stack: stack.pop(len(stack)-1-stack[::-1].index(name))
        else: stack.append(name)
    append(text[cursor:])
    return result


def phrase_boundary(text, first=False, done=False):
    """Return a raw-text boundary without cutting an open prosody span/tag."""
    if done: return len(text)
    minimum=8 if first else 16
    count,depth,i,last_boundary=0,0,0,0
    while i<len(text):
        tag=TAG.match(text,i)
        if tag:
            closing,name,pause=tag.groups()
            if name: depth=max(0,depth-1) if closing else depth+1
            i=tag.end()
            if not depth and last_boundary and count>=minimum: return i
            continue
        if text[i]=='[' and ']' not in text[i:]: break
        count+=1
        # A period needs following whitespace so streaming decimals, versions,
        # and a partially received English word are not mistaken for sentence ends.
        punctuation=text[i] in '，。！？；：!?;,:'
        period=text[i]=='.' and i+1<len(text) and text[i+1].isspace()
        if punctuation or period:
            last_boundary=i+1
            if not depth and count>=minimum:
                candidate=plain_text(text[:i+1])
                if first:
                    candidate=re.sub(r'^.{1,8}同学[，,、]?','',candidate)
                    candidate=re.sub(r'你好[呀啊]?|您好|你问到了关键|你问得很好|我们来看看|收到|我想想|[，。！？：!?;\s]','',candidate)
                    if len(candidate)<5:i+=1;continue
                return i+1
        # Never send half an English word to the phonemizer just to meet a
        # character count. The next word boundary (or speech end) releases it.
        if not depth and count>=52 and not re.match(r"[A-Za-z0-9_'’/\-]",text[i]):return i+1
        i+=1
    return 0
