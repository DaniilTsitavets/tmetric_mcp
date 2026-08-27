/**
 * Registration helper shared by every tool module.
 *
 * It wires the API client and identity resolver into handlers and converts any
 * thrown error into a tool-level error result, so individual tools never repeat
 * try/catch boilerplate.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape, ZodTypeAny } from "zod";
import type { TMetricClient } from "../services/client.js";
import type { TMetricContext } from "../services/context.js";
import { errorResult } from "../utils/format.js";

/** Everything a tool handler needs to talk to TMetric. */
export interface ToolDeps {
  client: TMetricClient;
  context: TMetricContext;
}

export interface ToolDefinition<Input extends ZodTypeAny, Output extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  annotations: ToolAnnotations;
  handler: (args: z.infer<Input>, deps: ToolDeps) => Promise<CallToolResult>;
}

/** Registers one tool, wrapping its handler with uniform error handling. */
export function defineTool<Input extends ZodTypeAny, Output extends ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  definition: ToolDefinition<Input, Output>,
): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema as never,
      outputSchema: definition.outputSchema,
      annotations: definition.annotations,
    },
    (async (args: unknown): Promise<CallToolResult> => {
      try {
        return await definition.handler(args as z.infer<Input>, deps);
      } catch (error) {
        return errorResult(error);
      }
    }) as never,
  );
}

/** Annotation preset for tools that only read data. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Annotation preset for tools that create data. */
export const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Annotation preset for tools that overwrite existing data in place. */
export const UPDATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Annotation preset for tools that remove data. */
export const DELETES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
