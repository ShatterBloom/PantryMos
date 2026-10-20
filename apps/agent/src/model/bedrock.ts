// Amazon Nova through the Bedrock Converse API (IMPLEMENTATION_PLAN §1.2, §8.2).
import {
  BedrockRuntimeClient,
  type ContentBlock as BedrockBlock,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Tool,
  type ToolResultContentBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from './types.ts';

/** The SDK's JSON document type. */
type DocumentType = NonNullable<ToolUseBlock['input']>;

export interface BedrockOptions {
  region: string;
  modelId: string;
  maxTokens: number;
}

/** What the turn loop sends, in the SDK's shape. Exported for tests. */
export function toConverseInput(request: ModelRequest, options: Pick<BedrockOptions, 'modelId' | 'maxTokens'>): ConverseCommandInput {
  const tools: Tool[] = request.tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as DocumentType } },
  }));
  return {
    modelId: options.modelId,
    system: [{ text: request.system }],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content.map(toBedrockBlock) })),
    inferenceConfig: { maxTokens: options.maxTokens, temperature: 0 },
    ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
  };
}

function toBedrockBlock(block: ContentBlock): BedrockBlock {
  if ('text' in block) return { text: block.text };
  if ('toolUse' in block) {
    const { toolUseId, name, input } = block.toolUse;
    return { toolUse: { toolUseId, name, input: input as DocumentType } };
  }
  const { toolUseId, status, content } = block.toolResult;
  return {
    toolResult: {
      toolUseId,
      status,
      content: content.map((c): ToolResultContentBlock => ('json' in c ? { json: c.json as DocumentType } : { text: c.text })),
    },
  };
}

/**
 * Nova writes its chain of thought into the text as `<thinking>…</thinking>`; left in, it would be
 * spoken. A block cut off by the token cap has no closing tag, so it runs to the end of the text.
 */
const THINKING = /<thinking>[\s\S]*?(?:<\/thinking>|$)/g;

/** The model's reply in the turn loop's shape; blocks it does not use (reasoning, images) are dropped. */
export function fromConverseOutput(output: Pick<ConverseCommandOutput, 'stopReason' | 'output'>): ModelResponse {
  const content: ContentBlock[] = [];
  for (const block of output.output?.message?.content ?? []) {
    if (block.text !== undefined) {
      const text = block.text.replace(THINKING, '').trim();
      if (text !== '') content.push({ text });
    }
    else if (block.toolUse) {
      content.push({ toolUse: { toolUseId: block.toolUse.toolUseId!, name: block.toolUse.name!, input: block.toolUse.input ?? {} } });
    }
  }
  return { stopReason: output.stopReason ?? 'end_turn', content };
}

export class BedrockModel implements ModelClient {
  private readonly client: BedrockRuntimeClient;
  private readonly options: BedrockOptions;

  constructor(options: BedrockOptions) {
    this.options = options;
    this.client = new BedrockRuntimeClient({ region: options.region });
  }

  async converse(request: ModelRequest): Promise<ModelResponse> {
    return fromConverseOutput(await this.client.send(new ConverseCommand(toConverseInput(request, this.options))));
  }
}
