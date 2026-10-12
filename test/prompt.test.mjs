import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('plugin is configured as a DSH web client and has no embedded API key', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-homework-correction')
  assert.equal(pkg.dsh.client.platform, 'web')
  const files = await Promise.all([
    readFile(new URL('../src/vision.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client.tsx', import.meta.url), 'utf8'),
  ])
  assert.ok(files[0].includes('discoverVisionProvider'))
  assert.ok(files[1].includes('开始批改'))
  assert.ok(!files.join('\n').match(/sk-[A-Za-z0-9]{20,}/))
})
