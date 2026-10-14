import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeImageDataUrl, parseReport } from '../lib/vision.js'

test('plugin is configured as a DSH web client and has no embedded API key', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-homework-correction')
  assert.equal(pkg.dsh.client.platform, 'web')
  const files = await Promise.all([
    readFile(new URL('../src/vision.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client.tsx', import.meta.url), 'utf8'),
  ])
  assert.ok(files[1].includes('开始批改'))
  assert.ok(!files.join('\n').match(/sk-[A-Za-z0-9]{20,}/))
})

test('vision layer reads models through the DSH llm service', async () => {
  const source = await readFile(new URL('../src/vision.ts', import.meta.url), 'utf8')
  // 头部注释会解释旧实现为何失败，先去掉注释再检查真正的代码。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(code.includes('listProviders'), 'must enumerate registered providers')
  assert.ok(code.includes('listModels'), 'must read model input modalities')
  assert.ok(code.includes('saveImage'), 'must store the image as a durable attachment')
  assert.ok(code.includes('llm.stream'), 'must call the model through the DSH llm service')
  assert.ok(!/readFileSync|credentials\.yaml|settings\.yaml/.test(code), 'must not read DSH config or credential files')
  assert.ok(!/chat\/completions/.test(code), 'must not hand-roll provider HTTP')
})

test('decodeImageDataUrl normalizes supported formats and rejects the rest', () => {
  const source = 'data:image/jpg;base64,' + Buffer.from('homework-bytes').toString('base64')
  const decoded = decodeImageDataUrl(source)
  assert.equal(decoded.mediaType, 'image/jpeg')
  assert.equal(decoded.extension, 'jpg')
  assert.equal(Buffer.from(decoded.bytes).toString(), 'homework-bytes')

  assert.equal(decodeImageDataUrl('data:image/png;base64,AAAA').extension, 'png')
  assert.equal(decodeImageDataUrl('data:image/webp;base64,AAAA').extension, 'webp')
  assert.throws(() => decodeImageDataUrl('data:image/gif;base64,AAAA'), /不受支持/)
  assert.throws(() => decodeImageDataUrl('https://example.com/a.png'), /不受支持/)
  assert.throws(() => decodeImageDataUrl('data:image/png;base64,'), /不受支持/)
})

test('parseReport tolerates fenced and noisy JSON', () => {
  assert.deepEqual(parseReport('```json\n{"subject":"物理"}\n```'), { subject: '物理' })
  assert.deepEqual(parseReport('前言 {"summary":{"total":4}} 后记'), { summary: { total: 4 } })
  const fallback = parseReport('完全不是 JSON')
  assert.equal(fallback.needsReview, true)
  assert.equal(fallback.raw, '完全不是 JSON')
})
