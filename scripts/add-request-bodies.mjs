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

let addedCount = 0
let fixedAdditionalParams = 0

// --- Step 1: Add requestBody schemas to endpoints ---

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

        // AdditionalParam: bare object with no properties — marks body as open-ended
        const isAdditional =
            paramDef.name === 'params' &&
            paramDef.schema?.type === 'object' &&
            !paramDef.schema?.properties &&
            !paramDef.schema?.additionalProperties

        if (isAdditional) {
            openEnded = true
            continue // don't add as a named property
        }

        // Clone schema to avoid shared YAML anchor references
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

    // Insert requestBody right after parameters for clean ordering
    const rebuilt = {}
    for (const [key, val] of Object.entries(op)) {
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

// --- Step 2: Fix AdditionalParam definitions ---

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

// --- Step 3: Fix EmptyObjectResponse ---

const emptySchema =
    doc.components.responses.EmptyObjectResponse?.content?.['application/json']
        ?.schema
if (emptySchema) {
    delete emptySchema.properties
    emptySchema.additionalProperties = true
}

// --- Write ---

writeFileSync('openapi.yaml', stringify(doc, { lineWidth: 0 }))

console.log(`Added requestBody to ${addedCount} endpoints`)
console.log(`Fixed ${fixedAdditionalParams} AdditionalParam definitions`)
console.log('Fixed EmptyObjectResponse')
