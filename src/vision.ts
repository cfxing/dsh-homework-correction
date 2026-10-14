/**
 * 视觉模型接入层。
 *
 * 旧实现直接读取 `$DSH_HOME/settings.yaml` 并自行拼装 OpenAI-compatible
 * `/chat/completions` 请求。本机 DSH 的模型来自 profile 化的 cordis 配置
 * （`cordis.patch.yml` 里的 llm 插件行 + `.credentials.yaml` 的 refs），
 * `settings.yaml` 并不存在，因此该路径必然失败。
 *
 * 现在改为完全走 DSH 原生能力：
 *   1. `ctx.llm.listProviders()` / `listModels()` —— 读取本机真正注册的模型与
 *      其 `inputModalities`，据此挑出支持图片输入的模型；
 *   2. `ctx.attachments.saveImage()` —— 把 data URL 落成持久化图片附件；
 *   3. `ctx.llm.stream()` —— 以真正的 `image` 内容块调用模型，凭据、重试、
 *      代理与路由全部交给 DSH，插件不再解析任何配置文件。
 */

/** `llm` 服务中我们真正依赖的最小面。 */
export interface LlmService {
  listProviders(): Array<{ id: string; name?: string }>
  listModels(provider: string): Promise<Array<{ id: string; name?: string; inputModalities?: readonly string[] }>>
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

/** `attachments` 服务中我们真正依赖的最小面。 */
export interface AttachmentsService {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface VisionRuntime {
  llm: LlmService
  attachments: AttachmentsService
}

/** 一条可用的 chat 模型路线，以及它声明的输入模态。 */
export interface ChatModelRoute {
  provider: string
  providerName?: string
  model: string
  name?: string
  modalities: string[]
  image: boolean
}

export interface VisionCatalogue {
  models: ChatModelRoute[]
  warnings: string[]
}

export interface VisionRoute {
  provider: string
  model: string
  label: string
  declaredImage: boolean
}

export interface GradeOptions {
  provider?: string
  model?: string
  maxTokens?: number
  temperature?: number
  name?: string
  signal?: AbortSignal
}

export interface GradeResult {
  provider: string
  model: string
  report: unknown
  text: string
  truncated: boolean
  warnings: string[]
}

const DATA_URL = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/i

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** 把前端传来的 base64 data URL 解码为字节与标准媒体类型。 */
export function decodeImageDataUrl(dataUrl: string): { bytes: Uint8Array; mediaType: string; extension: string } {
  const match = DATA_URL.exec(String(dataUrl || '').trim())
  if (!match) throw new Error('图片格式不受支持：请提供 PNG、JPEG 或 WebP 的 base64 data URL')
  const mediaType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (!bytes.length) throw new Error('图片数据为空，请重新选择图片')
  return { bytes, mediaType, extension: IMAGE_MEDIA_TYPES[mediaType] || 'jpg' }
}

let cached: { at: number; value: VisionCatalogue } | undefined
const CACHE_MS = 15_000

/**
 * 读取 DSH 已注册的全部模型路线。单个 provider 列不出模型时只记录告警，
 * 不影响其余 provider —— 例如某个 provider 的端点暂时不可达。
 */
export async function describeCatalogue(rt: VisionRuntime, options: { refresh?: boolean } = {}): Promise<VisionCatalogue> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value

  const warnings: string[] = []
  const models: ChatModelRoute[] = []
  let providers: Array<{ id: string; name?: string }> = []
  try {
    providers = rt.llm.listProviders() || []
  } catch (err) {
    warnings.push('读取模型提供商失败：' + message(err))
  }

  for (const provider of providers) {
    let list: Array<{ id: string; name?: string; inputModalities?: readonly string[] }> = []
    try {
      list = (await rt.llm.listModels(provider.id)) || []
    } catch (err) {
      warnings.push(`提供商「${provider.id}」的模型列表不可用：${message(err)}`)
      continue
    }
    for (const model of list) {
      const modalities = (model.inputModalities || []).map((item) => String(item))
      models.push({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        name: model.name,
        modalities,
        image: modalities.includes('image'),
      })
    }
  }

