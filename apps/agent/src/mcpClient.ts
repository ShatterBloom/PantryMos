import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const CLIENT_INFO = { name: 'pantrymos-agent', version: '0.1.0' } as const;

/** Connects to the PantryMos MCP server with the agent's bearer token (§11.2). */
export async function connectMcp(url: string, token: string): Promise<Client> {
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
