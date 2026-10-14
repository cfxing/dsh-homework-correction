import React, { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

const PLUGIN_ID = 'dsh-homework-correction'
const API = '/homework-correction/v1'
export const inject = ['slots', 'layout']

type Report = { id: string; createdAt: string; model: string; provider: string; report: any; imagePath?: string }

export function apply(ctx: Context): void {
  try {
    const ui = ctx as any
    if (!ui.slots || typeof ui.slots.inject !== 'function') return
    installStyles()
    let dispose: (() => void) | undefined
    const open = () => {
      dispose?.()
      let remove = () => {}
      remove = ui.slots.register({ name: 'main', key: PLUGIN_ID }, () => <HomeworkWorkspace close={() => { remove(); dispose = undefined }} />)
      dispose = remove
      try { ui.layout?.selectPanel?.(PLUGIN_ID) } catch (error) { console.error('[dsh-homework-correction] panel open failed:', error) }
    }
    ui.slots.inject('sidebar.footer.action', () => ui.slots.register({ name: 'sidebar.footer.action', id: 'homework-correction', order: -8 }, () =>
      <button className="hwc-launcher" title="作业批改" onClick={open}><span>批</span><b>作业批改</b></button>
    ))
    if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose?.(), 'dsh-homework-correction: client lifecycle')
  } catch (error) {
    console.error('[dsh-homework-correction] client activation failed:', error)
  }
}

function installStyles(): void {
  if (typeof document === 'undefined' || document.querySelector('style[data-plugin="dsh-homework-correction"]')) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-homework-correction'
  style.textContent = [
    '.hwc-launcher{display:flex;align-items:center;gap:9px;width:100%;padding:9px 12px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer;text-align:left}',
    '.hwc-launcher:hover{background:var(--dsw-alias-fill-l1,#f2f4f7)}.hwc-launcher span{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#e4edff;color:#275dcc;font-weight:700}.hwc-launcher b{font-size:13px;font-weight:600}',
    '.hwc-shell{height:100%;min-height:0;display:flex;flex-direction:column;gap:16px;padding:24px;overflow:auto;color:var(--dsw-alias-label-primary,#172033);background:var(--dsw-alias-bg-base,#f7f8fb);font:14px/1.5 system-ui,sans-serif}',
    '.hwc-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.hwc-head h1{margin:0;font-size:24px}.hwc-muted{color:var(--dsw-alias-label-secondary,#697386);font-size:12px}',
    '.hwc-grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(280px,1fr);gap:16px}.hwc-card{border:1px solid var(--dsw-alias-border-l1,#e0e4eb);border-radius:14px;padding:18px;background:var(--dsw-alias-fill-l1,#fff);min-width:0}',
    '.hwc-card h2{font-size:16px;margin:0 0 12px}.hwc-drop{display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;min-height:180px;border:1px dashed #aebbd0;border-radius:12px;padding:18px;text-align:center;background:#f8faff}',
    '.hwc-drop img{max-width:100%;max-height:320px;object-fit:contain;border-radius:8px}.hwc-drop input{max-width:100%}.hwc-btn{border:1px solid #d3dae6;border-radius:9px;padding:8px 13px;background:#fff;color:#26354b;cursor:pointer}.hwc-btn.primary{background:#3168df;border-color:#3168df;color:#fff}.hwc-btn:disabled{opacity:.55;cursor:wait}',
    '.hwc-field{display:flex;flex-direction:column;gap:6px;margin-top:14px}.hwc-field textarea{min-height:74px;resize:vertical;border:1px solid #d5dce7;border-radius:8px;padding:9px;font:inherit;width:100%;box-sizing:border-box}',
    '.hwc-error{padding:10px 12px;border-radius:8px;background:#fff0f0;color:#a8212a}.hwc-report-list{display:flex;flex-direction:column;gap:8px}.hwc-report-row{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid #e2e7ef;border-radius:10px;padding:10px;text-align:left;background:#fff;color:inherit;cursor:pointer}',
    '.hwc-result{white-space:pre-wrap;overflow-wrap:anywhere}.hwc-result h3{font-size:14px;margin:16px 0 8px}.hwc-question{padding:12px 0;border-top:1px solid #e8ebf1}.hwc-verdict{font-weight:700}.hwc-verdict.bad{color:#b4232d}.hwc-verdict.good{color:#137647}.hwc-verdict.warn{color:#9a5b00}',
    '@media(max-width:800px){.hwc-grid{grid-template-columns:1fr}.hwc-shell{padding:14px}}'
  ].join('\n')
  document.head.appendChild(style)
}

