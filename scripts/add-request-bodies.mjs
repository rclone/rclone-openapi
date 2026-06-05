import { readFileSync, writeFileSync } from 'node:fs'
import { parse, stringify } from 'yaml'

const SKIP_PATHS = new Set(['/job/batch', '/operations/uploadfile'])

const raw = readFileSync('openapi.yaml', 'utf-8')
const doc = parse(raw)

function resolveRef(ref) {
    return ref.replace('#/', '').split('/').reduce((o, k) => o[k], doc)
}

function ucfirst(s) {
    return s[0].toUpperCase() + s.slice(1)
}

// --- Step 1: Simplify deepObject param schemas (options/set blocks) ---
// Replace strict oneOf additionalProperties with plain `true` so body types
// accept Record<string, unknown> from consumers.

let simplifiedDeepObjects = 0
for (const param of Object.values(doc.components.parameters)) {
    if (
        param.style === 'deepObject' &&
        param.schema?.type === 'object' &&
        typeof param.schema?.additionalProperties === 'object'
    ) {
        param.schema.additionalProperties = true
        simplifiedDeepObjects++
    }
}

// --- Step 2: Generate requestBody schemas for each endpoint ---
// Body schemas mirror the query params. The `required` list on the body
// preserves which fields are mandatory, while query params are made
// optional (step 3) so callers can use body OR query.

let addedCount = 0
for (const [path, item] of Object.entries(doc.paths)) {
    if (SKIP_PATHS.has(path)) continue
    const op = item.post
    if (!op?.parameters) continue

    const props = {}
    const required = []
    let openEnded = op['x-additionalQueryBlocksAllowed'] === true

    for (const paramRef of op.parameters) {
        if (!paramRef.$ref) continue
        const paramDef = resolveRef(paramRef.$ref)

        // Only query params belong in the request body
        if (paramDef.in && paramDef.in !== 'query') continue

        // AdditionalParam: object with no named properties — marks body as open-ended
        const isAdditional =
            paramDef.name === 'params' &&
            paramDef.schema?.type === 'object' &&
            !paramDef.schema?.properties

        if (isAdditional) {
            openEnded = true
            continue
        }

        // Clone schema to avoid shared references
        const propSchema = JSON.parse(JSON.stringify(paramDef.schema))
        if (paramDef.description) propSchema.description = paramDef.description
        props[paramDef.name] = propSchema

        if (paramDef.required === true) required.push(paramDef.name)
    }

    const schemaName = ucfirst(op.operationId) + 'Request'
    const schema = { type: 'object', properties: props }
    if (required.length) schema.required = required
    if (openEnded) schema.additionalProperties = true

    doc.components.schemas[schemaName] = schema

    // Insert requestBody after parameters, skipping any stale requestBody from prior run
    const rebuilt = {}
    for (const [key, val] of Object.entries(op)) {
        if (key === 'requestBody') continue
        rebuilt[key] = val
        if (key === 'parameters') {
            rebuilt.requestBody = {
                content: {
                    'application/json': {
                        schema: { $ref: `#/components/schemas/${schemaName}` },
                    },
                },
            }
        }
    }
    item.post = rebuilt
    addedCount++
}

// --- Step 3: Make all query params optional ---
// rclone accepts params in body OR query, so query params should never
// be required — the body schema enforces required fields instead.

let madeOptional = 0
for (const param of Object.values(doc.components.parameters)) {
    if (param.in === 'query' && param.required === true) {
        delete param.required
        madeOptional++
    }
}

// --- Step 4: Fix AdditionalParam definitions ---

let fixedAdditionalParams = 0
for (const [name, param] of Object.entries(doc.components.parameters)) {
    if (
        name.endsWith('AdditionalParam') &&
        param.schema?.type === 'object' &&
        !param.schema?.additionalProperties
    ) {
        param.schema.additionalProperties = true
        fixedAdditionalParams++
    }
}

// --- Write ---

writeFileSync('openapi.yaml', stringify(doc, { lineWidth: 0 }))

console.log(`Added requestBody to ${addedCount} endpoints`)
console.log(`Made ${madeOptional} query params optional`)
console.log(`Simplified ${simplifiedDeepObjects} deepObject schemas`)
console.log(`Fixed ${fixedAdditionalParams} AdditionalParam definitions`)
