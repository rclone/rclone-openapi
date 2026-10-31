// Generates everything that comes from openapi.yaml, which is the file people edit.
//
// It copies the package.json version into info.version, so the version only needs
// setting in one place. Then it writes openapi.json, types.d.ts and index.mjs.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = name => join(ROOT, name)
const bin = name => file(join('node_modules', '.bin', name))
const run = (name, args) => execFileSync(bin(name), args, { cwd: ROOT, stdio: 'inherit' })

const { version } = JSON.parse(readFileSync(file('package.json'), 'utf8'))
const yaml = readFileSync(file('openapi.yaml'), 'utf8')
writeFileSync(file('openapi.yaml'), yaml.replace(/^ {2}version: .*$/m, `  version: ${version}`))

run('redocly', ['bundle', 'openapi.yaml', '-o', 'openapi.json', '--ext', 'json'])
run('openapi-typescript', ['openapi.yaml', '-o', 'types.d.ts'])

// Plain ESM needs no import attribute, so it doesn't depend on Node or bundler support for one.
const json = readFileSync(file('openapi.json'), 'utf8').trim()
writeFileSync(file('index.mjs'), `export default ${json}\n`)