function HomeworkWorkspace({ close }: { close: () => void }) {
  const [image, setImage] = useState('')
  const [filename, setFilename] = useState('')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reports, setReports] = useState<Report[]>([])
  const [selected, setSelected] = useState<Report | null>(null)
  const [model, setModel] = useState('')
  const load = async () => {
    try {
      const response = await fetch(API + '/reports')
      const data = await readJsonResponse(response, '读取历史失败')
      if (!response.ok) throw new Error(data?.error || '读取历史失败（HTTP ' + response.status + '）')
      if (!Array.isArray(data)) throw new Error('历史接口返回格式不正确：预期为 JSON 数组')
      setReports(data)
    } catch (e) { setError(message(e)) }
  }
  useEffect(() => { void load() }, [])
  const pick = async (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('请选择 PNG、JPEG 或 WebP 图片'); return }
    if (file.size > 12 * 1024 * 1024) { setError('图片超过 12 MB，请先压缩'); return }
    setError('')
    const reader = new FileReader()
    reader.onload = () => { setImage(String(reader.result || '')); setFilename(file.name); setSelected(null) }
    reader.onerror = () => setError('读取图片失败')
    reader.readAsDataURL(file)
  }
  const grade = async () => {
    if (!image) { setError('请先上传作业照片'); return }
    setBusy(true); setError('')
    try {
      const response = await fetch(API + '/grade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imageDataUrl: image, instruction }) })
      const data = await readJsonResponse(response, '批改失败')
      if (!response.ok) throw new Error(data?.error || '批改失败（HTTP ' + response.status + '）')
      if (!data || typeof data !== 'object') throw new Error('批改接口返回格式不正确：预期为 JSON 对象')
      setSelected(data); setModel(data.provider + ' / ' + data.model); await load()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const report = selected?.report
  const questions = Array.isArray(report?.questions) ? report.questions : []
  return <div className="hwc-shell">
    <header className="hwc-head"><div><h1>作业批改</h1><div className="hwc-muted">视觉模型直接识别题目与手写 · 逐题判分 · 解析与错因 · 不依赖独立 OCR 服务</div></div><button className="hwc-btn" onClick={close}>返回</button></header>
    {error && <div className="hwc-error">{error}</div>}
    <div className="hwc-grid">
      <section className="hwc-card"><h2>1. 上传作业</h2><label className="hwc-drop">
        {image ? <img src={image} alt="待批改作业" /> : <><strong>选择作业照片</strong><span className="hwc-muted">支持 PNG / JPEG / WebP，单张不超过 12 MB</span></>}
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => void pick(e.target.files?.[0])} />
      </label>
      {filename && <p className="hwc-muted">已选择：{filename}</p>}
      <label className="hwc-field">批改要求（可选）<textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：八年级数学，满分 100 分，步骤不完整要扣分…" /></label>
      <p><button className="hwc-btn primary" disabled={busy || !image} onClick={() => void grade()}>{busy ? '正在识别并批改…' : '开始批改'}</button> <button className="hwc-btn" disabled={busy} onClick={() => { setImage(''); setFilename(''); setSelected(null); setError('') }}>清空</button></p>
      <div className="hwc-muted">模型配置来自 DSH 本机 settings.yaml；插件不会把 API Key 写入页面或仓库。</div></section>
      <section className="hwc-card"><h2>2. 批改报告</h2>
        {selected ? <><div className="hwc-muted">{new Date(selected.createdAt).toLocaleString()} · {model}</div><div className="hwc-result">
          {report?.subject && <p><b>学科：</b>{report.subject}　{report.grade || ''}</p>}
          {report?.summary && <p><b>总评：</b>{report.summary.score ?? '待核分'} 分 / {report.summary.total ?? questions.length} 题；正确 {report.summary.correct ?? '—'}，错误 {report.summary.incorrect ?? '—'}，部分正确 {report.summary.partial ?? '—'}，待复核 {report.summary.needsReview ?? '—'}。</p>}
          {questions.map((q: any, i: number) => <article className="hwc-question" key={i}><h3>第 {q.number ?? i + 1} 题 <span className={'hwc-verdict ' + verdictClass(q.verdict)}>{q.verdict || '待复核'}</span></h3>
            {q.question && <p><b>题目：</b>{q.question}</p>}<p><b>学生作答：</b>{q.studentAnswer || '未识别'}</p><p><b>标准答案：</b>{q.correctAnswer || '待确认'}</p>{q.score != null && <p><b>得分：</b>{q.score}</p>}
            {q.explanation && <p><b>解析：</b>{q.explanation}</p>}{q.errorCause && <p><b>错因：</b>{q.errorCause}</p>}
            {!!q.knowledgePoints?.length && <p><b>知识点：</b>{q.knowledgePoints.join('、')}</p>}
            {q.confidence != null && <p><b>置信度：</b>{Math.round(q.confidence * 100)}%</p>}{q.reviewReason && <p><b>复核原因：</b>{q.reviewReason}</p>}
          </article>)}
          {!questions.length && <pre>{JSON.stringify(report, null, 2)}</pre>}
          {report?.summary?.weakPoints?.length > 0 && <p><b>薄弱知识点：</b>{report.summary.weakPoints.join('、')}</p>}{report?.summary?.advice && <p><b>教师建议：</b>{report.summary.advice}</p>}
        </div></> : <p className="hwc-muted">上传照片并开始批改后，结果会显示在这里。模型无法可靠识别的内容会标记为待复核。</p>}
      </section>
    </div>
    <section className="hwc-card"><h2>历史批改</h2><div className="hwc-report-list">{reports.map(r => <button className="hwc-report-row" key={r.id} onClick={() => { setSelected(r); setModel(r.provider + ' / ' + r.model) }}><span><b>{r.report?.subject || '作业批改'}</b><br/><small className="hwc-muted">{new Date(r.createdAt).toLocaleString()} · {r.report?.summary?.total ?? r.report?.questions?.length ?? 0} 题</small></span><span>查看报告 →</span></button>)}{!reports.length && <div className="hwc-muted">暂无历史记录</div>}</div></section>
  </div>
}

function verdictClass(value: unknown): string {
  const text = String(value || '')
  if (text.includes('正确') && !text.includes('错误') && !text.includes('部分')) return 'good'
  if (text.includes('错误')) return 'bad'
  return 'warn'
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function readJsonResponse(response: Response, fallback: string): Promise<any> {
  const body = await response.text()
  if (!body.trim()) {
    throw new Error(fallback + '：服务器返回空响应（HTTP ' + response.status + '）。请检查插件 API 路由是否已激活，并查看 Harness 服务端日志。')
  }
  try {
    return JSON.parse(body)
  } catch {
    const preview = body.slice(0, 240).replace(/\\s+/g, ' ')
    throw new Error(fallback + '：服务器返回的不是有效 JSON（HTTP ' + response.status + '）。响应内容：' + preview)
  }
}
