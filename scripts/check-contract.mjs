// Checks openapi.json against a real rclone server.
//
// It downloads the official rclone release for the version in package.json,
// starts it on loopback with a temporary config and home directory, calls the
// API, and fails on anything the spec gets wrong. That includes response fields
// the spec doesn't document, which schema validation alone lets through.
//
// OPENAPI_RCLONE_BIN uses a local binary instead of downloading one.
// OPENAPI_RCLONE_VERSION checks a different version, or "latest".

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AjvModule from 'ajv/dist/2020.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.work', 'cache')
const doc = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// Routes that can only reach an error here, with the reason. Their success
// responses rest on scripts/audit-source.go instead.
const ERROR_ONLY = {
    '/operations/publiclink': 'needs a backend with public links',
    '/operations/cleanup': 'needs a backend that supports cleanup',
    '/operations/settier': 'needs a backend with storage tiers',
    '/operations/settierfile': 'needs a backend with storage tiers',
    '/vfs/poll-interval': 'needs a backend that supports polling',
    '/config/oauthstop': 'needs an OAuth flow in progress',
    '/mount/unmount': 'needs a mounted filesystem',
    '/rc/error': 'always returns an error',
    '/pluginsctl/getPluginsForType': 'needs --rc-web-gui, which downloads the GUI',
    '/pluginsctl/listPlugins': 'needs --rc-web-gui, which downloads the GUI',
    '/pluginsctl/listTestPlugins': 'needs --rc-web-gui, which downloads the GUI',
    '/pluginsctl/removePlugin': 'needs --rc-web-gui, which downloads the GUI',
    '/pluginsctl/removeTestPlugin': 'needs --rc-web-gui, which downloads the GUI',
}

// Routes the test never calls, with the reason.
const NOT_CALLED = {
    '/mount/mount': 'needs FUSE',
    '/pluginsctl/addPlugin': 'needs --rc-web-gui and network access',
}

// Routes in rclone that the spec leaves out on purpose.
const NOT_IN_SPEC = {
    'rc/fatal': 'test helper that stops the server',
    'rc/panic': 'test helper for error handling',
}

// Response locations that are open maps by design, so their keys aren't documented.
const OPEN_MAPS = {
    'rc/noop': [''],
    'rc/noopauth': [''],
    'config/dump': [''],
    'config/get': [''],
    'options/get': [''],
    'serve/list': ['.list[].params'],
    'job/status': ['.output'],
    'backend/command': ['.result'],
    'job/batch': ['.results[]'],
}

// --- Getting rclone -----------------------------------------------------------

async function text(url) {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`${url} returned ${r.status}`)
    return r.text()
}

async function resolveVersion() {
    const wanted = process.env.OPENAPI_RCLONE_VERSION ?? pkg.version
    if (wanted !== 'latest') return wanted.replace(/^v/, '')
    return (await text('https://downloads.rclone.org/version.txt')).trim().replace(/^rclone v/, '')
}

async function getBinary(version) {
    if (process.env.OPENAPI_RCLONE_BIN) return process.env.OPENAPI_RCLONE_BIN
    const platform = { darwin: 'osx', linux: 'linux', win32: 'windows' }[process.platform]
    const arch = { arm64: 'arm64', x64: 'amd64' }[process.arch]
    const name = `rclone-v${version}-${platform}-${arch}`
    const dir = join(CACHE, name)
    const binary = join(dir, name, process.platform === 'win32' ? 'rclone.exe' : 'rclone')
    if (existsSync(binary)) return binary

    console.log(`Downloading ${name}`)
    const base = `https://downloads.rclone.org/v${version}`
    const sums = await text(`${base}/SHA256SUMS`)
    const expected = sums.match(new RegExp(`^([0-9a-f]{64})\\s+${name}\\.zip$`, 'm'))?.[1]
    if (!expected) throw new Error(`${name}.zip isn't listed in SHA256SUMS`)
    const r = await fetch(`${base}/${name}.zip`)
    if (!r.ok) throw new Error(`${name}.zip returned ${r.status}`)
    const zip = Buffer.from(await r.arrayBuffer())
    const actual = createHash('sha256').update(zip).digest('hex')
    if (actual !== expected) throw new Error(`${name}.zip has the wrong checksum`)

    mkdirSync(dir, { recursive: true })
    const zipPath = join(dir, `${name}.zip`)
    writeFileSync(zipPath, zip)
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dir])
    rmSync(zipPath)
    return binary
}

