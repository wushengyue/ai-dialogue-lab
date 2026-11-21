# 三茅老师 · 一对一课堂实验室

本地调试 AI 一对一讲解与模拟面试。默认试讲材料是用户提供的 Rubric 跑分流程图，主画面是完整的 16:9 板书。老师通过语音回答，板书左上角、当前内容标题前的圆脸、大耳朵头像露出脖子和格子衫肩膀，随实际播报张嘴，平时不持续晃动。

## 启动

```sh
./start.command
```

打开 <http://127.0.0.1:8765>。刷新后不会自动上课，点击「开始上课」后按姓名问候、说出课程标题，依次预告几个方面，再顺序进入第一部分。暂停后点击「继续」恢复。

## 两种输入

- **开麦**：持续收音，停顿后自动识别并提交。
- **文字提问**：文字作为输入，老师仍语音回答和更新板书。

老师思考或等待首声时，新发言进入补充队列，不取消当前生成，不重置该轮 TTFT。每个完整句子结束后检查新发言：简单确认不打断讲解，实质补充会停止后续未播出的内容，合并后重新组织后续讲解。当前生成完成前不重置该轮 TTFT。手动暂停、新会话另行取消当前流程。

## 板书、称呼与播报

- 默认模拟姓名为“吴同学”，可在顶部或用户资料中修改，新会话生效；开课称呼姓名、简短寒暄，并介绍“我是三茅老师，一个爱穿格子衫的资深 AI 从业者”，后续按实际进度推进。
- 主体保持 16:9，字体不随内容变多而缩小，长内容向下滚动。顶部用紧凑标题说明当前讲解重点；课程名在右上角小字显示，同侧保留当前页与已讲页数，可前后翻页。
- 板书随实际语音逐步增加，支持 belowOf / rightOf 排版、结构图节点/连线、reference / inquiry / emphasis 高亮。还没讲到的内容不展示。新增、重新强调和提问时视角自动跟随对应内容；手动滚动暂停跟随，点击“跟随讲解”回到当前重点。
- 当前页聚焦正在讲的 1—3 个核心点。讲完且无关的过程及时清除，可指定保留关键结论；切换到下一节 User 时另开新页，旧页可回看。清板随对应语音执行，不提前擦掉。
- 寒暄和事务性确认只用字幕；讲清关键点后，用一个内容问题检查判断和理由，重要问题同步上板书，问完等待，不自问自答。
- 普通文字不铺底色，重点使用局部荧光笔、下划线、圈选或方框；只有逻辑关系图保留浅色节点。横线上方显示当前核心内容，字号适中，不重复课程名。
- 学生发言时，底部彩色声纹按真实音量起伏，并显示识别、接收状态。老师倾听时头发变为波浪线；具体肯定回答时，三颗小爱心随话术依次向上冒泡。
- 等待和逐条新增时文字稳定出现，不做飘入或晃动。重新注入下一节 User 后，首段语音开始时直接切到新板书，不做转场。等待生成时，三根头发以蓝、粉、青三色依次亮起，老师与文字保持稳定；支持减少动画偏好。
- 英文术语和英文句子按原文朗读，中英混合保持原顺序。需要解释时在话术和字幕中明确写出译义，语音层不再替换 Rubric、Must-have、PASS 等词；新版缓存不会复用旧译读音频。
- 标题前的小头像露出格子衫肩膀，播放时开合嘴，倾听和鼓励时切换表情。默认男声 zm_011；底部课堂控制区提供「语速」滑块，范围 0.75—2.00 倍，默认比原速度加快至 1.20 倍。调整立即作用于正在播放及后续语音，保留音高，并在当前浏览器记住选择。
- 支持 `[重读]词语[/重读]`、`[慢]短句[/慢]`、`[快]短句[/快]`、`[停顿:300]`。这是语速、增益和停顿控制，不是原生情绪合成；标记不会读出或显示在字幕中。

## 调试信息

不支持或格式不正确的单条板书操作会被跳过并记录，语音继续；缺少阶段或回复尾部格式损坏时，保留已解析的话术与有效板书，本节不提前判完成。

底部显示学生转写及接收状态、老师逐段字幕，以及「输入 → 转写 → 提交 → 回复 → 语音 → 板书 → 播放」实际链路。更多菜单里的运行检查可看完整 Sys、User、模型输出、事件和隐藏对话记录。

