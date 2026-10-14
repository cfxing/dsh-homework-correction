import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { gradeImage, describeCatalogue, visionRoutes, invalidateCatalogue, type VisionRuntime } from './vision.js'

const PREFIX = '/homework-correction/v1'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(HOME, 'homework-correction')
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const REPORTS_FILE = join(DATA_DIR, 'reports.json')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type WebLike = {
  register: (route: { kind: 'exact'; path: string; handler: Handler }) => () => void
}
type VisionRuntimeProvider = () => VisionRuntime

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, {
    allow,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ error: '请求方法不受支持', allow }))
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 18_000_000) throw new Error('请求太大，请压缩图片后重试（最大约 12 MB）')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === (req.headers.host || '')
  } catch {
    return false
  }
}

async function loadReports(): Promise<any[]> {
  try {
    const value = JSON.parse(await readFile(REPORTS_FILE, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

async function saveReports(reports: any[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(REPORTS_FILE, JSON.stringify(reports.slice(0, 200), null, 2), 'utf8')
}

/** 工作台里手动选定的模型路线，重启后仍生效。 */
async function loadSelection(): Promise<{ provider?: string; model?: string }> {
  try {
    const value = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

async function saveSelection(selection: { provider?: string; model?: string }): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(selection, null, 2), 'utf8')
}

function route(ctx: WebLike, path: string, handler: Handler): () => void {
  return ctx.register({ kind: 'exact', path, handler })
}

export function registerHomeworkWeb(ctx: WebLike, visionRuntime: VisionRuntimeProvider): () => void {
  const disposers = [
    route(ctx, '/homework-correction/health', (_req, res) => {
      send(res, 200, { ok: true, plugin: 'dsh-homework-correction', source: 'dsh-llm-service' })
    }),
    route(ctx, PREFIX + '/models', async (req, res) => {
      if (req.method === 'GET') {
        try {
          invalidateCatalogue()
          const catalogue = await describeCatalogue(visionRuntime(), { refresh: true })
          const selection = await loadSelection()
          const usable = visionRoutes(catalogue).map((item) => ({
            provider: item.provider,
            providerName: item.providerName,
            model: item.model,
            name: item.name,
            label: item.name && item.name !== item.model ? `${item.name}（${item.model}）` : item.model,
          }))
          const selected = selection.provider && selection.model
            ? usable.find((item) => item.provider === selection.provider && item.model === selection.model) || selection
            : usable[0] || null
          send(res, 200, {
            visionModels: usable,
            defaultRoute: usable[0] || null,
            selected,
            allModels: catalogue.models.map((item) => ({
              provider: item.provider,
              model: item.model,
              inputModalities: item.modalities,
            })),
            warnings: catalogue.warnings,
          })
        } catch (err) {
          send(res, 500, { error: err instanceof Error ? err.message : String(err), visionModels: [], allModels: [], warnings: [] })
        }
        return
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req)) {
          send(res, 403, { error: '请求来源校验失败：请从当前 DeepSeek Harness 页面访问此接口' })
          return
        }
        try {
          const body = await readBody(req)
          const selection = {
            provider: body.provider ? String(body.provider) : undefined,
            model: body.model ? String(body.model) : undefined,
          }
          await saveSelection(selection)
          send(res, 200, { ok: true, selection })
        } catch (err) {
          send(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }
      methodNotAllowed(res, 'GET, POST')
    }),
    route(ctx, PREFIX + '/reports', async (req, res) => {
      if (req.method !== 'GET') {
        methodNotAllowed(res, 'GET')
        return
      }
      try {
        const reports = await loadReports()
        send(res, 200, reports.map(({ imageDataUrl, ...report }) => report))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        send(res, 500, { error: message || '读取批改历史失败' })
      }
    }),
    route(ctx, PREFIX + '/grade', async (req, res) => {
      if (req.method !== 'POST') {
        methodNotAllowed(res, 'POST')
        return
      }
      if (!sameOrigin(req)) {
        send(res, 403, { error: '请求来源校验失败：请从当前 DeepSeek Harness 页面访问此接口' })
        return
      }
      try {
        const body = await readBody(req)
        const imageDataUrl = String(body.imageDataUrl || '')
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageDataUrl)) {
          send(res, 400, { error: '请上传 PNG、JPEG 或 WebP 图片' })
          return
        }
        if (imageDataUrl.length > 16_000_000) {
          send(res, 413, { error: '图片太大，请压缩到约 12 MB 以内' })
          return
        }

        const saved = await loadSelection()
        const result = await gradeImage(visionRuntime(), imageDataUrl, buildPrompt(String(body.instruction || '')), {
          provider: body.provider ? String(body.provider) : saved.provider,
          model: body.model ? String(body.model) : saved.model,
        })
        const id = crypto.randomUUID()
        const ext = /^data:image\/png/i.test(imageDataUrl)
          ? 'png'
          : /^data:image\/webp/i.test(imageDataUrl) ? 'webp' : 'jpg'
        const data = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1)
        await mkdir(UPLOAD_DIR, { recursive: true })
        const imagePath = join(UPLOAD_DIR, id + '.' + ext)
        await writeFile(imagePath, Buffer.from(data, 'base64'))
        const report = {
          id,
          createdAt: new Date().toISOString(),
          model: result.model,
          provider: result.provider,
          warnings: result.warnings,
          report: result.report,
          imagePath,
        }
        const reports = await loadReports()
        await saveReports([report, ...reports])
        send(res, 200, report)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = /请求太大|超过|太大/.test(message)
          ? 413
          : /JSON|Unexpected end/i.test(message) ? 400 : 500
        send(res, status, { error: message || '服务器处理请求失败' })
      }
    }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}

function buildPrompt(extra: string): string {
  return '你是一名严谨的作业批改老师。直接观察图片识别印刷题、图形、公式和学生手写作答；不依赖独立 OCR 服务。\n'
    + '按题逐一批改，区分正确、错误、部分正确、待复核；字迹/图形/题意无法可靠识别时必须标记待复核，不可猜测。主观题说明得分依据。逐题给出题号、题目、学生作答、标准答案、判定、得分（无法确定则 null）、解析、错因、知识点、置信度（0 到 1）和复核原因。最后给总分、总题数、正确/错误/部分正确/待复核数量、薄弱知识点和教师建议。只输出有效 JSON，不要 Markdown 代码围栏。结构：{"subject":"","grade":"","questions":[{"number":"1","question":"","studentAnswer":"","correctAnswer":"","verdict":"正确|错误|部分正确|待复核","score":null,"explanation":"","errorCause":"","knowledgePoints":[],"confidence":0.0,"reviewReason":""}],"summary":{"score":null,"total":0,"correct":0,"incorrect":0,"partial":0,"needsReview":0,"weakPoints":[],"advice":""}}\n'
    + (extra.trim() ? '教师补充要求：' + extra.trim() : '')
}
