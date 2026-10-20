// The model interface the turn loop needs: the Bedrock Converse shape (IMPLEMENTATION_PLAN §8.2).

export interface ToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolUseId: string;
  content: Array<{ json: unknown } | { text: string }>;
  status: 'success' | 'error';
}

export type ContentBlock = { text: string } | { toolUse: ToolUse } | { toolResult: ToolResult };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export interface ModelResponse {
  /** 'tool_use' when the model wants tools run; anything else ends the loop. */
  stopReason: string;
  content: ContentBlock[];
}

export interface ModelClient {
  converse(request: ModelRequest): Promise<ModelResponse>;
}

export const isText = (b: ContentBlock): b is { text: string } => 'text' in b;
export const isToolUse = (b: ContentBlock): b is { toolUse: ToolUse } => 'toolUse' in b;
export const isToolResult = (b: ContentBlock): b is { toolResult: ToolResult } => 'toolResult' in b;
