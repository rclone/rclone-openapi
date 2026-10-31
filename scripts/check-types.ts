// Type test: compiles real openapi-fetch calls against types.d.ts.
// Each @ts-expect-error fails the build if that call starts compiling.

import createClient from 'openapi-fetch'
import type { components, paths } from '../types'

const client = createClient<paths>({ baseUrl: 'http://localhost:5572' })

type Body<Path extends keyof paths> = NonNullable<paths[Path]['post']['requestBody']> extends {
    content: { 'application/json': infer B }
}
    ? B
    : never

export async function requiredFields() {
    // @ts-expect-error jobid is missing
    await client.POST('/job/status')
    // @ts-expect-error jobid is missing
    await client.POST('/job/status', {})
    // @ts-expect-error jobid is missing
    await client.POST('/job/status', { body: {} })
    // @ts-expect-error query params aren't documented
    await client.POST('/job/status', { params: { query: { jobid: 1 } } })

    await client.POST('/job/status', { body: { jobid: 1 } })
    await client.POST('/core/version')
    await client.POST('/core/version', { body: { _group: 'g' } })
}

export async function uploads(form: FormData) {
    const multipart = form as never
    // @ts-expect-error fs and remote are missing
    await client.POST('/operations/uploadfile', { body: multipart })
    // @ts-expect-error uploads can't run in the background
    await client.POST('/operations/uploadfile', { params: { query: { fs: 'a:', remote: 'x' }, header: { Prefer: 'respond-async' } }, body: multipart })

    await client.POST('/operations/uploadfile', { params: { query: { fs: 'a:', remote: 'x', _group: 'g' } }, body: multipart })
}

export async function requestTypes() {
    await client.POST('/operations/list', { body: { fs: '/tmp', remote: '', opt: { recurse: true, hashTypes: ['md5'] } } })
    await client.POST('/operations/list', { body: { fs: { type: 'local', _root: '/tmp' }, remote: '' } })
    await client.POST('/sync/copy', { body: { srcFs: 'a:', dstFs: 'b:', _config: { Transfers: 2 }, _filter: { IncludeRule: ['*'] } } })
    await client.POST('/config/create', { body: { name: 'x', type: 'alias', parameters: { remote: '/tmp' }, opt: { nonInteractive: true } } })
    await client.POST('/core/command', { body: { command: 'ls', arg: ['/tmp'], opt: { 'max-depth': '1' }, returnType: 'STREAM' } })
    await client.POST('/operations/settier', { body: { fs: 'a:', tier: 'x' } })
    await client.POST('/serve/start', { body: { type: 'http', fs: '/tmp', read_only: true } })
    await client.POST('/options/set', { body: { vfs: { CacheMode: 'full' } } })
    await client.POST('/rc/noop', { body: { anything: 1 } })
    await client.POST('/job/batch', { body: { inputs: [{ _path: 'rc/noop', _async: true }] } })

    // @ts-expect-error recursive must be a string
    await client.POST('/vfs/refresh', { body: { recursive: true } })
    await client.POST('/vfs/refresh', { body: { recursive: 'true' } })
    await client.POST('/vfs/refresh', { body: { _group: 'g', dir: '/a', dir2: '/b' } })
    // @ts-expect-error the extra keys on this route are strings, so the schema leaves _config out
    await client.POST('/vfs/refresh', { body: { _config: { Transfers: 2 } } })
}

// openapi-fetch doesn't reject extra body fields, but a direct annotation does
export const directAnnotations = {
    // @ts-expect-error rclone ignores recurse at the top level
    list: { fs: '/tmp', remote: '', recurse: true } as const satisfies Body<'/operations/list'>,
    // @ts-expect-error _async isn't documented on routes, use the Prefer header
    copy: { srcFs: 'a:', dstFs: 'b:', _async: true } as const satisfies Body<'/sync/copy'>,
    // @ts-expect-error the spec only documents opt.obscure
    create: { name: 'x', type: 'y', parameters: {}, obscure: true } as const satisfies Body<'/config/create'>,
    // @ts-expect-error the spec only documents backupDir1
    bisync: { path1: 'a', path2: 'b', backupdir1: 'x' } as const satisfies Body<'/sync/bisync'>,
}

export async function asyncCalls() {
    const { data, response } = await client.POST('/sync/copy', {
        body: { srcFs: 'a:', dstFs: 'b:' },
        params: { header: { Prefer: 'respond-async' } },
    })
    // data is a union of the 200 and 202 bodies, because the header doesn't narrow it
    if (response.status === 202 && data && 'jobid' in data) {
        const id: number = data.jobid
        return id
    }
    // @ts-expect-error only respond-async is allowed
    await client.POST('/sync/copy', { body: { srcFs: 'a:', dstFs: 'b:' }, params: { header: { Prefer: 'nope' } } })
}

export type AsyncJob = components['responses']['AsyncJobResponse']['content']['application/json']
