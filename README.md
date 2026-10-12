# dsh-homework-correction · DeepSeek Harness 作业批改

将原有作业批改流程迁移为 DeepSeek Harness 原生插件：在 Harness 侧边栏打开工作台，上传作业图片，调用 DSH 本机配置的视觉模型识别题目和手写答案，并展示逐题判定与批改报告。

## 当前实现

- 原生工作台：通过 DSH web client sidebar/main slot 打开「作业批改」页面。
- 视觉模型识别：直接向 DSH settings.yaml 中配置的 OpenAI-compatible 视觉模型发送图片；不需要独立 RapidOCR/PaddleOCR 服务。
- 逐题报告：题目、学生作答、标准答案、判定、解析、错因、知识点、置信度与待复核原因。
- 历史记录：报告和图片保存在 $DSH_HOME/homework-correction/，默认即 ~/.dsh/homework-correction/。
- Agent 工具：注册 grade_homework_image，供 Agent 在获得图片 data URL 时主动调用。
- 凭据安全：插件只在服务端读取 DSH 配置/凭据引用，不把 API Key 注入浏览器、报告或代码仓库。

## 安装与开发

目标环境：DeepSeek Harness 0.2.0-rc.2，Node.js ^22.19.0 或 >=24.0.0。

    git clone -b feat/dsh-homework-grading-plugin https://github.com/cfxing/dsh-homework-correction.git
    cd dsh-homework-correction
    pnpm install
    pnpm build
    pnpm test

然后按当前 DSH 的本地插件开发/安装流程把此目录加载到 web profile。插件包元数据、Cordis patch、TypeScript 入口和 client bundle 已按 Harness web 插件结构配置；实际激活仍需在目标 DSH 安装中验证。

## 视觉模型要求

插件读取 $DSH_HOME/settings.yaml，并解析 $DSH_HOME/.credentials.yaml 中的 cred:NAME 引用。它会优先选择名称或模型名包含 describe-image、vision、vl 等标记的配置，并调用 OpenAI-compatible /chat/completions 接口。

请确保至少有一个提供商：
- 配置了有效的 baseURL / apiBaseUrl；
- 配置了 model；
- 配置了有效的 apiKey 或 cred:NAME；
- 支持图片输入，并兼容 OpenAI Chat Completions 的 image_url 格式。

如果 DSH 中的模型提供商不是 OpenAI-compatible，或其图片请求格式不同，需要在 src/vision.ts 里适配该提供商。插件不会尝试启动本机 OCR 来兜底；视觉模型不可用时会显示明确错误。

## 批改原则

1. 模型逐题识别题目、公式、图形和手写作答。
2. 对字迹不清、题目缺页、题号关联不确定的内容标记「待复核」，不直接判错。
3. 输出正确答案、解析、错因、知识点、置信度和复核原因。
4. 教师可填写学科、年级、满分、步骤扣分等额外批改要求。

当前 UI 以单张图片为一个批改任务；多页试卷、原图批注、手动逐题修正和更完整的评分规则仍可继续扩展。

## 原项目文件与安全说明

原有窗口1-作业批改工作台.html、hwgrade-relay.cjs、hwgrade-ocr.py 和 Windows 启动脚本保留在 Git 仓库中，供迁移算法参考，但不打入新插件包，也不是新工作台的依赖。

旧版 HTML 的历史说明曾提到明文 API Key。不要继续使用或发布含明文密钥的旧版页面；如密钥曾公开提交，请立即撤销/轮换。不要把 API Key 写入 HTML、Skill、日志或提交记录。

## 验证状态

当前分支已添加原生插件入口、服务端视觉模型调用、工具注册、工作台 UI、报告历史和基本 smoke test。由于此环境无法在你的实际 DSH 0.2.0-rc.2 安装中启动 web profile，仍需在目标机器运行 pnpm install && pnpm test 并验证插件激活、模型请求与图片上传。
