"""Resume bounded HTTP ranges without curl retry truncating a large partial file."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import time

ROOT=Path(__file__).resolve().parent
DEST=ROOT/'models/qwen3-4b/model.safetensors'
PARTS=ROOT/'data/qwen-parts'
SIZE=2263022417
CHUNK=64*1024*1024
SHA='2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f'
URL='https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit/resolve/50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b/model.safetensors?download=true'

def fetch(index):
    start=index*CHUNK; end=min(SIZE,start+CHUNK)-1; length=end-start+1
    path=PARTS/f'{index:03}.part'; incoming=path.with_suffix('.incoming'); headers=path.with_suffix('.headers')
    for attempt in range(12):
        have=path.stat().st_size if path.exists() else 0
        if have==length: return path
        if have>length: raise RuntimeError('分片长度异常')
        offset=start+have
        proc=subprocess.run(['curl','--http1.1','--fail','--location','--silent','--show-error','--connect-timeout','15','--max-time','180','--range',f'{offset}-{end}','--dump-header',str(headers),URL+f'&part={index}','-o',str(incoming)],capture_output=True,text=True)
        header=headers.read_text(errors='replace') if headers.exists() else ''
        ranges=re.findall(r'content-range:\s*bytes (\d+)-(\d+)/(\d+)',header,re.I)
        size=incoming.stat().st_size if incoming.exists() else 0
        if ranges and int(ranges[-1][0])==offset and int(ranges[-1][2])==SIZE and 0<size<=length-have:
            with path.open('ab') as output, incoming.open('rb') as source: shutil.copyfileobj(source,output)
            incoming.unlink()
            print(f'分片 {index+1}/34：{path.stat().st_size}/{length}',flush=True)
        elif proc.returncode==0:
            raise RuntimeError(f'分片 {index} 未返回正确范围')
        time.sleep(min(5,attempt+1))
    raise RuntimeError(f'分片 {index} 暂未完成，可再次运行续传')

if __name__=='__main__':
    PARTS.mkdir(parents=True,exist_ok=True)
    if DEST.exists() and hashlib.file_digest(DEST.open('rb'),'sha256').hexdigest()==SHA:
        print('Qwen 已完成校验'); raise SystemExit
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths=list(pool.map(fetch,range((SIZE+CHUNK-1)//CHUNK)))
    merged=DEST.with_suffix('.merging')
    with merged.open('wb') as output:
        for path in paths:
            with path.open('rb') as source: shutil.copyfileobj(source,output)
    if hashlib.file_digest(merged.open('rb'),'sha256').hexdigest()!=SHA: raise RuntimeError('模型校验失败')
    merged.replace(DEST); print('Qwen 权重完整，SHA256 校验成功。',flush=True)
