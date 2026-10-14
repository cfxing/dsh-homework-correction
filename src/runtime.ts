import type { Context } from '@deepseek-ai/cordis'
import { registerHomeworkWeb } from './web.js'
import { gradeImage, describeCatalogue, visionRoutes, invalidateCatalogue, type VisionRuntime } from './vision.js'

export const name = 'homework-correction'
export const inject = ['tools']

/** 从当前 DSH 组合里取出 llm / attachments 两个服务。 */
export function resolveVisionRuntime(ctx: Context): VisionRuntime {
  const runtime = ctx as any
  const get = (key: string) => (typeof runtime.get === 'function' ? runtime.get(key) : undefined)
  const llm = get('llm')
  const attachments = get('attachments')
  const missing: string[] = []
  if (!llm || typeof llm.stream !== 'function' || typeof llm.listProviders !== 'function') missing.push('llm')
  if (!attachments || typeof attachments.saveImage !== 'function') missing.push('attachments')
  if (missing.length) {
    throw new Error('作业批改需要 DSH 的 ' + missing.join('、') + ' 服务，但当前组合中没有可用的实现。')
  }
  return { llm, attachments }
}

export function bootstrap(ctx: Context): void {
  const runtime = ctx as any
  let disposeWeb: (() => void) | undefined

  try {
    if (typeof runtime.inject === 'function') {
      // Cordis inject callback receives a child context; the service lives at webCtx.webServer.
      runtime.inject(['webServer'], (webCtx: any) => {
        try {
          if (!webCtx?.webServer || typeof webCtx.webServer.register !== 'function') {
            console.error('[dsh-homework-correction] webServer injection completed without a register() service')
            return
          }
          disposeWeb?.()
          disposeWeb = registerHomeworkWeb(webCtx.webServer, () => resolveVisionRuntime(ctx))
          console.info('[dsh-homework-correction] homework API routes mounted')
          if (typeof webCtx.effect === 'function') {
            webCtx.effect(() => () => {
              try { disposeWeb?.() } catch {}
              disposeWeb = undefined
            }, 'dsh-homework-correction: web routes lifecycle')
          }
        } catch (err) {
          console.error('[dsh-homework-correction] web route registration failed:', err)
        }
      })
    } else {
      console.warn('[dsh-homework-correction] ctx.inject is unavailable; homework API routes were not mounted')
    }
  } catch (err) {
    console.error('[dsh-homework-correction] webServer injection failed:', err)
  }

  const tools = runtime.tools
  const disposers: Array<() => void> = []
  if (!tools || typeof tools.register !== 'function') {
    console.warn('[dsh-homework-correction] tools service is unavailable; workspace remains available')
  } else {
    disposers.push(tools.register({
      name: 'grade_homework_image',
      description: '对一张作业图片进行逐题批改。直接使用 DSH 中已配置的视觉模型（通过 llm 服务读取模型清单，经 attachments 服务提交图片）识别印刷题、图形、公式与手写作答，不依赖独立 OCR 服务。返回题目、学生答案、判定、标准答案、解析、错因、知识点与置信度；手写不清时必须标记待复核。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image_data_url: { type: 'string', description: 'data:image/jpeg;base64,... 或 data:image/png;base64,... 图片数据 URL。' },
          instruction: { type: 'string', description: '可选的学科、年级、评分标准或教师补充说明。' },
          provider: { type: 'string', description: '可选的模型提供商 id（如 volcengine）。省略时自动选择声明支持图片输入的模型。' },
          model: { type: 'string', description: '可选的模型 id（如 doubao-seed-evolving）。省略时自动选择。' },
        },
        required: ['image_data_url'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async (args: { image_data_url: string; instruction?: string; provider?: string; model?: string }) => {
        const imageDataUrl = String(args.image_data_url || '')
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageDataUrl)) {
          throw new Error('image_data_url 必须是 PNG/JPEG/WebP 的 base64 data URL')
        }
        if (imageDataUrl.length > 16_000_000) throw new Error('图片太大，请压缩到约 12 MB 以内')
        const result = await gradeImage(resolveVisionRuntime(ctx), imageDataUrl, buildPrompt(args.instruction || ''), {
          provider: args.provider,
          model: args.model,
        })
        return JSON.stringify({
          provider: result.provider,
          model: result.model,
          truncated: result.truncated,
          ...(result.warnings.length ? { warnings: result.warnings } : {}),
          report: result.report,
        }, null, 2)
      },
    }))

    disposers.push(tools.register({
      name: 'list_homework_models',
      description: '列出 DSH 当前已注册的模型及其输入模态，标出哪些模型声明支持图片输入（可用于作业批改）。当 grade_homework_image 报「没有可用的图片识别模型」时用本工具确认可用模型。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async () => {
        invalidateCatalogue()
        const catalogue = await describeCatalogue(resolveVisionRuntime(ctx), { refresh: true })
        const usable = visionRoutes(catalogue).map((item) => ({ provider: item.provider, model: item.model, name: item.name }))
        return JSON.stringify({
          visionModels: usable,
          defaultRoute: usable[0] ?? null,
          allModels: catalogue.models.map((item) => ({ provider: item.provider, model: item.model, inputModalities: item.modalities })),
          warnings: catalogue.warnings,
        }, null, 2)
      },
    }))
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposers.forEach((dispose) => {
        try { dispose() } catch {}
      })
    }, 'dsh-homework-correction: lifecycle')
  }
}

function buildPrompt(extra: string): string {
  return '你是一名严谨的作业批改老师。请直接观察图片识别印刷题、图形、公式和学生手写作答；不要声称使用了独立 OCR 服务。\n'
    + '按题逐一批改，区分正确、错误、部分正确、待复核；字迹/图形/题意无法可靠识别时必须标记待复核，不可猜测。数学题保留公式和必要的推导。客观题说明标准答案；主观题给出得分依据。逐题给出题号、题目、学生作答、标准答案、判定、得分（如无法确定则 null）、解析、错因、知识点、置信度（0 到 1）和复核原因。最后给总分（如无法计算则 null）、总题数、正确/错误/部分正确/待复核数量、薄弱知识点和教师建议。只输出有效 JSON，不要 Markdown 代码围栏。结构为：{"subject":"","grade":"","questions":[{"number":"1","question":"","studentAnswer":"","correctAnswer":"","verdict":"正确|错误|部分正确|待复核","score":null,"explanation":"","errorCause":"","knowledgePoints":[],"confidence":0.0,"reviewReason":""}],"summary":{"score":null,"total":0,"correct":0,"incorrect":0,"partial":0,"needsReview":0,"weakPoints":[],"advice":""}}\n'
    + (extra.trim() ? '教师补充要求：' + extra.trim() : '')
}
