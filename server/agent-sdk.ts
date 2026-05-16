import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type ToolResultMessage, type TSchema } from "@earendil-works/pi-ai";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { resolveModelRef } from "./model-config.js";

type JsonRecord = Record<string, unknown>;

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: JsonRecord };
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: Array<{ type: "text"; text: string }>;
  is_error?: boolean;
};

export type SDKMessage =
  | { type: "assistant"; message: { content: Array<TextBlock | ToolUseBlock> } }
  | { type: "user"; message: { content: ToolResultBlock[] } }
  | {
      type: "result";
      total_cost_usd: number;
      modelUsage: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
        }
      >;
    };

type ToolHandlerResponse =
  | string
  | number
  | boolean
  | null
  | undefined
  | {
      content?: Array<{ type: string; text?: string }>;
      [key: string]: unknown;
    };

interface WrappedTool {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  handler: (args: JsonRecord) => Promise<ToolHandlerResponse> | ToolHandlerResponse;
}

export interface McpSdkServerConfigWithInstance {
  name: string;
  version: string;
  tools: Array<WrappedTool | JsonRecord>;
}

interface QueryOptions {
  systemPrompt?: string;
  model?: string;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  permissionMode?: string;
  settingSources?: string[];
}

interface QueryParams {
  prompt: string;
  options?: QueryOptions;
}

function toToolJsonSchema(schema: z.ZodObject<ZodRawShape> | ZodTypeAny): JsonRecord {
  const json = zodToJsonSchema(schema) as JsonRecord;
  delete json.$schema;
  return json;
}

export function tool<T extends ZodRawShape>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.output<z.ZodObject<T>>) => Promise<ToolHandlerResponse> | ToolHandlerResponse,
): WrappedTool {
  const zodSchema = z.object(schema);
  return {
    name,
    description,
    inputSchema: toToolJsonSchema(zodSchema),
    handler: async (args) => handler(zodSchema.parse(args)),
  };
}

export function createSdkMcpServer(config: McpSdkServerConfigWithInstance): McpSdkServerConfigWithInstance {
  return config;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isAllowed(name: string, allow: string[] | undefined, deny: string[] | undefined): boolean {
  if (allow && allow.length > 0) {
    const ok = allow.some((p) => patternToRegex(p).test(name));
    if (!ok) return false;
  }
  if (deny && deny.length > 0) {
    const blocked = deny.some((p) => patternToRegex(p).test(name));
    if (blocked) return false;
  }
  return true;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function extractToolName(raw: unknown): string | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  if (typeof obj.name === "string" && obj.name.trim()) return obj.name.trim();
  const fn = asRecord(obj.function);
  if (fn && typeof fn.name === "string" && fn.name.trim()) return fn.name.trim();
  return null;
}

function extractToolDescription(raw: unknown): string {
  const obj = asRecord(raw);
  if (!obj) return "Tool";
  if (typeof obj.description === "string" && obj.description.trim()) return obj.description.trim();
  const fn = asRecord(obj.function);
  if (fn && typeof fn.description === "string" && fn.description.trim()) return fn.description.trim();
  return "Tool";
}

function extractToolSchema(raw: unknown): TSchema {
  const fallback = Type.Object({}, { additionalProperties: true });
  const obj = asRecord(raw);
  if (!obj) return fallback;
  const candidates: unknown[] = [
    obj.inputSchema,
    obj.input_schema,
    obj.parameters,
    asRecord(obj.function)?.parameters,
  ];
  for (const candidate of candidates) {
    const rec = asRecord(candidate);
    if (rec) {
      const copy = { ...rec };
      delete copy.$schema;
      return copy as unknown as TSchema;
    }
  }
  return fallback;
}

function normalizeToolText(output: ToolHandlerResponse): Array<{ type: "text"; text: string }> {
  if (output === undefined) return [{ type: "text", text: "" }];
  if (output === null) return [{ type: "text", text: "null" }];
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (typeof output === "number" || typeof output === "boolean") {
    return [{ type: "text", text: String(output) }];
  }
  if (output && Array.isArray(output.content)) {
    const blocks = output.content
      .filter((c) => c && typeof c === "object" && c.type === "text")
      .map((c) => ({ type: "text" as const, text: typeof c.text === "string" ? c.text : "" }));
    if (blocks.length > 0) return blocks;
  }
  return [{ type: "text", text: JSON.stringify(output) }];
}

async function callToolHandler(raw: unknown, args: JsonRecord): Promise<ToolHandlerResponse> {
  const obj = asRecord(raw);
  if (!obj) throw new Error("Invalid tool");

  if (typeof obj.handler === "function") {
    return (obj.handler as (a: JsonRecord) => Promise<ToolHandlerResponse>)(args);
  }
  if (typeof obj.execute === "function") {
    return (obj.execute as (a: JsonRecord) => Promise<ToolHandlerResponse>)(args);
  }
  if (typeof obj.call === "function") {
    return (obj.call as (a: JsonRecord) => Promise<ToolHandlerResponse>)(args);
  }
  if (typeof obj.run === "function") {
    return (obj.run as (a: JsonRecord) => Promise<ToolHandlerResponse>)(args);
  }
  throw new Error("Tool has no callable handler");
}

function extractVisibleText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function gatherRelatedTopics(items: unknown[], acc: Array<{ title: string; url: string }>): void {
  for (const item of items) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (typeof rec.Text === "string" && typeof rec.FirstURL === "string") {
      acc.push({ title: rec.Text, url: rec.FirstURL });
      continue;
    }
    if (Array.isArray(rec.Topics)) {
      gatherRelatedTopics(rec.Topics, acc);
    }
  }
}

