import type { Context } from '@deepseek-ai/cordis'
import { registerHomeworkWeb } from './web.js'
import { gradeImage } from './vision.js'

export const name = 'homework-correction'
export const inject = ['tools']

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
          disposeWeb = registerHomeworkWeb(webCtx.webServer)
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
  let disposeTool: (() => void) | undefined
  if (!tools || typeof tools.register !== 'function') {
    console.warn('[dsh-homework-correction] tools service is unavailable; workspace remains available')
  } else {
    disposeTool = tools.register({
      name: 'grade_homework_image',
      description: '对一张作业图片进行逐题批改。使用 DSH settings.yaml 中配置的视觉模型直接识别印刷题与手写作答（不依赖独立 OCR 服务），返回题目、学生答案、判定、标准答案、解析、错因、知识点与置信度。手写不清时必须标记待复核。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image_data_url: { type: 'string', description: 'data:image/jpeg;base64,... 或 data:image/png;base64,... 图片数据 URL。' },
          instruction: { type: 'string', description: '可选的学科、年级、评分标准或教师补充说明。' },
        },
        required: ['image_data_url'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async (args: { image_data_url: string; instruction?: string }) => {
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(args.image_data_url)) {
          throw new Error('image_data_url 必须是 PNG/JPEG/WebP 的 base64 data URL')
        }
        if (args.image_data_url.length > 16_000_000) throw new Error('图片太大，请压缩到约 12 MB 以内')
        const result = await gradeImage(args.image_data_url, buildPrompt(args.instruction || ''))
        return JSON.stringify(result, null, 2)
      },
    })
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { disposeTool?.() } catch {}
    }, 'dsh-homework-correction: lifecycle')
  }
}

function buildPrompt(extra: string): string {
  return '你是一名严谨的作业批改老师。请直接观察图片识别印刷题、图形、公式和学生手写作答；不要声称使用了独立 OCR 服务。\n'
    + '按题逐一批改，区分正确、错误、部分正确、待复核；字迹/图形/题意无法可靠识别时必须标记待复核，不可猜测。数学题保留公式和必要的推导。客观题说明标准答案；主观题给出得分依据。逐题给出题号、题目、学生作答、标准答案、判定、得分（如无法确定则 null）、解析、错因、知识点、置信度（0 到 1）和复核原因。最后给总分（如无法计算则 null）、总题数、正确/错误/部分正确/待复核数量、薄弱知识点和教师建议。只输出有效 JSON，不要 Markdown 代码围栏。结构为：{"subject":"","grade":"","questions":[{"number":"1","question":"","studentAnswer":"","correctAnswer":"","verdict":"正确|错误|部分正确|待复核","score":null,"explanation":"","errorCause":"","knowledgePoints":[],"confidence":0.0,"reviewReason":""}],"summary":{"score":null,"total":0,"correct":0,"incorrect":0,"partial":0,"needsReview":0,"weakPoints":[],"advice":""}}\n'
    + (extra.trim() ? '教师补充要求：' + extra.trim() : '')
}
