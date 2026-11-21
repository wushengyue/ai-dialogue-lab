#!/bin/zsh
set -e
cd "${0:A:h}"
if [[ ! -x .venv/bin/python ]]; then
  print '请先按 README.md 安装语音依赖。'
  exit 1
fi
exec .venv/bin/python server.py --port 8765
