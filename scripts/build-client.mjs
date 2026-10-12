import ts from 'typescript'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(root, 'src/client.tsx'), 'utf8')
const result = ts.transpileModule(source, {
  fileName: 'client.tsx',
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
})
const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
if (errors.length) {
  throw new Error(ts.formatDiagnostics(errors, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }))
}
const body = result.outputText.split('\n').map((line) => '    ' + line).join('\n')
const wrapped = 'window.__ModuleLoader__.load({\n'
  + '  id: "dsh-homework-correction",\n'
  + '  factory: (require) => {\n'
  + '    var module = { exports: {} };\n'
  + '    var exports = module.exports;\n'
  + body + '\n'
  + '    return module.exports;\n'
  + '  }\n'
  + '});\n'
await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/client.js'), wrapped, 'utf8')