async function skillFileByName(name: string): Promise<string | null> {
  const root = process.cwd();
  const direct = [
    resolve(root, ".claude", "skills", name, "SKILL.md"),
    resolve(root, ".agents", "skills", name, "SKILL.md"),
  ];
  for (const path of direct) {
    try {
      await fs.access(path);
      return path;
    } catch {
      // ignore
    }
  }

  const dirs = [resolve(root, ".claude", "skills"), resolve(root, ".agents", "skills")];
  const lower = name.toLowerCase();
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.toLowerCase() !== lower) continue;
        const path = join(dir, entry.name, "SKILL.md");
        try {
          await fs.access(path);
          return path;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

async function listAvailableSkillNames(): Promise<string[]> {
  const root = process.cwd();
  const dirs = [resolve(root, ".claude", "skills"), resolve(root, ".agents", "skills")];
  const out = new Set<string>();
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        out.add(entry.name);
      }
    } catch {
      // ignore
    }
  }
  return [...out].sort();
}

function builtInTools(allow: string[] | undefined, deny: string[] | undefined): AgentTool[] {
  const tools: AgentTool[] = [];
  if (!allow || allow.length === 0) return tools;

  if (isAllowed("WebSearch", allow, deny)) {
    tools.push({
      name: "WebSearch",
      label: "WebSearch",
      description: "Search the web and return relevant result links with snippets.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
      }),
      execute: async (_id, params) => {
        const p = asRecord(params) ?? {};
        const query = String(p.query ?? "").trim();
        const limit = typeof p.limit === "number" ? Math.max(1, Math.min(10, p.limit)) : 5;
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
          query,
        )}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`WebSearch failed (${res.status})`);
        const data = (await res.json()) as JsonRecord;
        const results: Array<{ title: string; url: string }> = [];
        if (typeof data.AbstractText === "string" && typeof data.AbstractURL === "string" && data.AbstractURL) {
          results.push({ title: data.AbstractText, url: data.AbstractURL });
        }
        if (Array.isArray(data.RelatedTopics)) gatherRelatedTopics(data.RelatedTopics, results);
        const unique: Array<{ title: string; url: string }> = [];
        const seen = new Set<string>();
        for (const r of results) {
          if (!r.url || seen.has(r.url)) continue;
          seen.add(r.url);
          unique.push(r);
          if (unique.length >= limit) break;
        }
        const text =
          unique.length === 0
            ? `No results found for "${query}".`
            : unique.map((r, i) => `${i + 1}. ${r.title}\n${r.url}`).join("\n\n");
        return { content: [{ type: "text", text }], details: { query, count: unique.length } };
      },
    });
  }

  if (isAllowed("WebFetch", allow, deny)) {
    tools.push({
      name: "WebFetch",
      label: "WebFetch",
      description: "Fetch a URL and return extracted readable text content.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        max_chars: Type.Optional(Type.Number({ minimum: 500, maximum: 50000 })),
      }),
      execute: async (_id, params, signal) => {
        const p = asRecord(params) ?? {};
        const url = String(p.url ?? "").trim();
        const maxChars =
          typeof p.max_chars === "number" ? Math.max(500, Math.min(50000, p.max_chars)) : 12000;
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`WebFetch failed (${res.status})`);
        const body = await res.text();
        const contentType = res.headers.get("content-type") ?? "";
        const text = contentType.includes("html") ? extractVisibleText(body) : body.replace(/\s+/g, " ").trim();
        return {
          content: [{ type: "text", text: text.slice(0, maxChars) }],
          details: { url, status: res.status, contentType },
        };
      },
    });
  }

  if (isAllowed("Skill", allow, deny)) {
    tools.push({
      name: "Skill",
      label: "Skill",
      description:
        "Load a project skill's SKILL.md instructions by name (from .claude/skills or .agents/skills).",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, description: "Skill directory name, e.g. upgrade-boop." }),
      }),
      execute: async (_id, params) => {
        const p = asRecord(params) ?? {};
        const name = String(p.name ?? "").trim();
        const file = await skillFileByName(name);
        if (!file) {
          const available = await listAvailableSkillNames();
          const hint = available.length
            ? `Available: ${available.slice(0, 30).join(", ")}`
            : "No project skills found.";
          return { content: [{ type: "text", text: `Skill "${name}" not found. ${hint}` }], details: { name } };
        }
        const body = await fs.readFile(file, "utf8");
        return {
          content: [{ type: "text", text: body }],
          details: { name, file },
        };
      },
    });
  }

  return tools;
}

