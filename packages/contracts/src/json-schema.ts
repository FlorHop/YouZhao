/**
 * 契约包用到的最小 JSON Schema 类型。
 *
 * 故意保持宽松：schema 对象本身以 `as const satisfies JsonSchema` 生成，
 * 类型精度由 `json-schema-to-ts` 的 `FromSchema<typeof schema>` 负责，
 * 这里只做"确实是一个 schema 对象"的形状约束。
 */
export type JsonSchema = boolean | { readonly [keyword: string]: unknown };
