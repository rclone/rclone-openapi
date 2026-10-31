// Installs the packed package into a temporary project, then tests every import
// the README shows, in Node and in TypeScript.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc')
const app = mkdtempSync(join(tmpdir(), 'rclone-openapi-package-'))
process.on('exit', () => rmSync(app, { recursive: true, force: true }))

const failures = []
const write = (name, content) => writeFileSync(join(app, name), content)
const quiet = (command, args, cwd = app) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const attempt = (label, fn) => {
    try {
        fn()
        console.log(`ok    ${label}`)
    } catch (error) {
        console.log(`FAIL  ${label}`)
        failures.push(`${label}\n${String(error.stdout || '') + String(error.stderr || '') || error.message}`.trim())
    }
}

write('package.json', JSON.stringify({ name: 'app', private: true }))
const tarball = quiet('npm', ['pack', '--silent', '--pack-destination', app], ROOT).trim().split('\n').pop()
quiet('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(app, tarball)])

const expectVersion = (name, script) => {
    write(name, script)
    attempt(`node ${name}`, () => {
        const out = quiet('node', [name]).trim()
        if (out !== version) throw new Error(`printed ${out}, expected ${version}`)
    })
}
expectVersion('esm-default.mjs', "import schema from 'rclone-openapi'\nconsole.log(schema.info.version)\n")
expectVersion('esm-json.mjs', "import schema from 'rclone-openapi/openapi.json' with { type: 'json' }\nconsole.log(schema.info.version)\n")
expectVersion('cjs-default.cjs', "const schema = require('rclone-openapi')\nconsole.log(schema.info.version)\n")
expectVersion('cjs-package.cjs', "console.log(require('rclone-openapi/package.json').version)\n")
write('cjs-yaml.cjs', "const fs = require('node:fs')\nconst text = fs.readFileSync(require.resolve('rclone-openapi/openapi.yaml'), 'utf8')\nif (!text.startsWith('openapi:')) throw new Error('not the spec')\n")
attempt('node cjs-yaml.cjs', () => quiet('node', ['cjs-yaml.cjs']))

const typeExamples = `type ListRemotesResponse = paths['/config/listremotes']['post']['responses']['200']['content']['application/json']
type CopyFileBody = NonNullable<operations['operationsCopyfile']['requestBody']>['content']['application/json']
type AsyncJob = components['responses']['AsyncJobResponse']['content']['application/json']
export type { ListRemotesResponse, CopyFileBody, AsyncJob }
export const version: string = schema.info.version
`
write('esm.mts', `import schema from 'rclone-openapi'
import type { paths, operations, components } from 'rclone-openapi'
${typeExamples}`)
write('cjs.cts', `import schema = require('rclone-openapi')
import type { paths, operations, components } from 'rclone-openapi'
${typeExamples}`)
write('bundler.ts', `import schema from 'rclone-openapi'
import json from 'rclone-openapi/openapi.json'
import type { paths, operations, components } from 'rclone-openapi'
export const jsonVersion: string = json.info.version
${typeExamples}`)
write('types-only.ts', "import type { paths } from 'rclone-openapi/types'\nexport type Routes = keyof paths\n")

const tsc = (moduleKind, resolution, file) =>
    attempt(`tsc ${resolution} ${file}`, () => quiet(TSC, ['--noEmit', '--strict', '--target', 'es2022', '--module', moduleKind, '--moduleResolution', resolution, '--resolveJsonModule', '--esModuleInterop', file]))
tsc('esnext', 'bundler', 'bundler.ts')
tsc('esnext', 'bundler', 'types-only.ts')
for (const kind of ['node16', 'nodenext']) {
    tsc(kind, kind, 'esm.mts')
    tsc(kind, kind, 'cjs.cts')
}

if (failures.length) {
    console.error(`\n${failures.length} failures:\n\n${failures.join('\n\n')}`)
    process.exit(1)
}
console.log('Every import works.')
