import { describe, expect, it } from 'vitest';
import { fromConverseOutput, toConverseInput } from '../../src/model/bedrock.ts';

describe('Bedrock Converse mapping', () => {
  it('sends the system prompt, messages, tools and a capped, deterministic inference config', () => {
    const input = toConverseInput(
      {
        system: 'be brief',
        messages: [
          { role: 'user', content: [{ text: 'hi' }] },
          { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'list_inventory', input: {} } }] },
          { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'error', content: [{ json: { code: 'x' } }, { text: 'x' }] } }] },
        ],
        tools: [{ name: 'list_inventory', description: 'd', inputSchema: { type: 'object' } }],
      },
      { modelId: 'apac.amazon.nova-pro-v1:0', maxTokens: 512 },
    );
    expect(input).toEqual({
      modelId: 'apac.amazon.nova-pro-v1:0',
      system: [{ text: 'be brief' }],
      messages: [
        { role: 'user', content: [{ text: 'hi' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'list_inventory', input: {} } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'error', content: [{ json: { code: 'x' } }, { text: 'x' }] } }] },
      ],
      inferenceConfig: { maxTokens: 512, temperature: 0 },
      toolConfig: { tools: [{ toolSpec: { name: 'list_inventory', description: 'd', inputSchema: { json: { type: 'object' } } } }] },
    });
    expect(toConverseInput({ system: 's', messages: [], tools: [] }, { modelId: 'm', maxTokens: 64 })).not.toHaveProperty('toolConfig');
  });

  it('reads text and tool uses back, dropping other blocks', () => {
    expect(
      fromConverseOutput({
        stopReason: 'tool_use',
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Let me check.' },
              { reasoningContent: { reasoningText: { text: 'hmm' } } },
              { toolUse: { toolUseId: 't9', name: 'expiring_soon', input: undefined } },
            ],
          },
        },
      }),
    ).toEqual({
      stopReason: 'tool_use',
      content: [{ text: 'Let me check.' }, { toolUse: { toolUseId: 't9', name: 'expiring_soon', input: {} } }],
    });
    expect(fromConverseOutput({ stopReason: undefined, output: undefined } as never)).toEqual({ stopReason: 'end_turn', content: [] });
    expect(fromConverseOutput({ stopReason: 'end_turn', output: undefined, usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 } })).toEqual({
      stopReason: 'end_turn',
      content: [],
      usage: { inputTokens: 900, outputTokens: 40 },
    });
  });

  it("strips Nova's <thinking> text so it is never spoken", () => {
    const reply = (...texts: string[]) =>
      fromConverseOutput({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: texts.map((text) => ({ text })) } } })
        .content;
    // As Nova Pro answered a live Converse call: thinking, then the tool use (here, nothing else).
    expect(reply('<thinking> I need the get_inventory tool to check for eggs. </thinking>\n')).toEqual([]);
    expect(reply('<thinking>a</thinking> You have 6 eggs. <thinking>b\nc</thinking>Anything else?')).toEqual([
      { text: 'You have 6 eggs. Anything else?' },
    ]);
    // Cut off by the token cap: no closing tag.
    expect(reply('Sure. <thinking> the user wants', 'Done.')).toEqual([{ text: 'Sure.' }, { text: 'Done.' }]);
  });
});
