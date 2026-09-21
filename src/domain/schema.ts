import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { API_CHOICES } from "../pi-catalog";
import { OperationError } from "../operations/errors";
export const object = (properties: Record<string, TSchema>, options = {}) =>
  Type.Object(properties, { additionalProperties: false, ...options });
export const text = (options = {}) => Type.String({ maxLength: 4096, ...options });
export const id = text({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$", title: "供应商 ID" });
export const revision = text({ minLength: 1 });
export const enumOf = (values: readonly string[], options = {}) =>
  Type.Union(
    values.map((v) => Type.Literal(v)),
    options,
  );
export const apiSchema = enumOf(API_CHOICES, { title: "API 类型" });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// Pi includes -1000000 in catalog entries such as OpenRouter automatic routing. Preserve that marker.
const rate = Type.Union([Type.Literal(-1000000), Type.Number({ minimum: 0, maximum: 1e9 })]);
const rates = { input: rate, output: rate, cacheRead: rate, cacheWrite: rate };
export const costSchema = object({
  ...rates,
  tiers: Type.Optional(Type.Array(object({ inputTokensAbove: positive, ...rates }), { maxItems: 100 })),
});
export const thinkingSchema = object(
  Object.fromEntries(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((k) => [
      k,
      Type.Optional(Type.Union([text({ maxLength: 128 }), Type.Null()])),
    ]),
  ),
);
const bools = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "zaiToolStream",
  "supportsOpenAIGrammarTools",
  "supportsStrictMode",
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
  "supportsToolSearch",
  "supportsExplicitPromptCacheMode",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
  "supportsToolReferences",
];
const stringList = Type.Array(text({ maxLength: 256 }), { maxItems: 100 });
const routing = object({
  allow_fallbacks: Type.Optional(Type.Boolean()),
  require_parameters: Type.Optional(Type.Boolean()),
  data_collection: Type.Optional(enumOf(["allow", "deny"])),
  order: Type.Optional(stringList),
  only: Type.Optional(stringList),
  ignore: Type.Optional(stringList),
  sort: Type.Optional(enumOf(["price", "throughput", "latency"])),
  quantizations: Type.Optional(stringList),
});
// Pi treats compat as an extensible object. Validate known fields, but preserve
// provider-specific metadata instead of preventing the entire config from loading.
export const compatSchema = object(
  {
    ...Object.fromEntries(bools.map((k) => [k, Type.Optional(Type.Boolean())])),
    maxTokensField: Type.Optional(enumOf(["max_completion_tokens", "max_tokens"])),
    thinkingFormat: Type.Optional(
      enumOf([
        "openai",
        "openrouter",
        "deepseek",
        "together",
        "zai",
        "qwen",
        "chat-template",
        "qwen-chat-template",
        "string-thinking",
        "ant-ling",
      ]),
    ),
    cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
    deferredToolsMode: Type.Optional(Type.Literal("kimi")),
    sessionAffinityFormat: Type.Optional(enumOf(["openai", "openai-nosession", "openrouter"])),
    chatTemplateKwargs: Type.Optional(
      Type.Record(
        text({ pattern: "^[a-zA-Z0-9_]+$" }),
        Type.Union([
          Type.Boolean(),
          Type.Number(),
          text({ maxLength: 256 }),
          Type.Null(),
          object({ $var: enumOf(["thinking.enabled", "thinking.effort"]) }),
        ]),
        { maxProperties: 50 },
      ),
    ),
    openRouterRouting: Type.Optional(routing),
    vercelGatewayRouting: Type.Optional(object({ only: Type.Optional(stringList), order: Type.Optional(stringList) })),
  },
  { additionalProperties: true },
);
export const modelSchema = object({
  id: text({ minLength: 1, maxLength: 256, title: "模型 ID" }),
  name: Type.Optional(text({ title: "模型名称" })),
  api: Type.Optional(apiSchema),
  baseUrl: Type.Optional(text({ title: "模型 URL" })),
  reasoning: Type.Optional(Type.Boolean({ title: "支持推理" })),
  input: Type.Optional(
    Type.Array(enumOf(["text", "image"]), { minItems: 1, uniqueItems: true, maxItems: 2, title: "输入类型" }),
  ),
  contextWindow: Type.Optional({ ...positive, title: "上下文长度" }),
  maxTokens: Type.Optional({ ...positive, title: "最大输出长度" }),
  cost: Type.Optional({ ...costSchema, title: "价格" }),
  thinkingLevelMap: Type.Optional({ ...thinkingSchema, title: "思考等级映射" }),
  compat: Type.Optional({ ...compatSchema, title: "兼容配置" }),
});
export const authSchema = Type.Union(
  [
    object({ mode: Type.Literal("none") }),
    object({ mode: Type.Literal("api_key") }),
    object({ mode: Type.Literal("oauth"), methodId: text({ minLength: 1, title: "OAuth 提供方" }) }),
  ],
  { title: "认证方式" },
);
export const providerSchema = object({
  id,
  name: Type.Optional(text({ title: "显示名称" })),
  api: apiSchema,
  baseUrl: text({ minLength: 1, title: "Base URL" }),
  auth: authSchema,
  authHeader: Type.Optional(enumOf(["auto", "on", "off"], { title: "Authorization Header" })),
  compat: Type.Optional(compatSchema),
  models: Type.Array(modelSchema, { maxItems: 5000, title: "模型" }),
});
export const patchSchema = object(
  Object.fromEntries(Object.entries(providerSchema.properties).map(([k, v]) => [k, Type.Optional(v)])),
);
export const secret = text({ minLength: 1, maxLength: 262144, writeOnly: true, "x-secret": true });
export const pageSchema = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(text()),
  filter: Type.Optional(text()),
};
export function validate(schema: TSchema, value: unknown) {
  if (!Value.Check(schema, value))
    throw new OperationError(
      "VALIDATION_ERROR",
      "配置字段不符合要求。",
      Value.Errors(schema, value)
        .slice(0, 20)
        .map((e) => ({
          path: String(e.instancePath ?? ""),
          code: "INVALID_FIELD",
          message: "字段类型、值或必填约束错误。",
        })),
    );
}
export function validUrl(value: string) {
  try {
    const u = new URL(value);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
  } catch {
    throw new OperationError("VALIDATION_ERROR", "URL 必须为 http/https，不能包含用户信息、查询参数或片段。", [
      { path: "/baseUrl", code: "INVALID_URL", message: "URL 格式无效。" },
    ]);
  }
}
export function safeKeys(value: unknown, depth = 0): void {
  if (depth > 20) throw new OperationError("VALIDATION_ERROR", "数据嵌套过深。");
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new OperationError("VALIDATION_ERROR", "字段名称无效。");
    safeKeys(v, depth + 1);
  }
}