function mcpToolsFromOptions(options: QueryOptions | undefined): AgentTool[] {
  const out: AgentTool[] = [];
  const servers = options?.mcpServers ?? {};
  const allow = options?.allowedTools;
  const deny = options?.disallowedTools;

  for (const [serverName, server] of Object.entries(servers)) {
    for (const raw of server.tools) {
      const baseName = extractToolName(raw);
      if (!baseName) continue;
      const fullName = `mcp__${serverName}__${baseName}`;
      if (!isAllowed(fullName, allow, deny)) continue;

      out.push({
        name: fullName,
        label: fullName,
        description: extractToolDescription(raw),
        parameters: extractToolSchema(raw),
        execute: async (_toolCallId, params) => {
          const args = asRecord(params) ?? {};
          const rawResult = await callToolHandler(raw, args);
          const content = normalizeToolText(rawResult);
          return { content, details: rawResult };
        },
      });
    }
  }

  return out;
}

function assistantBlocks(msg: AssistantMessage): Array<TextBlock | ToolUseBlock> {
  const blocks: Array<TextBlock | ToolUseBlock> = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
      });
    }
  }
  return blocks;
}

function toolResultBlocks(msg: ToolResultMessage): ToolResultBlock[] {
  const content = msg.content
    .filter((c) => c.type === "text")
    .map((c) => ({ type: "text" as const, text: c.text }));
  return [
    {
      type: "tool_result",
      tool_use_id: msg.toolCallId,
      content,
      ...(msg.isError ? { is_error: true } : {}),
    },
  ];
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return asRecord(message)?.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return asRecord(message)?.role === "toolResult";
}

export async function* query(params: QueryParams): AsyncGenerator<SDKMessage> {
  const options = params.options ?? {};
  const { model } = resolveModelRef(options.model);
  const mcpTools = mcpToolsFromOptions(options);
  const builtIns = builtInTools(options.allowedTools, options.disallowedTools);
  const tools = [...mcpTools, ...builtIns];

  const out: SDKMessage[] = [];
  let assistantError: string | null = null;
  const modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  > = {};
  let totalCostUsd = 0;
  let sawAssistantMessageEndThisTurn = false;
  let sawToolResultMessageEndThisTurn = false;

  function recordUsage(msg: AssistantMessage): void {
    const key = msg.responseModel ?? msg.model;
    const slot =
      modelUsage[key] ??
      (modelUsage[key] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
    slot.inputTokens += msg.usage.input;
    slot.outputTokens += msg.usage.output;
    slot.cacheReadInputTokens += msg.usage.cacheRead;
    slot.cacheCreationInputTokens += msg.usage.cacheWrite;
    totalCostUsd += msg.usage.cost.total;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? "",
      model,
      tools,
    },
    toolExecution: "sequential",
  });

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "turn_start") {
      sawAssistantMessageEndThisTurn = false;
      sawToolResultMessageEndThisTurn = false;
      return;
    }
    if (event.type === "message_end") {
      const msg = event.message;
      if (isAssistantMessage(msg)) {
        sawAssistantMessageEndThisTurn = true;
        out.push({ type: "assistant", message: { content: assistantBlocks(msg) } });
        recordUsage(msg);
        return;
      }
      if (isToolResultMessage(msg)) {
        sawToolResultMessageEndThisTurn = true;
        out.push({ type: "user", message: { content: toolResultBlocks(msg) } });
      }
      return;
    }
    if (event.type === "turn_end") {
      const maybeAssistant = asRecord(event.message);
      if (
        maybeAssistant?.role === "assistant" &&
        typeof maybeAssistant.errorMessage === "string" &&
        maybeAssistant.errorMessage.trim()
      ) {
        assistantError = maybeAssistant.errorMessage.trim();
      }
      // Some provider/runtime paths surface final assistant content and/or
      // tool results only on turn_end (without prior message_end events).
      // Preserve those so callers don't get silent zero-log completions.
      if (isAssistantMessage(event.message) && !sawAssistantMessageEndThisTurn) {
        out.push({ type: "assistant", message: { content: assistantBlocks(event.message) } });
        recordUsage(event.message);
      }
      if (event.toolResults.length > 0 && !sawToolResultMessageEndThisTurn) {
        for (const toolResult of event.toolResults) {
          out.push({ type: "user", message: { content: toolResultBlocks(toolResult) } });
        }
      }
    }
  });

  const abort = options.abortController;
  const onAbort = () => agent.abort();
  abort?.signal.addEventListener("abort", onAbort);
  try {
    await agent.prompt(params.prompt);
  } finally {
    abort?.signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  const hasAssistantText = out.some(
    (msg) =>
      msg.type === "assistant" &&
      msg.message.content.some((block) => block.type === "text" && block.text.trim().length > 0),
  );
  if (!hasAssistantText && assistantError) {
    throw new Error(assistantError);
  }

  for (const msg of out) yield msg;
  yield { type: "result", total_cost_usd: totalCostUsd, modelUsage };
}
