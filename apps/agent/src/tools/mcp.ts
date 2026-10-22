// MCP tools as the model sees them, called with `_meta` request and conversation ids (IMPLEMENTATION_PLAN §5.2, §7.4).
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { META_CONVERSATION_ID, META_REQUEST_ID, parseErrorResult } from '@pantrymos/shared';
import type { ToolSpec } from '../model/types.ts';
import type { ToolOutput } from '../store/toolCalls.ts';

/** Agent-injected inputs (§7.4): removed from the schema the model sees, filled from the turn snapshot. */
export const INJECTED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  next_step: ['expected_step'],
  propose_undo: ['scope_chosen_by_user'],
};

export async function mcpToolSpecs(client: Client): Promise<ToolSpec[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => {
    const { $schema: _schema, ...schema } = tool.inputSchema as Record<string, unknown> & {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const hidden = INJECTED_INPUTS[tool.name] ?? [];
    if (hidden.length > 0) {
      schema.properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !hidden.includes(k)));
      schema.required = (schema.required ?? []).filter((k) => !hidden.includes(k));
    }
    return { name: tool.name, description: tool.description ?? tool.title ?? tool.name, inputSchema: schema };
  });
}

export async function callMcpTool(
  client: Client,
  name: string,
  input: Record<string, unknown>,
  ids: { requestId: string; conversationId: string },
): Promise<ToolOutput> {
  const result = await client.callTool({
    name,
    arguments: input,
    _meta: { [META_REQUEST_ID]: ids.requestId, [META_CONVERSATION_ID]: ids.conversationId },
  });
  const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === 'text')?.text ?? '';
  if (result.isError === true) {
    // §7.1: business errors carry their body as JSON text, not structuredContent.
    return { isError: true, data: { ...(parseErrorResult(result) ?? { code: 'tool_error', message: text }) }, text };
  }
  return { isError: false, data: (result.structuredContent as Record<string, unknown> | undefined) ?? {}, text };
}
