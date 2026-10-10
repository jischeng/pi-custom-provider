import type { TSchema } from "typebox";

export type Caller = "user_client" | "model_tool";
export type Effects = {
  config: "unchanged" | "committed";
  credentials: "unchanged" | "updated";
  runtime: "unchanged" | "synced" | "failed";
};
export type Failure = {
  code: string;
  message: string;
  retryable: boolean;
  fields?: { path: string; code: string; message: string }[];
};
export type Result = {
  status: "succeeded" | "failed" | "cancelled" | "requires_user_action";
  data?: any;
  error?: Failure;
  warnings: { code: string; message: string }[];
  effects: Effects;
};
export type Interaction = {
  kind: string;
  message: string;
  options?: { id: string; label: string; description?: string }[];
  placeholder?: string;
  secret?: boolean;
  url?: string;
  userCode?: string;
  verificationUri?: string;
};
export interface OperationContext {
  caller: Caller;
  signal: AbortSignal;
  effects: Effects;
  warnings: Result["warnings"];
  progress(stage: string): void;
  prompt(request: Interaction, signal?: AbortSignal): Promise<string>;
  notify(request: Interaction): void;
}
export interface OperationDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  /** JSON Schema of the successful result.data. */
  resultSchema: TSchema;
  effects: ("read" | "network" | "config_write" | "credential_write")[];
  allowedCallers: Caller[];
  execute(args: any, context: OperationContext): Promise<any>;
}
export type OperationDescriptor = Omit<OperationDefinition, "execute">;
