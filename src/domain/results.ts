import { Type } from "typebox";
import { object, text, enumOf, providerSchema, modelSchema, modelOverrideSchema, authSchema } from "./schema";

const auth = object({
  mode: enumOf(["none", "api_key", "oauth"]),
  methodId: Type.Optional(text()),
  status: enumOf(["configured", "missing", "expired", "unknown"]),
  hasCredential: Type.Boolean(),
});
const provider = object({
  ...providerSchema.properties,
  /** Whether Pi ships this provider or the user configured it, and which models were adjusted. */
  source: enumOf(["configured", "builtin"]),
  overriddenModelIds: Type.Array(text()),
  /** The raw patches for a built-in provider; Pi applies them on top of the models above. */
  modelOverrides: Type.Optional(Type.Record(text(), modelOverrideSchema)),
  auth,
  revision: text(),
  headers: Type.Array(object({ name: text(), hasValue: Type.Boolean() })),
  modelHeaders: Type.Array(object({ modelId: text(), names: Type.Array(text()) })),
  runtimeStatus: enumOf(["ready", "failed"]),
  modelCount: Type.Integer({ minimum: 0 }),
});
const candidate = object({
  model: modelSchema,
  source: enumOf(["api", "catalog", "manual"]),
  availability: enumOf(["listed", "suggested", "unknown"]),
});
const page = (item: any, extra = {}) =>
  object({ items: Type.Array(item), total: Type.Integer({ minimum: 0 }), nextCursor: Type.Optional(text()), ...extra });
const draft = object({
  draftId: text(),
  revision: Type.Integer(),
  baseConfigRevision: text(),
  originalProviderId: Type.Optional(text()),
  values: providerSchema,
  schema: Type.Unknown({ description: "JSON Schema describing editable provider fields" }),
  candidates: Type.Array(candidate),
  selectedModelIds: Type.Array(text()),
  dirty: Type.Boolean(),
  errors: Type.Array(Type.Unknown()),
  availableActions: Type.Array(
    object({ operation: text(), arguments: object({ draftId: text(), revision: Type.Integer() }) }),
  ),
});
const schemas: Record<string, any> = {
  "provider.list": page(provider, { revision: text() }),
  "provider.get": provider,
  "model.override": provider,
  "provider.create": provider,
  "provider.update": provider,
  "provider.selectModels": provider,
  "provider.delete": object({ deleted: text(), credentialsRetained: Type.Boolean() }),
  "runtime.sync": object({ ready: Type.Boolean() }),
  "catalog.list": object({
    apis: Type.Array(object({ id: text(), label: text() })),
    providers: Type.Array(
      object({
        id: text(),
        name: text(),
        baseUrl: Type.Optional(text()),
        apis: Type.Array(text()),
        auth: Type.Array(enumOf(["api_key", "oauth"])),
      }),
    ),
    authMethods: Type.Array(object({ id: text(), label: text(), value: authSchema })),
  }),
  "catalog.presets": page(object({ id: text(), label: text(), model: modelSchema })),
  "draft.validate": object({ valid: Type.Boolean(), errors: Type.Array(Type.Unknown()), values: providerSchema }),
  "draft.commit": provider,
  "draft.discard": object({ discarded: Type.Boolean() }),
  "model.discover": Type.Union([draft, page(candidate)]),
  "model.recommend": candidate,
  "auth.file": object({ configured: Type.Boolean() }),
  "headers.set": object({ configured: Type.Boolean() }),
};
for (const name of [
  "create",
  "open",
  "get",
  "patch",
  "selectModels",
  "upsertModel",
  "removeModel",
  "applyPreset",
  "login",
])
  schemas[`draft.${name}`] = draft;
for (const name of ["status", "configure", "import", "begin", "clear"]) schemas[`auth.${name}`] = auth;
/** Describes the successful result.data, not the common task envelope. */
export function dataSchema(name: string) {
  const schema = schemas[name];
  if (!schema) throw new Error(`Missing output contract: ${name}`);
  return schema;
}
