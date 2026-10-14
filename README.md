# dsh-homework-correction · DeepSeek Harness 作业批改

将原有作业批改流程迁移为 DeepSeek Harness 原生插件：在 Harness 侧边栏打开工作台，上传作业图片，调用 DSH 本机配置的视觉模型识别题目和手写答案，并展示逐题判定与批改报告。

## 当前实现

- 原生工作台：通过 DSH web client sidebar/main slot 打开「作业批改」页面。
- 视觉模型识别：通过 DSH 的 `llm` 服务读取本机已注册的模型，用 `attachments` 服务把图片落成持久化附件，再以真正的 `image` 内容块调用模型识别；不需要独立 RapidOCR/PaddleOCR 服务，也不需要自己解析配置文件或拼 HTTP 请求。
- 模型选择：工作台会列出所有声明了图片输入（`inputModalities` 含 `image`）的模型供选择，选择结果持久化；也可留空自动挑选。
- 逐题报告：题目、学生作答、标准答案、判定、解析、错因、知识点、置信度与待复核原因。
- 历史记录：报告和图片保存在 $DSH_HOME/homework-correction/，默认即 ~/.dsh/homework-correction/。
- Agent 工具：注册 grade_homework_image（可带 provider/model 指定模型）与 list_homework_models（列出可用视觉模型），供 Agent 主动调用。
- 凭据安全：插件只通过 DSH 服务调用模型，凭据由 Harness 保管，不进入浏览器、报告或代码仓库。

## 安装与开发

目标环境：DeepSeek Harness 0.2.0-rc.2，Node.js ^22.19.0 或 >=24.0.0。

    git clone -b feat/dsh-homework-grading-plugin https://github.com/cfxing/dsh-homework-correction.git
    cd dsh-homework-correction
    pnpm install
    pnpm build
    pnpm test

然后按当前 DSH 的本地插件开发/安装流程把此目录加载到 web profile。插件包元数据、Cordis patch、TypeScript 入口和 client bundle 已按 Harness web 插件结构配置；实际激活仍需在目标 DSH 安装中验证。

## 视觉模型要求

插件不再读取 settings.yaml，也不再自行拼接 OpenAI-compatible 请求。它向 DSH 的 `llm` 服务查询：

- `llm.listProviders()` 列出所有已注册的提供商；
- `llm.listModels(provider)` 读取每个模型的 `inputModalities`，筛出声明了 `image` 的模型；
- `attachments.saveImage()` 把 data URL 落成持久化图片附件；
- `llm.stream({ provider, model, messages: [{ role: 'user', content: [{ type: 'text' }, { type: 'image', attachment }] }] })` 完成识图。

因此凭据、重试、代理、限流与路由全部由 DSH 负责，插件不需要知道任何 API Key 或 baseURL。

请确保至少有一个模型声明了图片输入：

    llm 提供商配置中的 models 条目加上 input: [text, image]

例如 profile 的 `cordis.patch.yml` 中：

    - id: llm-pi-ai
      config:
        providers:
          volcengine:
            models:
              - id: doubao-seed-evolving
                input: [text, image]

如果所有模型都只声明 `text`，批改会明确列出当前模型清单并提示如何声明，而不会静默失败。也可以用 `list_homework_models` 工具或工作台的「刷新模型」查看实际读到的模型。插件不会启动本机 OCR 兜底。

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

已在真实 DSH web profile 上完成端到端验证（2026-10-14）：

- 模型读取：`GET /homework-correction/v1/models` 正确列出 `deepseek-official / deepseek-flash`（`inputModalities: [text, image]`），并标出 volcengine 下 7 个仅 `text` 的模型；
- 识图批改：`POST /homework-correction/v1/grade` 用示例物理填空题图片返回 HTTP 200，识别出 4 道填空题与学生的 4 个手写答案，判定第 4 题（I=U/R 应为 0.5 A）错误并给出错因、知识点与总评，与图片内容一致；
- 历史记录：报告与图片正常落盘到 ~/.dsh/homework-correction/。

注意：修改主机侧代码后必须重启 `dsh web` 才会生效 —— 本 profile 的 `hmr` 配置为 `root: []`，即不监听模块文件，只支持配置热重载。