- **TTFT / 首字**：模型开始推理到输出第一个 token 的时间。
- **首段话术**：足够合成第一段语音的文本产生时间。
- **首声**：输入完成到浏览器实际开始播放的时间，包含识别、排队、生成、合成及传输；全开麦还包含等待句末停顿。
- 「3 秒首声」是优化目标，以页面和验证记录实测为准，不代表整轮回复、整页板书或冷启动都在 3 秒完成。

## 模型

1. **识别**：本地 SenseVoice Small int8，中文优先，Silero VAD 过滤无语音片段；保留 Whisper base 作为备用。PCM WAV 直接解码。
2. **讲解**：默认使用用户指定的方舟 `deepseek-v4-1-flash-economy-261017` Responses API，流式输出、关闭深度思考、不调用联网搜索。可选本地 Qwen3-4B-Instruct-2507 MLX 4bit 与 Codex 对照路径；两者保留旧版板书协议。音频先转写，DeepSeek 与 Qwen 此处都接收文本。
3. **播报**：本地 Kokoro v1.1-zh，默认中文男声 `zm_011`。男声未就绪时明确报错，不自动换成女声。

默认链路按 steps 返回短讲话与板书操作：短语一产生就合成，音频播放时才执行对应板书操作。后续文字、语音、板书同时准备，不等待完整 JSON。服务启动时预热识别、男声及远程连接/共同课程前缀；准备调用只输出 1 个 token，不作为课堂回应或首声统计。

## 准备环境

macOS Apple Silicon、Python 3.12。已有 `.venv` 和模型时不用重复安装。

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
uv pip install --python .venv/bin/python -r requirements-local.in
.venv/bin/python prepare_voice.py
.venv/bin/python prepare_local_models.py
.venv/bin/python prepare_sensevoice.py
.venv/bin/python verify_voice_models.py
```

首次在新电脑运行时，设置环境变量 `ARK_API_KEY`，或把密钥保存到 `data/credentials/ark.key` 并设置文件权限为 600。密钥只在本机后端读取，请勿提交到 Git。默认识别与播报在本机运行；本地 Qwen 为可选对照模型。

大模型网络不稳定时可运行 `download_qwen_chunks.py`，把下载拆成有边界的 HTTP 分片并续传；最终按官方 SHA256 校验。文件下载成功与推理验证成功分别记录，不能仅凭目录存在判定模型可用。

## 内容与文档

- `content/rubric/user-task.md`：本次 User、分段推进、轻互动与板书要求。
- `content/rubric/material.md`：忠实于原图的专业材料。
- `content/rubric/多轮讲解与板书.md`：多轮讲解设计与板书示例。
- `content/rubric/board-reference.md`：本次参考的 learning_task Sys/User 板书原则。
- `docs/产品与实现说明.md`：范围、内容结构、运行方式和边界。
- `docs/课堂分节与User编排.md` 与 `content/rubric/sections.json`：已接入默认方舟链路的八个教学环节；每节独立注入 User，完成播报后再推进。
- `data/`：本机配置、会话、音频缓存及验证结果，不进入 Git。
- `models/`：本地模型，不进入 Git。

分节内容在 `content/rubric/sections.json` 编辑，页面的任务字段用于课程通用要求，完整课程设计仍保留在 `user-task.md`。修改内容在新会话生效；运行中会话使用自己的配置快照。评估报告和下一步规划继续保持灰色，不属于第一阶段。

## 验证

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test tests/voice.test.mjs
.venv/bin/python tests/smoke_voice.py
```

真实模型及浏览器验证会生成 `data/` 下的记录和截图。检查语音播放是否完成、板书是否可见以及首声实测值，而不只检查接口返回成功。

## 数据边界

麦克风音频只发到本机识别，原始录音不落盘。默认方舟模式会把任务、材料、画像和转写文本发给方舟模型，设置 store=false；本地 Kokoro 推理不上传音频。密钥来自 ARK_API_KEY 或 data/credentials/ark.key，仅后端读取，文件权限为 600，不在网页、会话导出或 Git 中出现。Codex 对照模式复用本机登录。

这是内容与课堂交互调试原型。音量阈值检测仍可能受噪声影响，建议耳机；专业材料和模型的实际回复需要人工审阅。

模型来源：[方舟 Responses API](https://docs.volcengine.com/docs/ark/responses-api-text-generation?lang=zh)、[SenseVoice](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)、[Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)、[MLX 4bit](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit)、[Kokoro 中文模型](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)、[Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)。
