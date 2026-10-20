import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.ts';
import { registerExpiringSoon } from './tools/expiringSoon.ts';
import { registerGetSession } from './tools/getSession.ts';
import { registerListInventory } from './tools/listInventory.ts';
import { registerNextStep } from './tools/nextStep.ts';
import { registerProposeIntake } from './tools/proposeIntake.ts';
import { registerStartCooking } from './tools/startCooking.ts';

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
  registerStartCooking(server, ctx);
  registerGetSession(server, ctx);
  registerNextStep(server, ctx);
  return server;
}
