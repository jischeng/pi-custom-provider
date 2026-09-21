import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi: ExtensionAPI) {
  const model: any = {
    id: "fixture",
    name: "Fixture",
    provider: "fixture-agent",
    api: "fixture-api",
    baseUrl: "http://127.0.0.1",
    input: ["text"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream = (_model: any, context: any) => {
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const last = context.messages.at(-1);
      const call =
        last.role === "user"
          ? JSON.parse(typeof last.content === "string" ? last.content : last.content[0].text)
          : undefined;
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: call ? "toolUse" : "stop",
        content: call
          ? [{ type: "toolCall", id: `call-${Date.now()}`, name: call.name, arguments: call.arguments }]
          : [{ type: "text", text: "Done" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      events.push({ type: "done", reason: message.stopReason, message });
      events.end();
    });
    return events;
  };
  pi.registerProvider({
    id: "fixture-agent",
    name: "Fixture",
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Fixture",
        check: async () => ({ type: "api_key" }),
        resolve: async () => ({ auth: { apiKey: "fixture-only" } }),
      },
    },
    stream,
    streamSimple: stream,
  });
}
