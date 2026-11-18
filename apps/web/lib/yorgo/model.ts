import 'server-only';
import type { Usage } from './config';

// The one place that talks to the model provider. Everything else depends on the ModelClient interface, so tests run without a key.
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type Turn = { role: 'user' | 'assistant'; content: Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type ModelRequest = { model: string; system: string; tools: ToolDef[]; messages: Turn[]; maxTokens: number };
export type ModelResponse = { content: Block[]; stop: 'end' | 'tool_use' | 'max_tokens' | 'other'; usage: Usage };
export interface ModelClient { create(req: ModelRequest): Promise<ModelResponse> }

/** null when no key is configured: the route then answers "not configured" instead of failing. */
export function anthropicClient(): ModelClient | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim().replace(/^["']|["']$/g, '');   // tolerate a pasted space, line break or quotes
  if (!key) return null;
  return {
    async create(req) {
      // The system prompt and the tool list are the same on every call: mark them cacheable so repeats are billed at the cache-read price.
      const tools = req.tools.map((t, i) => (i === req.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model, max_tokens: req.maxTokens,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          ...(tools.length ? { tools } : {}),
          messages: req.messages,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`model_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json() as { content?: Block[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      return {
        content: (j.content ?? []).filter(b => b.type === 'text' || b.type === 'tool_use'),
        stop: j.stop_reason === 'tool_use' ? 'tool_use' : j.stop_reason === 'end_turn' ? 'end' : j.stop_reason === 'max_tokens' ? 'max_tokens' : 'other',
        usage: { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: j.usage?.output_tokens ?? 0, cache_read_tokens: j.usage?.cache_read_input_tokens ?? 0, cache_write_tokens: j.usage?.cache_creation_input_tokens ?? 0 },
      };
    },
  };
}