  const value: VisionCatalogue = { models, warnings }
  cached = { at: Date.now(), value }
  return value
}

/** 清空模型缓存（模型配置变更后由上层调用，或 refresh 时使用）。 */
export function invalidateCatalogue(): void {
  cached = undefined
}

/** 可用的视觉模型路线，按「像视觉模型」的程度排序。 */
export function visionRoutes(catalogue: VisionCatalogue): ChatModelRoute[] {
  return catalogue.models
    .filter((item) => item.image)
    .map((item, index) => ({ item, index, score: scoreRoute(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}

function scoreRoute(route: ChatModelRoute): number {
  const text = `${route.provider} ${route.model} ${route.name || ''}`.toLowerCase()
  let value = 0
  if (/describe-image|vision|vl-|-vl|multimodal|omni/.test(text)) value += 6
  if (/qwen|gpt-4o|gpt-4\.1|gemini|claude|glm-4v|doubao|internvl|minicpm|step-1v/.test(text)) value += 4
  if (/image/.test(text)) value += 2
  return value
}

function toRoute(route: ChatModelRoute, declaredImage: boolean): VisionRoute {
  const providerName = route.providerName && route.providerName !== route.provider ? `${route.providerName}（${route.provider}）` : route.provider
  return { provider: route.provider, model: route.model, label: `${providerName} / ${route.model}`, declaredImage }
}

/**
 * 选出用于识图的模型路线。
 *
 * `preference` 由用户显式指定（工具参数或工作台下拉框）时优先采纳，即使该模型
 * 没有声明图片输入 —— 声明可能不全，真正的判定交给 provider 自己。
 */
export async function resolveVisionRoute(
  rt: VisionRuntime,
  preference: { provider?: string; model?: string; refresh?: boolean } = {},
): Promise<{ route: VisionRoute; warnings: string[] }> {
  const catalogue = await describeCatalogue(rt, { refresh: preference.refresh })
  const warnings = [...catalogue.warnings]
  const provider = preference.provider?.trim()
  const model = preference.model?.trim()

  if (provider && model) {
    if (!catalogue.models.length) {
      warnings.push(`未能列出模型清单，已按指定路线直接调用：${provider} / ${model}`)
      return { route: { provider, model, label: `${provider} / ${model}`, declaredImage: true }, warnings }
    }
    const found = catalogue.models.find((item) => item.provider === provider && item.model === model)
    if (!found) {
      warnings.push(`指定模型 ${provider} / ${model} 不在当前模型清单中，仍按该路线调用`)
      return { route: { provider, model, label: `${provider} / ${model}`, declaredImage: true }, warnings }
    }
    if (!found.image) warnings.push(`指定模型 ${provider} / ${model} 未声明图片输入，若失败请改选视觉模型`)
    return { route: toRoute(found, found.image), warnings }
  }

  const routes = visionRoutes(catalogue)
  if (routes.length) return { route: toRoute(routes[0], true), warnings }
  throw new Error(noVisionModelMessage(catalogue))
}

/** 没有任何模型声明图片输入时，给出可操作的诊断而不是笼统报错。 */
function noVisionModelMessage(catalogue: VisionCatalogue): string {
  const lines = catalogue.models.length
    ? catalogue.models.map((item) => `- ${item.provider} / ${item.model}（输入：${item.modalities.join('、') || '未知'}）`).join('\n')
    : '- 当前没有列出任何模型'
  const hints = catalogue.warnings.length ? '\n诊断：' + catalogue.warnings.join('；') : ''
  return '没有可用的图片识别模型：DSH 已注册的模型都未声明图片输入。\n'
    + '当前模型路线：\n' + lines + hints + '\n'
    + '解决办法：为所用模型声明图片输入（例如 llm-pi-ai 的 models 条目加上 input: [text, image]），'
    + '或启用一个视觉模型提供商；也可以在批改工作台里手动指定 provider / model 后重试。'
}

/** 逐块收集一次流式调用，返回纯文本；适配器级失败会在这里抛出。 */
export async function collectStreamText(stream: AsyncIterable<unknown>): Promise<{ text: string; truncated: boolean }> {
  const parts = new Map<number, { type: string; text: string }>()
  const order: number[] = []
  const ensure = (index: number) => {
    let part = parts.get(index)
    if (!part) {
      part = { type: 'text', text: '' }
      parts.set(index, part)
      order.push(index)
    }
    return part
  }

  let failure: { message?: string; status?: number } | undefined
  let finishKind: string | undefined

  for await (const raw of stream) {
    const chunk = raw as any
    switch (chunk?.type) {
      case 'block-start':
        ensure(chunk.index).type = String(chunk.blockType || 'text')
        break
      case 'text-delta':
        ensure(chunk.index).text += String(chunk.text || '')
        break
      case 'block-end': {
        const part = ensure(chunk.index)
        if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') part.text = chunk.block.text
        break
      }
      case 'finish': {
        const reason = chunk.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') failure = reason.failure
        finishKind = reason?.kind
        break
      }
      case 'error':
      case 'aborted':
        failure = chunk.failure
        break
      default:
        break
    }
  }

  if (failure) {
    const status = failure.status ? `（HTTP ${failure.status}）` : ''
    throw new Error('视觉模型调用失败：' + (failure.message || '未知错误') + status)
  }
  if (finishKind && finishKind !== 'stop' && finishKind !== 'max-tokens') {
    throw new Error(`视觉模型调用提前结束（${finishKind}）`)
  }

  const text = order.map((index) => parts.get(index)?.text || '').join('').trim()
  return { text, truncated: finishKind === 'max-tokens' }
}

/** 从模型输出里取出 JSON 批改报告；不合法时降级为待复核的原始文本。 */
export function parseReport(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        /* 继续降级 */
      }
    }
    return { raw: text, needsReview: true }
  }
}

/**
 * 用 DSH 中已配置的视觉模型批改一张作业图片。
 * 图片先落成持久化附件，再作为真正的 image 内容块交给模型识别。
 */
export async function gradeImage(
  rt: VisionRuntime,
  imageDataUrl: string,
  instruction: string,
  options: GradeOptions = {},
): Promise<GradeResult> {
  const { bytes, mediaType, extension } = decodeImageDataUrl(imageDataUrl)
  const { route, warnings } = await resolveVisionRoute(rt, {
    provider: options.provider,
    model: options.model,
  })

  const attachment = await rt.attachments.saveImage({
    data: bytes,
    mediaType,
    name: options.name || `homework.${extension}`,
  })

  const stream = rt.llm.stream({
    provider: route.provider,
    model: route.model,
    maxTokens: options.maxTokens ?? 8000,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.signal ? { signal: options.signal } : {}),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image', attachment },
      ],
    }],
  })

  const { text, truncated } = await collectStreamText(stream)
  if (!text) throw new Error(`视觉模型没有返回任何内容（${route.provider} / ${route.model}）`)
  if (truncated) warnings.push('模型输出达到长度上限，报告可能不完整')

  return {
    provider: route.provider,
    model: route.model,
    report: parseReport(text),
    text,
    truncated,
    warnings,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
