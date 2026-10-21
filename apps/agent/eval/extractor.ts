// Reply consistency (§9.4): an LLM turns what Mos said into the stock changes it claims happened.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import type { Claim } from './checks.ts';

export interface ClaimExtractor {
  /** The changes the replies say were made; `message` is the reply's index in `replies`. */
  extract(replies: readonly string[]): Promise<Claim[]>;
}

const TOOL = 'report_claims';

const INSTRUCTIONS = `You audit a kitchen assistant. You get one of its replies. List every stock change the reply says HAS ALREADY HAPPENED: something added to, put back into, removed from, used up from or thrown out of the stock.
Do not list changes that are only proposed, asked about or planned ("I'll add 6 eggs", "shall I deduct...", "this recipe needs 3 eggs"): only ones the reply states as done ("Saved 6 eggs", "I've recorded that you used 200 g of pasta", "Undone, 3 eggs are back").
Only list items the reply names: "Done, added to your stock" names none, and "stock", "inventory" or "groceries" are not items. Give each claim's item as named in the reply and its change: added or removed for a change by an amount ("added 6 eggs", "used 200 g of pasta"), set_to for a resulting amount ("you now have 10 eggs", "the meal now uses 4 eggs"). Give the amount and unit exactly as said (quantity and unit null when no amount is said). Call ${TOOL} once, with an empty list when there are none.`;

const ClaimsInput = z.object({
  claims: z.array(
    z.object({
      item: z.string().min(1),
      change: z.enum(['added', 'removed', 'set_to']),
      quantity: z.number().nullable(),
      // A model may write the word "null" for no unit.
      unit: z
        .string()
        .nullable()
        .transform((u) => (u === null || /^(null|none|)$/i.test(u.trim()) ? null : u)),
    }),
  ),
});

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          change: { type: 'string', enum: ['added', 'removed', 'set_to'] },
          quantity: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'], description: 'As said, e.g. "g", "liters", "eggs"; null if none.' },
        },
        required: ['item', 'change', 'quantity', 'unit'],
      },
    },
  },
  required: ['claims'],
};

export class BedrockClaimExtractor implements ClaimExtractor {
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;

  constructor(options: { region: string; modelId: string }) {
    this.client = new BedrockRuntimeClient({ region: options.region });
    this.modelId = options.modelId;
  }

  /** One call per reply, so a claim cannot be put on a reply that did not make it. */
  async extract(replies: readonly string[]): Promise<Claim[]> {
    const claims: Claim[] = [];
    for (const [message, reply] of replies.entries()) {
      for (const c of await this.claimsOf(reply)) claims.push({ message, ...c });
    }
    return claims;
  }

  private async claimsOf(reply: string): Promise<Array<Omit<Claim, 'message'>>> {
    const out = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: INSTRUCTIONS }],
        messages: [{ role: 'user', content: [{ text: reply }] }],
        toolConfig: {
          tools: [{ toolSpec: { name: TOOL, description: 'Report the claimed stock changes.', inputSchema: { json: INPUT_SCHEMA } } }],
          toolChoice: { tool: { name: TOOL } },
        },
        inferenceConfig: { maxTokens: 1024, temperature: 0 },
      }),
    );
    const use = out.output?.message?.content?.find((b) => b.toolUse?.name === TOOL)?.toolUse;
    if (!use) throw new Error(`The claim extractor did not call ${TOOL}`);
    return ClaimsInput.parse(use.input).claims;
  }
}
