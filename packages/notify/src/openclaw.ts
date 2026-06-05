/** OpenClaw notifier — pushes the ORACLE batch summary into a local OpenClaw agent.
 *
 *  OpenClaw (https://openclaw.ai) is an open-source, self-hosted personal AI agent that runs
 *  locally and connects LLMs to real software. It ships with a Gateway HTTP API that accepts
 *  messages over a standard REST endpoint, and routes them via any channel the user has
 *  configured (Telegram, Discord, Slack, iMessage, WhatsApp, etc.).
 *
 *  There is already a "Football Value Bets" skill on the ClawHub marketplace — ORACLE's picks
 *  can feed directly into an existing OpenClaw sports workflow.
 *
 *  Required .env keys:
 *    OPENCLAW_GATEWAY_URL  — base URL of the local Gateway, e.g. http://127.0.0.1:18789
 *    OPENCLAW_TOKEN        — Bearer token (set in openclaw gateway config)
 *
 *  Optional .env keys:
 *    OPENCLAW_AGENT_ID     — which agent to message (default: "main")
 *
 *  API used:  POST {gatewayUrl}/v1/responses
 *  Docs:      https://docs.openclaw.ai/gateway/openresponses-http-api
 */
import type { Notifier, BatchSummary } from './types.js';
import { formatSummaryText } from './types.js';

export interface OpenClawConfig {
  gatewayUrl: string;   // e.g. http://127.0.0.1:18789
  token: string;        // Bearer token
  agentId?: string;     // defaults to "main"
}

export class OpenClawNotifier implements Notifier {
  name = 'openclaw';
  private agentId: string;

  constructor(private cfg: OpenClawConfig) {
    this.agentId = cfg.agentId ?? 'main';
  }

  async notify(summary: BatchSummary): Promise<void> {
    const url = `${this.cfg.gatewayUrl.replace(/\/$/, '')}/v1/responses`;
    const body = {
      model: 'openclaw',
      input: formatSummaryText(summary),
      // Stable session key so repeated pushes land in the same conversation thread
      user: 'oracle-batch-notifier',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.token}`,
        'x-openclaw-agent-id': this.agentId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenClaw Gateway failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
  }
}
