# Rclone OpenAPI

[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rclone)
[![npm version](https://img.shields.io/npm/v/rclone-openapi?color=cb0000&logo=npm)](https://www.npmjs.com/package/rclone-openapi)
[![npm downloads](https://img.shields.io/npm/dm/rclone-openapi?color=cb0000&logo=npm)](https://www.npmjs.com/package/rclone-openapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OpenAPI 3.1 specification for the [**Rclone RC API**](https://rclone.org/rc/).

Each release describes exactly one rclone version, and the package version matches it.

## Installation

```bash
npm install rclone-openapi
```

## Usage

### Import the OpenAPI Schema

```javascript
// ESM
import schema from 'rclone-openapi';

// CommonJS
const schema = require('rclone-openapi');
```

You can also import the JSON file directly. In Node ESM, this needs the import attribute:

```javascript
import schema from 'rclone-openapi/openapi.json' with { type: 'json' };
```

The YAML version is available at **`rclone-openapi/openapi.yaml`**:

```javascript
const path = require.resolve('rclone-openapi/openapi.yaml');
```

### TypeScript Types

This package includes generated TypeScript types for the Rclone RC API:

```typescript
import type { paths, operations, components } from 'rclone-openapi';

// Example: Type for the /config/listremotes response
type ListRemotesResponse = paths['/config/listremotes']['post']['responses']['200']['content']['application/json'];

// Example: Type for a request body
type CopyFileBody = NonNullable<operations['operationsCopyfile']['requestBody']>['content']['application/json'];

// Example: Calls running in the background return 202 with a job ID
type AsyncJob = components['responses']['AsyncJobResponse']['content']['application/json'];
```

Works great with API clients like [**openapi-fetch**](https://openapi-ts.dev/openapi-fetch/):

```typescript
import createClient from 'openapi-fetch';
import type { paths } from 'rclone-openapi';

const client = createClient<paths>({ baseUrl: 'http://localhost:5572' });

// A call with no required fields
const { data, error } = await client.POST('/config/listremotes');

// Fields go in the JSON body
const { data: status } = await client.POST('/job/status', { body: { jobid: 1 } });

// Run a call in the background, which returns 202 with { jobid }
const { data: job, response } = await client.POST('/sync/copy', {
  body: { srcFs: 'drive:src', dstFs: 'drive:dst' },
  params: { header: { Prefer: 'respond-async' } },
});
```

`data` is typed as either the 200 body or the 202 body, because the header doesn't narrow it. Check `response.status` or `'jobid' in data` before using it.

`openapi-fetch` doesn't reject extra body fields, so a misspelled optional field still compiles.

### What the spec covers

- **`POST` commands with JSON bodies.** Rclone also accepts the same params in the query string or a form-encoded body. The spec leaves those out, so that each field has one documented form and `required` can be enforced.
- **`operations/uploadfile` is the exception.** Its params can only go in the query string, because rclone doesn't read them from a multipart body.
- **`Prefer: respond-async` is how to run a call in the background.** Rclone's `_async` param has the same effect, but on its own it returns a 200 with the job ID rather than the route's normal body. Routes don't list it for that reason. `job/batch` inputs have no headers, so they use `_async`.

## Files

| File | Description |
|------|-------------|
| **`openapi.yaml`** | OpenAPI 3.1 specification. This is the file to edit. |
| **`openapi.json`** | Generated JSON version of the specification |
| **`types.d.ts`** | Generated TypeScript type definitions |
| **`index.mjs`** | Generated ESM entry point |
| **`index.d.mts`**, **`index.d.cts`**, **`document.d.ts`** | Type definitions for the entry points |

## Development

Edit `openapi.yaml`, then regenerate the other files. This also copies the version from `package.json` into the spec:

```bash
npm run gen
```

Check the result. This needs Go for the source audit:

```bash
npm run check           # Runs lint and all of the checks below, except check:package
npm run check:types     # Compiles real openapi-fetch calls against the types
npm run check:contract  # Tests the spec against the rclone release for this version
npm run check:source    # Compares the spec with the source of that rclone release
npm run check:package   # Installs the packed package and tests every import above
```

`check:contract` and `check:source` download rclone into `.work/cache`, which git ignores. Set `OPENAPI_RCLONE_VERSION` to check another version, such as `latest`. Set `OPENAPI_RCLONE_BIN` to test a local rclone binary.

### Releasing

```bash
npm run bump -- 1.75.3  # Use the rclone version
npm run gen
git commit -am "bump to 1.75.3"
npm run pub             # Regenerates, runs every check, then publishes
git tag v1.75.3
```

Always publish with `npm run pub`. Plain `npm publish` skips the checks.

## Related

- [**Rclone SDK**](https://github.com/rclone-ui/rclone-sdk) — Ready-to-use client built on this spec (supports Rust and Javascript/Typescript)
- [**Rclone** RC API Documentation](https://rclone.org/rc/)
- [**Rclone**](https://rclone.org/) — Cloud storage sync tool

## License

MIT

<br />
<br />

<div align="center">
<sub>Made with ☁️ for the <a href="https://discord.gg/rclone">rclone community</a></sub>
</div>