const freePort = () =>
    new Promise((resolve, reject) => {
        const s = createServer()
        s.on('error', reject)
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address()
            s.close(() => resolve(port))
        })
    })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function startServer(binary, work, name, flags) {
    const port = await freePort()
    const home = join(work, `home-${name}`)
    mkdirSync(home, { recursive: true })
    const server = spawn(
        binary,
        ['rcd', '--config', join(home, 'rclone.conf'), '--cache-dir', join(home, 'cache'), '--rc-addr', `127.0.0.1:${port}`, ...flags],
        { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: 'ignore' }
    )
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
        try {
            await fetch(`${base}/rc/noop`, { method: 'POST' })
            return { server, base }
        } catch {
            await sleep(100)
        }
    }
    server.kill()
    throw new Error('rclone did not start')
}

// --- Checking responses -------------------------------------------------------

const ID = 'http://openapi.local/spec'
const Ajv = AjvModule.default ?? AjvModule
const ajv = new Ajv({ strict: false, validateSchema: false, allErrors: true, logger: false, validateFormats: false })
ajv.addSchema({ ...doc, $id: ID })

const problems = []
const problem = message => problems.push(message)
const called = new Set()
const succeeded = new Set()
const validators = new Map()

const escapePointer = s => s.replace(/~/g, '~0').replace(/\//g, '~1')
const resolve = node => (node?.$ref ? node.$ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((o, k) => o[k], doc) : node)

function validator(pointer) {
    if (!validators.has(pointer)) validators.set(pointer, ajv.compile({ $ref: `${ID}#/${pointer}` }))
    return validators.get(pointer)
}

// Walks a response and collects every field the schema doesn't name.
function undocumented(schema, value, at, found, depth = 0) {
    if (depth > 14 || value === null || typeof value !== 'object') return
    const s = resolve(schema) ?? {}
    const branches = [...(s.allOf ?? []), ...(s.anyOf ?? []), ...(s.oneOf ?? [])].map(resolve)
    if (Array.isArray(value)) {
        const items = s.items ?? branches.map(b => b.items).find(Boolean)
        if (!items) {
            if (value.length) found.add(`${at}[]`)
            return
        }
        for (const v of value.slice(0, 50)) undocumented(items, v, `${at}[]`, found, depth + 1)
        return
    }
    const props = { ...s.properties }
    for (const b of branches) Object.assign(props, b.properties)
    const additional = [s.additionalProperties, ...branches.map(b => b.additionalProperties)].find(x => x && typeof x === 'object')
    for (const [k, v] of Object.entries(value)) {
        if (props[k]) undocumented(props[k], v, `${at}.${k}`, found, depth + 1)
        else if (additional) undocumented(additional, v, `${at}.*`, found, depth + 1)
        else found.add(`${at}.${k}`)
    }
}

function checkResponse(route, r, label = route) {
    called.add(`/${route}`)
    if (r.status < 300) succeeded.add(`/${route}`)
    const op = doc.paths[`/${route}`]?.post
    if (!op) return problem(`${label}: the route isn't in the spec`)
    const status = String(r.status)
    const key = op.responses[status] ? status : op.responses[`${status[0]}XX`] ? `${status[0]}XX` : null
    if (!key) return problem(`${label}: status ${r.status} isn't documented`)
    const node = op.responses[key]
    const response = resolve(node)
    const type = (r.type ?? '').split(';')[0]

    if (!response.content) {
        if (r.text.trim()) problem(`${label}: the spec says ${key} has no body, but rclone sent ${r.text.replace(/\s+/g, ' ').slice(0, 80)}`)
        return
    }
    const media = response.content[type]
    if (!media) return problem(`${label}: ${key} doesn't document ${type || 'an empty'} content`)
    if (type !== 'application/json') return

    if (r.json === undefined) return problem(`${label}: ${key} isn't valid JSON`)
    const prefix = node.$ref ? node.$ref.slice(2) : `paths/${escapePointer(`/${route}`)}/post/responses/${key}`
    const validate = validator(`${prefix}/content/application~1json/schema`)
    if (!validate(r.json)) {
        const errors = [...new Set(validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`))].slice(0, 5)
        problem(`${label}: ${errors.join(' | ')}`)
    }
    if (r.status >= 400) return

    const found = new Set()
    undocumented(media.schema, r.json, '', found)
    const open = OPEN_MAPS[route] ?? []
    const extras = [...found].filter(f => !open.some(o => f === o || f.startsWith(`${o}.`) || (o === '' && f.startsWith('.'))))
    if (extras.length) problem(`${label}: undocumented fields ${extras.slice(0, 30).join(' ')}`)
}

// --- Tests --------------------------------------------------------------------

const version = await resolveVersion()
const binary = await getBinary(version)
const reported = execFileSync(binary, ['version', '--check=false'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } }).split('\n')[0]
console.log(`Checking the spec for ${pkg.version} against ${reported}`)

const work = mkdtempSync(join(tmpdir(), 'rclone-openapi-'))
const servers = []
const stopServers = () => {
    for (const s of servers) s.kill()
}
process.on('exit', () => {
    stopServers()
    rmSync(work, { recursive: true, force: true })
})

const user = randomBytes(8).toString('hex')
const pass = randomBytes(16).toString('hex')
const AUTH = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
const main = await startServer(binary, work, 'main', ['--rc-user', user, '--rc-pass', pass, '--rc-allow-origin', 'http://localhost:9999'])
servers.push(main.server)
const noCredentials = await startServer(binary, work, 'open', [])
servers.push(noCredentials.server)

const SRC = join(work, 'src')
const DST = join(work, 'dst')
const DIFF = join(work, 'diff')
const BI1 = join(work, 'bi1')
const BI2 = join(work, 'bi2')
const BIG = join(work, 'big')
const EMPTY = join(work, 'empty')
const SCRATCH = join(work, 'scratch')
for (const d of [join(SRC, 'sub'), DST, DIFF, BI1, BI2, BIG, EMPTY, SCRATCH]) mkdirSync(d, { recursive: true })
writeFileSync(join(SRC, 'a.txt'), 'hello\n')
writeFileSync(join(SRC, 'sub', 'b.txt'), 'world\n')
writeFileSync(join(DIFF, 'a.txt'), 'different\n')
writeFileSync(join(DIFF, 'extra.txt'), 'only here\n')
writeFileSync(join(BI1, 'x.txt'), 'x\n')
writeFileSync(join(BI2, 'y.txt'), 'y\n')
writeFileSync(join(BIG, 'big.bin'), randomBytes(1024 * 1024))

async function raw(path, { method = 'POST', headers = {}, body, query = '', base = main.base, auth = true } = {}) {
    const h = { ...headers }
    if (auth) h.Authorization = AUTH
    const r = await fetch(`${base}/${path}${query}`, { method, headers: h, body, signal: AbortSignal.timeout(60000) })
    const responseText = await r.text()
    let json
    try {
        json = JSON.parse(responseText)
    } catch {}
    return { status: r.status, json, text: responseText, type: r.headers.get('content-type'), headers: r.headers }
}
const call = (path, body = {}, headers = {}) => raw(path, { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const hit = async (path, body = {}, label) => {
    const r = await call(path, body)
    checkResponse(path, r, label)
    return r
}
const PREFER = { Prefer: 'respond-async' }

// Simple calls, in the state of a fresh server
for (const route of [
    'rc/noop', 'rc/noopauth', 'rc/list', 'core/version', 'core/pid', 'core/memstats', 'core/stats', 'core/group-list', 'core/transferred',
    'core/bwlimit', 'core/gc', 'core/disks', 'core/stats-reset', 'config/listremotes', 'config/dump', 'config/providers', 'config/paths',
    'options/blocks', 'options/get', 'options/info', 'options/local', 'serve/list', 'serve/types', 'serve/stopall', 'mount/types', 'mount/listmounts',
    'mount/unmountall', 'fscache/entries', 'fscache/clear', 'job/list', 'vfs/list', 'pluginsctl/listPlugins', 'pluginsctl/listTestPlugins',
    'config/oauthstatus', 'config/oauthstop', 'rc/error',
]) {
    await hit(route)
}

// Core and debug
await hit('core/bwlimit', { rate: '1M' }, 'core/bwlimit set')
await hit('core/bwlimit', { rate: '1M:2M' }, 'core/bwlimit tx:rx')
await hit('core/bwlimit', { rate: 'off' }, 'core/bwlimit off')
await hit('core/obscure', { clear: 'x' })
await hit('core/du', { dir: SRC })
await hit('core/du', {}, 'core/du default')
await hit('core/command', { command: 'version' }, 'core/command default')
await hit('core/command', { command: 'lsf', arg: [SRC], opt: { 'max-depth': '1' } }, 'core/command args')
await hit('core/command', { command: 'version', returnType: 'STREAM' }, 'core/command STREAM')
await hit('core/command', { command: 'version', returnType: 'STREAM_ONLY_STDOUT' }, 'core/command STREAM_ONLY_STDOUT')
await hit('core/stats-delete', { group: 'nope' })
await hit('debug/set-gc-percent', { 'gc-percent': 100 })
await hit('debug/set-block-profile-rate', { rate: 0 })
await hit('debug/set-mutex-profile-fraction', { rate: 0 })
await hit('debug/set-soft-memory-limit', { 'mem-limit': '9223372036854775807' })
await hit('options/get', { blocks: 'main' }, 'options/get blocks=main')
await hit('options/info', { blocks: 'main' }, 'options/info blocks=main')
await hit('options/set', { main: { Timeout: '5m' } })
await hit('backend/command', { command: 'noop', fs: SRC, arg: ['a'], opt: { x: 'y' } })
await hit('backend/command', { command: 'help', fs: SRC }, 'backend/command help')
await hit('pluginsctl/getPluginsForType', { type: 'text/plain', pluginType: 'FileHandler' })
await hit('pluginsctl/removePlugin', { name: 'nope' })
await hit('pluginsctl/removeTestPlugin', { name: 'nope' })
await hit('mount/unmount', { mountPoint: join(work, 'nope') })

// Config, including the interactive flow
await hit('config/create', { name: 't', type: 'alias', parameters: { remote: SRC } })
await hit('config/get', { name: 't' })
await hit('config/update', { name: 't', parameters: { remote: DST } })
await hit('config/update', { name: 't', parameters: { remote: SRC }, opt: { nonInteractive: true } }, 'config/update nonInteractive')
await hit('config/create', { name: 't2', type: 'alias', parameters: { remote: SRC }, opt: { nonInteractive: true } }, 'config/create nonInteractive')
await hit('config/password', { name: 't', parameters: {} })
await hit('config/unset', { name: 't', keys: ['nope'] })
await hit('config/delete', { name: 't' })
await hit('config/delete', { name: 't2' })
await hit('config/unlock', { configPassword: 'x' })
await hit('config/setpath', { path: join(work, 'home-main', 'rclone.conf') })

// Operations, with each listing flag
await hit('operations/mkdir', { fs: DST, remote: 'made' })
await hit('operations/list', { fs: SRC, remote: '' })
for (const flag of ['recurse', 'noModTime', 'noMimeType', 'showEncrypted', 'showOrigIDs', 'showHash', 'dirsOnly', 'filesOnly', 'metadata']) {
    await hit('operations/list', { fs: SRC, remote: '', opt: { [flag]: true } }, `operations/list ${flag}`)
}
await hit('operations/list', { fs: SRC, remote: '', opt: { showHash: true, hashTypes: ['md5'] } }, 'operations/list hashTypes')
await hit('operations/list', { fs: EMPTY, remote: '' }, 'operations/list empty dir')
await hit('operations/list', { fs: { type: 'local', _root: SRC }, remote: '' }, 'operations/list remote object')
const nested = await call('operations/list', { fs: SRC, remote: '', opt: { recurse: true } })
if (!nested.json?.list?.some(i => i.Path === 'sub/b.txt')) problem('operations/list: opt.recurse did not return nested items')
await hit('operations/stat', { fs: SRC, remote: 'a.txt' })
await hit('operations/stat', { fs: SRC, remote: 'sub' }, 'operations/stat dir')
await hit('operations/stat', { fs: SRC, remote: 'a.txt', opt: { showHash: true } }, 'operations/stat hash')
await hit('operations/stat', { fs: SRC, remote: 'missing.txt' }, 'operations/stat missing')
await hit('operations/about', { fs: SRC })
await hit('operations/about', { fs: ':memory:' }, 'operations/about memory')
await hit('operations/fsinfo', { fs: SRC })
await hit('operations/fsinfo', { fs: ':memory:' }, 'operations/fsinfo memory')
await hit('operations/size', { fs: SRC })
await hit('operations/hashsum', { fs: SRC, hashType: 'md5' })
await hit('operations/hashsum', { fs: SRC, hashType: 'md5', base64: true, download: true }, 'operations/hashsum base64')
await hit('operations/hashsumfile', { fs: SRC, remote: 'a.txt', hashType: 'md5' })
await hit('operations/check', { srcFs: SRC, dstFs: SRC })
await hit('operations/check', { srcFs: SRC, dstFs: DIFF, combined: true, match: true }, 'operations/check differences')
await hit('operations/check', { srcFs: SRC, dstFs: SRC, oneWay: true, download: true }, 'operations/check download')
await hit('operations/copyfile', { srcFs: SRC, srcRemote: 'a.txt', dstFs: DST, dstRemote: 'c.txt' })
await hit('operations/movefile', { srcFs: DST, srcRemote: 'c.txt', dstFs: DST, dstRemote: 'd.txt' })
await hit('operations/deletefile', { fs: DST, remote: 'd.txt' })
await hit('operations/publiclink', { fs: SRC, remote: 'a.txt' })
await hit('operations/cleanup', { fs: SRC })
await hit('operations/settier', { fs: SRC, tier: 'x' })
await hit('operations/settierfile', { fs: SRC, remote: 'a.txt', tier: 'x' })
await hit('operations/rmdir', { fs: DST, remote: 'made' })
await hit('operations/mkdir', { fs: DST, remote: 'x/y' }, 'operations/mkdir nested')
await hit('operations/rmdirs', { fs: DST, remote: 'x', leaveRoot: true })
await hit('operations/purge', { fs: DST, remote: 'x' })

// Sync and bisync
await hit('sync/copy', { srcFs: SRC, dstFs: DST })
await hit('sync/sync', { srcFs: SRC, dstFs: DST })
await hit('operations/delete', { fs: DST })
await hit('sync/copy', { srcFs: SRC, dstFs: DST }, 'sync/copy again')
await hit('sync/move', { srcFs: DST, dstFs: join(work, 'moved'), deleteEmptySrcDirs: true })
await hit('core/stats-reset', {}, 'core/stats-reset before bisync')
await hit('sync/bisync', { path1: BI1, path2: BI2, resync: true, workdir: join(work, 'biwork') })
await hit('sync/bisync', { path1: BI1, path2: BI2, dryRun: true, workdir: join(work, 'biwork'), conflictResolve: 'newer', maxLock: '1m', checkSync: 'true' }, 'sync/bisync second run')
await hit('core/transferred', {}, 'core/transferred after bisync')

// Jobs: batch, failed, unknown, running and stopped
await hit('job/batch', { inputs: [{ _path: 'rc/noop', a: 1 }, { _path: 'rc/nope' }] }, 'job/batch mixed')
const batchAsync = await hit('job/batch', { inputs: [{ _path: 'rc/noop', _async: true }] }, 'job/batch item _async')
if (!batchAsync.json?.results?.[0]?.jobid) problem('job/batch: an item with _async did not return a job ID')
checkResponse('job/batch', await call('job/batch', { inputs: [{ _path: 'rc/noop' }] }, PREFER), 'job/batch Prefer')
const failed = await call('operations/mkdir', { fs: 'nope-remote:', remote: 'x' }, PREFER)
checkResponse('operations/mkdir', failed, 'operations/mkdir 202')
await sleep(400)
await hit('job/status', { jobid: failed.json?.jobid }, 'job/status failed job')
await hit('job/status', { jobid: 999999 }, 'job/status unknown job')
await hit('job/stop', { jobid: failed.json?.jobid }, 'job/stop finished job')
await hit('job/stopgroup', { group: 'nope' })

await hit('core/bwlimit', { rate: '128k' }, 'core/bwlimit slow')
const started = Date.now()
const running = await call('sync/copy', { srcFs: BIG, dstFs: ':memory:slow', _group: 'g1' }, PREFER)
if (running.status !== 202 || Date.now() - started > 2000) problem(`Prefer: a slow copy returned ${running.status} after ${Date.now() - started} ms, not a 202 right away`)
if (running.headers.get('preference-applied') !== 'respond-async') problem('Prefer: the Preference-Applied header is missing on a 202')
checkResponse('sync/copy', running, 'sync/copy 202')
await sleep(1200)
await hit('core/stats', {}, 'core/stats during transfer')
await hit('core/stats', { group: 'g1' }, 'core/stats group during transfer')
await hit('core/stats', { short: true }, 'core/stats short')
await hit('core/group-list', {}, 'core/group-list with a group')
await hit('core/transferred', {}, 'core/transferred during transfer')
const status = await hit('job/status', { jobid: running.json?.jobid }, 'job/status running job')
if (status.json?.finished !== false) problem('Prefer: the job had already finished, so the transfer states were not tested')
await hit('job/list', {}, 'job/list running')
await hit('job/stop', { jobid: running.json?.jobid }, 'job/stop running job')
await hit('core/bwlimit', { rate: 'off' }, 'core/bwlimit restore')
await sleep(400)
await hit('core/stats', {}, 'core/stats after a failure')
await hit('core/transferred', {}, 'core/transferred after a failure')
await hit('job/status', { jobid: running.json?.jobid }, 'job/status stopped job')

// Serve and VFS
const served = await hit('serve/start', { type: 'http', fs: SRC, addr: '127.0.0.1:0', read_only: true, vfs_cache_mode: 'off' })
const defaultAddr = await hit('serve/start', { type: 'http', fs: BIG }, 'serve/start without addr')
await hit('serve/list', {}, 'serve/list running')
await hit('vfs/list', {}, 'vfs/list active')
await hit('vfs/stats', { fs: SRC })
await hit('vfs/queue', { fs: SRC })
await hit('vfs/refresh', { fs: SRC }, 'vfs/refresh')
await hit('vfs/refresh', { fs: SRC, recursive: 'true', dir: 'sub' }, 'vfs/refresh recursive')
await hit('vfs/forget', { fs: SRC }, 'vfs/forget')
await hit('vfs/forget', { fs: SRC, file: 'a.txt' }, 'vfs/forget file')
await hit('vfs/poll-interval', { fs: SRC })
if (served.json?.addr) await hit('operations/copyurl', { fs: DST, remote: 'url.txt', url: `http://${served.json.addr}/a.txt`, noClobber: true })
if (served.json?.id) await hit('serve/stop', { id: served.json.id })
if (defaultAddr.json?.id) await hit('serve/stop', { id: defaultAddr.json.id }, 'serve/stop default')
const unknownOption = await call('serve/start', { type: 'http', fs: SRC, addr: '127.0.0.1:0', nope: 1 })
if (unknownOption.status < 400) problem('serve/start: it accepted an unknown option')

// A VFS with a write-back cache, so the upload queue has an item in it
const CACHED = join(work, 'cached')
mkdirSync(CACHED)
const webdav = await hit('serve/start', { type: 'webdav', fs: CACHED, addr: '127.0.0.1:0', vfs_cache_mode: 'full', vfs_write_back: '1h' }, 'serve/start webdav')
if (webdav.json?.addr) {
    await fetch(`http://${webdav.json.addr}/queued.txt`, { method: 'PUT', body: 'queued' })
    await sleep(300)
    await hit('vfs/stats', { fs: CACHED }, 'vfs/stats with cache')
    const queue = await hit('vfs/queue', { fs: CACHED }, 'vfs/queue with an item')
    const item = queue.json?.queue?.[0]
    if (!item) problem('vfs/queue: no queued item, so vfs/queue-set-expiry was not tested')
    else await hit('vfs/queue-set-expiry', { fs: CACHED, id: item.id, expiry: 3600 })
}
await hit('serve/stopall', {}, 'serve/stopall running')

// The cache backend registers its routes when a cache remote is created
const cacheRemote = { type: 'cache', remote: SRC, _root: '' }
const listed = await call('operations/list', { fs: cacheRemote, remote: '' })
if (listed.status >= 400) problem(`cache: creating a cache remote failed: ${listed.text.slice(0, 100)}`)
await call('operations/hashsum', { fs: cacheRemote, hashType: 'md5', download: true })
await hit('cache/stats')
await hit('cache/fetch', { chunks: '0', file: 'a.txt' })
await hit('cache/expire', { remote: 'a.txt' })
await hit('cache/expire', { remote: 'sub/', withData: 'true' }, 'cache/expire dir')

// Uploads can only use the query string and can't run in the background
const uploadForm = fileName => {
    const form = new FormData()
    form.append('f', new Blob(['up']), fileName)
    return form
}
const uploadQuery = `?fs=${encodeURIComponent(DST)}&remote=up`
checkResponse('operations/uploadfile', await raw('operations/uploadfile', { body: uploadForm('a.txt'), query: uploadQuery }))
checkResponse('operations/uploadfile', await raw('operations/uploadfile', { body: uploadForm('b.txt'), query: `${uploadQuery}&_group=up&_config=${encodeURIComponent('{"Transfers":1}')}&_filter=${encodeURIComponent('{"IncludeRule":["*"]}')}` }), 'operations/uploadfile overrides')
const uploaded = await call('operations/stat', { fs: DST, remote: 'up/b.txt' })
if (!uploaded.json?.item) problem('operations/uploadfile: the file did not arrive')
const fields = uploadForm('c.txt')
fields.append('fs', DST)
fields.append('remote', 'up')
if ((await raw('operations/uploadfile', { body: fields })).status !== 400) problem('operations/uploadfile: fs and remote worked as multipart fields, so they may not need to be query params')
const jsonUpload = await call('operations/uploadfile', { fs: DST, remote: 'up' })
if (jsonUpload.status !== 200) problem(`operations/uploadfile: a JSON body returned ${jsonUpload.status}, not the documented 200`)
const asyncUpload = await raw('operations/uploadfile', { body: uploadForm('d.txt'), query: uploadQuery, headers: PREFER })
await sleep(400)
if ((await call('operations/stat', { fs: DST, remote: 'up/d.txt' })).json?.item) problem('operations/uploadfile: a background upload worked, so the spec should document it')
if (asyncUpload.status !== 202) problem(`operations/uploadfile: Prefer returned ${asyncUpload.status}`)

// Transport
const unauthorized = await raw('core/pid', { auth: false })
if (unauthorized.status !== 401) problem(`401: a call with no credentials returned ${unauthorized.status}`)
checkResponse('core/pid', unauthorized, 'core/pid 401')
checkResponse('core/pid', await raw('core/pid', { auth: false, headers: { Authorization: 'Basic eDp5' } }), 'core/pid wrong credentials')
checkResponse('rc/noop', await raw('rc/noop', { headers: { 'Content-Type': 'application/json' }, body: '{' }), 'rc/noop bad JSON')
checkResponse('job/list', await raw('job/list', { auth: false, base: noCredentials.base }), 'job/list on a server with no credentials')
checkResponse('core/version', await raw('core/version', { auth: false, base: noCredentials.base }), 'core/version on a server with no credentials')
const forbidden = await raw('core/pid', { auth: false, base: noCredentials.base })
if (forbidden.status !== 403) problem(`403: a server with no credentials returned ${forbidden.status} for core/pid`)
checkResponse('core/pid', forbidden, 'core/pid 403')
const emptyJson = await raw('rc/noop', { headers: { 'Content-Type': 'application/json' } })
if (emptyJson.status !== 400) problem(`transport: JSON content type with an empty body returned ${emptyJson.status}, not the documented 400`)
const noBody = await raw('rc/noop')
if (noBody.status !== 200) problem(`transport: a call with no body returned ${noBody.status}`)
const preferred = await call('rc/noop', {}, PREFER)
if (preferred.status !== 202 || !preferred.json?.jobid) problem(`Prefer: expected a 202 with a job ID, got ${preferred.status}`)
const asyncParam = await call('rc/noop', { _async: true })
if (asyncParam.status !== 200 || !asyncParam.json?.jobid) problem(`_async: expected a 200 with a job ID, got ${asyncParam.status}`)
if (!asyncParam.headers.get('x-rclone-jobid')) problem('headers: x-rclone-jobid is missing')
for (const [route, body] of [['core/version', { _group: 'zz' }], ['core/version', { _config: { Transfers: 3 } }], ['core/version', { _filter: { IncludeRule: ['*'] } }]]) {
    if ((await call(route, body)).status !== 200) problem(`${route}: ${Object.keys(body)[0]} was not accepted, but the spec declares it on every route`)
}
const preflight = await raw('sync/copy', { method: 'OPTIONS', auth: false, headers: { Origin: 'http://localhost:9999', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,prefer,authorization' } })
const allowed = preflight.headers.get('access-control-allow-headers') ?? ''
for (const h of ['Authorization', 'Content-Type', 'Prefer']) if (!allowed.includes(h)) problem(`CORS: ${h} isn't allowed in a preflight`)

// Every documented body field, sent as JSON with the type the spec gives it
const collect = schema => {
    const s = resolve(schema) ?? {}
    const out = { props: {}, required: [] }
    for (const part of s.allOf ?? []) {
        const c = collect(part)
        Object.assign(out.props, c.props)
        out.required.push(...c.required)
    }
    Object.assign(out.props, s.properties)
    out.required.push(...(s.required ?? []))
    return out
}
const sample = (key, schema) => {
    const s = resolve(schema) ?? {}
    if (s.anyOf || s.oneOf) return sample(key, (s.anyOf ?? s.oneOf)[0])
    if (s.enum) return s.enum[0]
    const type = [].concat(s.type ?? 'string')[0]
    if (type === 'boolean') return true
    if (type === 'integer') return 1
    if (type === 'number') return 1.5
    if (type === 'array') return [sample(key, s.items ?? { type: 'string' })]
    if (type === 'object') return {}
    if (/fs$/i.test(key) || /^path[12]$/.test(key)) return SCRATCH
    if (/Dir[12]$/.test(key)) return join(work, 'backup')
    if (/dir$/i.test(key)) return SCRATCH
    if (/maxLock|interval|timeout|expire/i.test(key)) return '1m'
    return 'x'
}
const BASES = {
    '/job/status': { jobid: 1 },
    '/job/stop': { jobid: 999999 },
    '/job/stopgroup': { group: 'x' },
    '/job/batch': { inputs: [] },
    '/config/create': { name: 'o', type: 'alias', parameters: { remote: SCRATCH } },
    '/config/update': { name: 'o', parameters: {} },
    '/config/password': { name: 'o', parameters: {} },
    '/config/get': { name: 'o' },
    '/config/delete': { name: 'o' },
    '/config/unset': { name: 'o', keys: ['a'] },
    '/config/setpath': { path: join(work, 'home-main', 'rclone.conf') },
    '/backend/command': { command: 'noop', fs: SCRATCH },
    '/core/obscure': { clear: 'x' },
    '/core/stats-delete': { group: 'x' },
    '/vfs/queue-set-expiry': { fs: SCRATCH, id: 1, expiry: 1 },
    '/mount/unmount': { mountPoint: '/nope' },
    '/operations/hashsum': { fs: SCRATCH, hashType: 'md5' },
    '/operations/hashsumfile': { fs: SCRATCH, remote: 'none.txt', hashType: 'md5' },
    '/operations/check': { srcFs: SCRATCH, dstFs: SCRATCH },
    '/operations/copyurl': { fs: SCRATCH, remote: 'z', url: 'http://127.0.0.1:1/x' },
    '/operations/copyfile': { srcFs: SCRATCH, srcRemote: 'none.txt', dstFs: SCRATCH, dstRemote: 'k.txt' },
    '/operations/movefile': { srcFs: SCRATCH, srcRemote: 'none.txt', dstFs: SCRATCH, dstRemote: 'k.txt' },
    '/sync/bisync': { path1: BI1, path2: BI2, dryRun: true, workdir: join(work, 'biwork') },
    '/debug/set-gc-percent': { 'gc-percent': 100 },
    '/debug/set-block-profile-rate': { rate: 0 },
    '/debug/set-mutex-profile-fraction': { rate: 0 },
    '/debug/set-soft-memory-limit': { 'mem-limit': 9007199254740991 },
    '/cache/expire': { remote: 'none' },
    '/pluginsctl/removePlugin': { name: 'x' },
    '/pluginsctl/removeTestPlugin': { name: 'x' },
    '/pluginsctl/getPluginsForType': { type: 'x', pluginType: 'y' },
    '/serve/stop': { id: 'x' },
}
const SKIP_SWEEP = new Set(['/core/quit', '/mount/mount', '/pluginsctl/addPlugin', '/config/unlock', '/rc/error', '/serve/stopall', '/serve/start', '/core/command'])
const TYPE_ERROR = /expecting|must be string|Reshape|couldn't parse|parse duration|cannot unmarshal|overflows/i
let sent = 0
const sweepServer = await call('serve/start', { type: 'http', fs: SCRATCH, addr: '127.0.0.1:0' })
for (const [path, item] of Object.entries(doc.paths)) {
    const schema = item.post.requestBody?.content?.['application/json']?.schema
    if (!schema || SKIP_SWEEP.has(path)) continue
    const { props, required } = collect(schema)
    const base = BASES[path] ?? Object.fromEntries(required.map(k => [k, /remote/i.test(k) ? 'none.txt' : sample(k, props[k])]))

    // Omitting a required field has to be an error
    for (const key of required) {
        const body = { ...base }
        delete body[key]
        const r = await call(path.slice(1), body)
        if (r.status < 400) problem(`${path}: the spec requires ${key}, but rclone accepted a call without it`)
    }
    // Each optional field has to be accepted with its documented type
    for (const [key, s] of Object.entries(props)) {
        if (key in base) continue
        sent++
        const value = sample(key, s)
        const r = await call(path.slice(1), { ...base, [key]: value })
        const error = String(r.json?.error ?? '')
        if (TYPE_ERROR.test(error)) problem(`${path}: ${key} = ${JSON.stringify(value)} was rejected: ${error.slice(0, 100)}`)
    }
}
if (sweepServer.json?.id) await call('serve/stop', { id: sweepServer.json.id })

// The spec and rc/list have to name the same routes and the same auth rules
const live = (await call('rc/list')).json?.commands ?? []
for (const c of live) {
    if (!doc.paths[`/${c.Path}`] && !NOT_IN_SPEC[c.Path]) problem(`routes: ${c.Path} is in rclone but not in the spec`)
}
const liveNames = new Set(live.map(c => c.Path))
for (const path of Object.keys(doc.paths)) {
    if (!liveNames.has(path.slice(1))) problem(`routes: ${path} is in the spec but not in rclone`)
}
if (doc.security) {
    for (const c of live) {
        const op = doc.paths[`/${c.Path}`]?.post
        if (!op) continue
        const open = Array.isArray(op.security) && op.security.length === 0
        if (Boolean(c.NoAuth) !== open) problem(`auth: rclone says NoAuth=${Boolean(c.NoAuth)} for ${c.Path}, but the spec says ${open ? 'no auth' : 'auth'}`)
    }
}

// Coverage has to match the lists at the top of this file
await hit('core/quit')
for (const path of Object.keys(doc.paths)) {
    if (NOT_CALLED[path]) {
        if (called.has(path)) problem(`coverage: ${path} is listed as not called, but it was`)
        continue
    }
    if (!called.has(path)) problem(`coverage: ${path} was never called and isn't listed with a reason`)
    else if (succeeded.has(path) && ERROR_ONLY[path]) problem(`coverage: ${path} is listed as error only, but it succeeded`)
    else if (!succeeded.has(path) && !ERROR_ONLY[path]) problem(`coverage: ${path} never succeeded and isn't listed with a reason`)
}

const routes = Object.keys(doc.paths).length
console.log(`Called ${called.size} of ${routes} routes, ${succeeded.size} with a success response. Sent ${sent} optional fields as JSON.`)
if (problems.length) {
    console.error(`\n${problems.length} problems:\n`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
}
console.log('The spec matches rclone.')
