# AI assistant (plugin `ai-assistant`)

An admin chat that drives the IAM through the same MCP tool surface as external agents (see [mcp.md](mcp.md), [mcp-gateway.md](mcp-gateway.md)). The assistant never gets more power than an MCP session: it works on its own branch `ai/mcp-...`, every tool call goes through Cedar, and a human reviews and merges. The plugin is **off by default**: enable it in Plugins (it asks for the UI grant for its screen).

## Models

- **Local model** (built in, id `local`, never stored): any OpenAI-compatible server on a local host. Default target is Ollama. Start it with `docker compose -f infra/docker-compose.yml --profile ai up -d ollama`, pull a model that supports tool calls (for example `ollama pull qwen2.5:7b`), then set `IAM_AI_LOCAL_URL=http://localhost:11434/v1` and `IAM_AI_LOCAL_MODEL=qwen2.5:7b` for the API.
- **External models**, added by the admin in the screen: OpenAI-compatible (OpenAI, Mistral, Gemini through its OpenAI endpoint, any gateway) or Anthropic. Agentic use needs a model with tool calls. The screen has presets and tells where to get a key.
- Remote models need an `https` URL on a public host and an explicit "data sharing" acknowledgement: conversation content and tool results leave the platform. API keys are sealed (AES-GCM) with `IAM_AI_KEY_SECRET` and never returned by the API.

| Variable | Purpose |
| --- | --- |
| `IAM_AI_LOCAL_URL`, `IAM_AI_LOCAL_MODEL` | built-in local model |
| `IAM_AI_LOCAL_HOSTS` | hosts allowed over plain http (default `localhost,127.0.0.1,::1,ollama`) |
| `IAM_AI_ALLOWED_HOSTS` | optional allowlist for remote hosts |
| `IAM_AI_KEY_SECRET` | key sealing secret, 16+ characters, **required** to store an external key (no default value; without it the API refuses the key) |
| `IAM_AI_LOCAL_MAX_TOKENS` | output cap for the local model |

## Safety model

1. Confinement: the conversation owns one MCP session (branch `ai/mcp-...`, 8h). Nothing reaches the base branch without a human merge.
2. Allowlist of tools, and **confirmation for every non-read tool** (write, lifecycle, proxy). The admin approves or declines each pending call in the chat. Auto-approve covers only plain writes on the branch.
3. Tool results are untrusted data: wrapped, truncated, never executed as instructions.
4. Limits: 8 steps and 12 tool calls per turn; one running turn per conversation; conversations are owner-scoped; admin only.
5. Redirects refused, timeouts, errors redacted (keys never echoed).

Tests, all in CI: `apps/api/src/ai/ai-assistant.spec.ts` (URL rules, providers on fake HTTP, agent loop, injection, limits), `ai.e2e.spec.ts` (real Dolt and core: confirmation, branch confinement, poisoned tool output), `ai-screen.spec.ts` (headless Chrome, light/dark, desktop/mobile via `scripts/ai-assistant-screen-check.mjs`). The injection test exists before the plugin can be enabled.

## Limits

No streaming. Sessions last 8h. Remote hosts are resolved before each call and refused if any answer is private, loopback, link-local or mapped; the connection itself is not pinned to the checked address, so a DNS answer changing between the check and the connect is a residual risk (use `IAM_AI_ALLOWED_HOSTS` and an egress rule in production). The per-turn limits reset with each user message, so a conversation is also capped (80 tool calls, 400 messages). Key sealing is POC grade (AES-GCM with one shared secret, no rotation). The MCP spec version is not upgraded here.

## Option studied, not enabled: GitHub Copilot SDK

The GitHub Copilot SDK (public preview, v0.3.x) can serve models, but only with **per-user GitHub OAuth**: each user authorises an OAuth App and requests run on that user's own Copilot subscription ([GitHub OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth), [authentication methods](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)). It is not a shared API key. Server-to-server mode with organisation billing exists but requires organisation policy. BYOK is the reverse (your key used inside Copilot). Fit: possible later as a third provider type with a per-session token, but it needs the Node SDK (preview, API still moving), an OAuth App, user sign-in with GitHub and a decision on whose licence and policy apply. Nothing is connected and no enterprise licence is used by this PR.
