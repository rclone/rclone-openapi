import type { OpenApiDocument } from './document.js'
import type * as Types from './types.js'

declare const schema: OpenApiDocument
declare namespace schema {
    export type paths = Types.paths
    export type operations = Types.operations
    export type components = Types.components
    export type webhooks = Types.webhooks
    export type $defs = Types.$defs
}
export = schema
