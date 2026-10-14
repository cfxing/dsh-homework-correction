import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { gradeImage } from './vision.js'

const PREFIX = '/homework-correction/v1'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(HOME, 'homework-correction')
const UPLOAD_DIR = join(DATA_DIR, 'uploads')
const REPORTS_FILE = join(DATA_DIR, 'reports.json')
type WebLike = { register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }) => (() => void) }

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function readBody(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString()
    if (raw.length > 18_000_000) throw new Error('请求太大，请压缩图片后重试（最大约 12 MB）')
  }
  return raw ? JSON.parse(raw) : {}
}
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === (req.headers.host || '') } catch { return false }
}
async function loadReports(): Promise<any[]> {
  try { return JSON.parse(await readFile(REPORTS_FILE, 'utf8')) } catch { return [] }
}
async function saveReports(reports: any[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(REPORTS_FILE, JSON.stringify(reports.slice(0, 200), null, 2), 'utf8')
}

export function registerHomeworkWeb(ctx: WebLike): () => void {
  const disposers = [
    ctx.register({ kind: 'exact', path: '/homework-correction/health', handler: (_req, res) => send(res, 200, { ok: true, plugin: 'dsh-homework-correction' }) }),
    ctx.register({ kind: 'prefix', path: PREFIX, handler: async (req, res) => {
      if (!sameOrigin(req)) { send(res, 403, { error: '请求来源校验失败：请从当前 DeepSeek Harness 页面访问此接口' }); return }
      try {
        const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'))
        const path = url.pathname.slice(PREFIX.length)
        if (req.method === 'GET' && path === '/reports') {
          const reports = await loadReports()
          return send(res, 200, reports.map(({ imageDataUrl, ...report }) => report))
        }
        if (req.method === 'POST' && path === '/grade') {
          const body = await readBody(req)
          const imageDataUrl = String(body.imageDataUrl || '')
          if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageDataUrl)) throw new Error('请上传 PNG、JPEG 或 WebP 图片')
          if (imageDataUrl.length > 16_000_000) throw new Error('图片太大，请压缩到约 12 MB 以内')
          const result = await gradeImage(imageDataUrl, buildPrompt(String(body.instruction || '')))
          const id = crypto.randomUUID()
          const ext = /^data:image\/png/i.test(imageDataUrl) ? 'png' : /^data:image\/webp/i.test(imageDataUrl) ? 'webp' : 'jpg'
          const data = imageDataUrl.slice(imageDataUrl.indexOf(',') + 1)
          await mkdir(UPLOAD_DIR, { recursive: true })
          await writeFile(join(UPLOAD_DIR, id + '.' + ext), Buffer.from(data, 'base64'))
          const report = { id, createdAt: new Date().toISOString(), model: result.model, provider: result.provider, report: result.report, imagePath: join(UPLOAD_DIR, id + '.' + ext) }
          const reports = await loadReports()
          await saveReports([report, ...reports])
          return send(res, 200, report)
        }
        if (req.method === 'DELETE' && path.startsWith('/reports/')) {
          const id = decodeURIComponent(path.slice('/reports/'.length))
          const reports = await loadReports()
          await saveReports(reports.filter((r) => r.id !== id))
          return send(res, 200, { ok: true })
        }
        return send(res, 404, { error: '接口不存在' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = /请求太大|超过|太大/.test(message) ? 413 : /JSON|Unexpected end/i.test(message) ? 400 : 500
        return send(res, status, { error: message || '服务器处理请求失败' })
      }
    } }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}

function buildPrompt(extra: string): string {
  return '你是一名严谨的作业批改老师。直接观察图片识别印刷题、图形、公式和学生手写作答；不依赖独立 OCR 服务。\n'
    + '按题逐一批改，区分正确、错误、部分正确、待复核；字迹/图形/题意无法可靠识别时必须标记待复核，不可猜测。主观题说明得分依据。逐题给出题号、题目、学生作答、标准答案、判定、得分（无法确定则 null）、解析、错因、知识点、置信度（0 到 1）和复核原因。最后给总分、总题数、正确/错误/部分正确/待复核数量、薄弱知识点和教师建议。只输出有效 JSON，不要 Markdown 代码围栏。结构：{"subject":"","grade":"","questions":[{"number":"1","question":"","studentAnswer":"","correctAnswer":"","verdict":"正确|错误|部分正确|待复核","score":null,"explanation":"","errorCause":"","knowledgePoints":[],"confidence":0.0,"reviewReason":""}],"summary":{"score":null,"total":0,"correct":0,"incorrect":0,"partial":0,"needsReview":0,"weakPoints":[],"advice":""}}\n'
    + (extra.trim() ? '教师补充要求：' + extra.trim() : '')
}
