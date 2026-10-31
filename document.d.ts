// The type of the default export. It is written by hand, so consumers don't need resolveJsonModule.
export interface OpenApiDocument {
    openapi: string
    info: { title: string; version: string; description?: string; [key: string]: unknown }
    paths: Record<string, unknown>
    components: Record<string, unknown>
    [key: string]: unknown
}
