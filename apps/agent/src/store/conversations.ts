// Conversations and their persisted model messages (IMPLEMENTATION_PLAN §2.2, §8.2).
import type { Queryable } from '../db.ts';
import type { ContentBlock, Message } from '../model/types.ts';

/**
 * Creates the conversation on first use. An existing one must belong to the same household and
 * user; otherwise the caller may not use it.
 */
export async function ensureConversation(q: Queryable, id: string, householdId: string, userId: string): Promise<boolean> {
  const { rows } = await q.query<{ household_id: string; user_id: string }>(
    `WITH inserted AS (
       INSERT INTO agent.conversations (id, household_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING RETURNING household_id, user_id)
     SELECT household_id, user_id FROM inserted
     UNION ALL
     SELECT household_id, user_id FROM agent.conversations WHERE id = $1`,
    [id, householdId, userId],
  );
  return rows[0]!.household_id === householdId && rows[0]!.user_id === userId;
}

export async function conversationExists(q: Queryable, id: string, householdId: string): Promise<boolean> {
  const { rowCount } = await q.query(`SELECT 1 FROM agent.conversations WHERE id = $1 AND household_id = $2`, [id, householdId]);
  return rowCount === 1;
}

export async function loadMessages(q: Queryable, conversationId: string): Promise<Message[]> {
  const { rows } = await q.query<Message>(
    `SELECT role, content FROM agent.conversation_messages WHERE conversation_id = $1 ORDER BY seq`,
    [conversationId],
  );
  return rows;
}

export async function appendMessage(q: Queryable, conversationId: string, role: Message['role'], content: ContentBlock[]): Promise<void> {
  await q.query(
    `INSERT INTO agent.conversation_messages (conversation_id, seq, role, content)
     SELECT $1, COALESCE(max(seq), 0) + 1, $2, $3 FROM agent.conversation_messages WHERE conversation_id = $1`,
    [conversationId, role, JSON.stringify(content)],
  );
}
