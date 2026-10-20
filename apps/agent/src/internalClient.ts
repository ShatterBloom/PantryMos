// Client for the mcp-server internal API (IMPLEMENTATION_PLAN §4.3, §4.4, §11.3): card actions and card reads.

export interface InternalResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ProposalView {
  proposal_id: string;
  kind: 'intake' | 'consume' | 'revise_consumption' | 'adjust' | 'undo';
  status: 'pending' | 'committed' | 'rejected' | 'superseded' | 'stale' | 'expired';
  version: number;
  conversation_id: string;
  card: { title: string; lines: string[]; warnings: string[]; readback_text: string };
  expires_at: string;
}

export class InternalClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;

  constructor(baseUrl: string, serviceToken: string) {
    this.baseUrl = baseUrl;
    this.serviceToken = serviceToken;
  }

  confirm(
    proposalId: string,
    body: { version: number; user_id: string; channel: 'ui_click' | 'voice_rule'; request_id: string; utterance?: string },
  ): Promise<InternalResponse> {
    return this.call('POST', `/internal/proposals/${proposalId}/confirm`, body);
  }

  reject(proposalId: string, body: { version: number; request_id: string }): Promise<InternalResponse> {
    return this.call('POST', `/internal/proposals/${proposalId}/reject`, body);
  }

  edit(proposalId: string, body: { base_version: number; changes: unknown; request_id: string }): Promise<InternalResponse> {
    return this.call('PATCH', `/internal/proposals/${proposalId}`, body);
  }

  regenerate(proposalId: string, body: { request_id: string }): Promise<InternalResponse> {
    return this.call('POST', `/internal/proposals/${proposalId}/regenerate`, body);
  }

  async view(proposalId: string): Promise<ProposalView | null> {
    const res = await this.call('GET', `/internal/proposals/${proposalId}`);
    return res.status === 200 ? (res.body as unknown as ProposalView) : null;
  }

  /** The web view's read models (§8.8), for the agent's household. */
  inventory(householdId: string): Promise<InternalResponse> {
    return this.call('GET', '/internal/views/inventory', undefined, { 'x-household-id': householdId });
  }

  ledger(householdId: string, limit: number): Promise<InternalResponse> {
    return this.call('GET', `/internal/views/ledger?limit=${limit}`, undefined, { 'x-household-id': householdId });
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<InternalResponse> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        'x-service-token': this.serviceToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }
}
