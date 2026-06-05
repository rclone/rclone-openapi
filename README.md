# Rclone OpenAPI

[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rclone)
[![npm version](https://img.shields.io/npm/v/rclone-openapi?color=cb0000&logo=npm)](https://www.npmjs.com/package/rclone-openapi)
[![npm downloads](https://img.shields.io/npm/dm/rclone-openapi?color=cb0000&logo=npm)](https://www.npmjs.com/package/rclone-openapi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

OpenAPI 3.1 specification for the [**Rclone RC API**](https://rclone.org/rc/).

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

Or import directly:

```javascript
import schema from 'rclone-openapi/openapi.json';
```

The YAML version is also available at **`openapi.yaml`**.

### TypeScript Types

This package includes auto-generated TypeScript types for the Rclone RC API:

```typescript
import type { paths, operations, components } from 'rclone-openapi';

// Example: Type for the /config/listremotes response
type ListRemotesResponse = paths['/config/listremotes']['post']['responses']['200']['content']['application/json'];

// Example: Type for operations
type CopyFileParams = operations['operationsCopyfile']['parameters']['query'];
```

Works great with API clients like [**openapi-fetch**](https://openapi-ts.dev/openapi-fetch/):

```typescript
import createClient from 'openapi-fetch';
import type { paths } from 'rclone-openapi';

const client = createClient<paths>({ baseUrl: 'http://localhost:5572' });

const { data, error } = await client.POST('/config/listremotes');
```

## Files

| File | Description |
|------|-------------|
| **`openapi.json`** | OpenAPI 3.1 specification (JSON) |
| **`openapi.yaml`** | OpenAPI 3.1 specification (YAML) |
| **`types.d.ts`** | TypeScript type definitions |

## Development

Generate the JSON schema and TypeScript types from the YAML source:

```bash
npm run gen        # Generate both JSON and types
npm run gen:json   # Generate JSON only
npm run gen:types  # Generate TypeScript types only
```

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