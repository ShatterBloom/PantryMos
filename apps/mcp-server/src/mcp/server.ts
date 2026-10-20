import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.ts';
import { registerCancelCooking } from './tools/cancelCooking.ts';
import { registerExpiringSoon } from './tools/expiringSoon.ts';
import { registerGetSession } from './tools/getSession.ts';
import { registerListInventory } from './tools/listInventory.ts';
import { registerListRecentOperations } from './tools/listRecentOperations.ts';
import { registerNextStep } from './tools/nextStep.ts';
import { registerProposeConsumption } from './tools/proposeConsumption.ts';
import { registerProposeIntake } from './tools/proposeIntake.ts';
import { registerSkipIngredient } from './tools/skipIngredient.ts';
import { registerStartCooking } from './tools/startCooking.ts';
import { registerSubstitute } from './tools/substitute.ts';
import { registerSuggestRecipes } from './tools/suggestRecipes.ts';

export const SERVER_INFO = { name: 'pantrymos', version: '0.1.0' } as const;

/** A fresh MCP server per request (stateless Streamable HTTP), bound to the caller's household. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'PantryMos keeps batch-level kitchen inventory. Tools never change inventory directly; ' +
      'propose_* tools create cards the user must confirm in the app.',
  });
  registerListInventory(server, ctx);
  registerExpiringSoon(server, ctx);
  registerProposeIntake(server, ctx);
  registerSuggestRecipes(server, ctx);
  registerStartCooking(server, ctx);
  registerGetSession(server, ctx);
  registerNextStep(server, ctx);
  registerSubstitute(server, ctx);
  registerSkipIngredient(server, ctx);
  registerCancelCooking(server, ctx);
  registerProposeConsumption(server, ctx);
  registerListRecentOperations(server, ctx);
  return server;
}
