import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface VisionProvider {
  name: string
  baseURL: string
  apiKey: string
  model: string
}

function readText(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function credentialRefs(home: string): Record<string, string> {
  const refs: Record<string, string> = {}
  const lines = readText(join(home, '.credentials.yaml')).split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (!inRefs) continue
    if (/^[^\s#][^:]*:/.test(line)) break
    const match = /^\s{2}([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line)
    if (match) refs[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return refs
}

export function discoverVisionProvider(): VisionProvider {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readText(join(home, 'settings.yaml'))
  const refs = credentialRefs(home)
  const blocks: VisionProvider[] = []
  let current: { name: string; baseURL: string; key: string; model: string } | undefined
  const flush = () => {
    if (current?.baseURL && current.key && current.model) {
      blocks.push({ name: current.name, baseURL: current.baseURL.replace(/\/+$/, ''), apiKey: current.key, model: current.model })
    }
  }
  for (const raw of settings.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim() || /^\s*#/.test(line)) continue
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (top) {
      flush()
      current = { name: top[1], baseURL: '', key: '', model: '' }
      continue
    }
    if (!current) continue
    const kv = /^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line)
    if (!kv) continue
    const value = kv[2].replace(/^["']|["']$/g, '')
    if (/^(baseURL|apiBaseUrl)$/i.test(kv[1]) && /^https?:\/\//i.test(value) && !current.baseURL) current.baseURL = value
    else if (kv[1] === 'apiKey' && !current.key) {
      const ref = /^cred:(.+)$/.exec(value)
      current.key = ref ? (refs[ref[1]] || '') : value
    } else if (kv[1] === 'model' && !current.model) current.model = value
  }
  flush()
  const vision = blocks.sort((a, b) => score(b) - score(a))[0]
  if (!vision) {
    throw new Error('未能从 DSH settings.yaml 找到可用的视觉模型配置。请先在 DeepSeek Harness 配置一个支持图片输入的模型（例如 describe-image），并确保 apiKey/cred 引用可用。')
  }
  return vision
}

function score(provider: VisionProvider): number {
  let value = 0
  if (/describe-image|image-vision|vision|multimodal|image/i.test(provider.name)) value += 10
  if (/qwen.*vl|gpt-4o|gpt-4\.1|gemini|vision/i.test(provider.model)) value += 5
  if (/dashscope|aliyuncs/i.test(provider.baseURL)) value += 2
  return value
}

export async function gradeImage(imageDataUrl: string, instruction: string): Promise<{ provider: string; model: string; report: unknown }> {
  const provider = discoverVisionProvider()
  const response = await fetch(provider.baseURL + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider.apiKey },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.1,
      max_tokens: 5000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error('视觉模型请求失败（HTTP ' + response.status + '）：' + text.replaceAll(provider.apiKey, '[REDACTED]').slice(0, 800))
  let payload: any
  try { payload = JSON.parse(text) } catch { throw new Error('视觉模型返回的不是有效 JSON 响应') }
  const content = payload?.choices?.[0]?.message?.content
  const answer = Array.isArray(content) ? content.map((x: any) => x.text || '').join('\n') : String(content || '')
  if (!answer.trim()) throw new Error('视觉模型没有返回批改内容')
  const cleaned = answer.trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/i, '')
  let report: unknown
  try { report = JSON.parse(cleaned) } catch { report = { raw: answer, needsReview: true } }
  return { provider: provider.name, model: provider.model, report }
}
