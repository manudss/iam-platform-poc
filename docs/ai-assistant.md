# AI assistant (plugin `ai-assistant`)

A chat in the console (Extensions > AI assistant) with a model that can use the platform tools. It is built on the Vercel AI SDK and the **existing MCP server**: it is not a new kind of access.

## What the SDK provides, and what is ours

| Part | Provided by | Notes |
| --- | --- | --- |
| Model calls, streaming, the tool loop, step limit | `ai` (AI SDK 7), `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/google` | Apache-2.0 |
| Tools | `@ai-sdk/mcp` client on the existing endpoint `POST /tenants/:tenant/mcp` | the same tools, Cedar checks, branch confinement and activity trace as an external MCP client |
| Chat client in the browser | the SDK chat classes (`AbstractChat`, `DefaultChatTransport`) bundled into the plugin screen | NOT the `@ai-sdk/angular` package: a plugin screen is one self-contained `.mjs` loaded from a blob URL, so the SDK UI code is bundled in (`scripts/ai-assistant-ui`) |
| Ours | model registry (keys sealed at rest), the network guard, one MCP session per conversation, server-side history, caps, the screen. No approval or rights layer of our own | |

## Rights

No new rights layer, no extra confirmation step. The chat routes use the same guard as the MCP administration screens: the screen right `mcp` (the `ai` screen maps to it) on an enabled plugin. A conversation is an ordinary MCP session of the signed-in administrator (own branch cut from main, 8 hours). What a tool may do is decided by the existing MCP gateway: Cedar per call, branch confinement, the tools' own validations (for example `confirmDestructive` and `confirm`, which are tool parameters of the MCP contract) and the activity trace. A refusal comes back as the tool result and the chat shows it as is. No platform tool can merge or apply: a human publishes. Effects of relayed external MCP tools (named `server__tool`, configured in the MCP upstreams) happen on those external servers under the MCP grants: the branch does not isolate them.

## Models

- Local: set `IAM_AI_LOCAL_URL` (OpenAI-compatible, e.g. Ollama `http://ollama:11434/v1`) and `IAM_AI_LOCAL_MODEL`. `docker compose --profile ollama up` starts Ollama. Use a model that supports tool calls (the CI proof uses `qwen2.5:3b`).
- External (added by an administrator): OpenAI-compatible endpoints (OpenAI, Mistral, LiteLLM, OpenRouter, Azure, agent gateways), Anthropic, Google Gemini (kind `google`). The API key is sealed at rest and never returned. An external model receives the data the tools return: the screen asks for an explicit acknowledgement.

## Environment

| Variable | Meaning |
| --- | --- |
| `IAM_AI_KEY_SECRET` | required, 16+ characters: seals model keys and the conversations' MCP tokens. POC grade: use a secret manager in production |
| `IAM_AI_LOCAL_URL`, `IAM_AI_LOCAL_MODEL`, `IAM_AI_LOCAL_MAX_TOKENS` | the built-in local model |
| `IAM_AI_LOCAL_ENDPOINTS` | operator list of `host:port` allowed over plain http (default `localhost:11434,127.0.0.1:11434,ollama:11434`) |
| `IAM_AI_ALLOWED_HOSTS` | optional allowlist of remote model hosts |
| `IAM_API_INTERNAL_URL` | where the API reaches its own MCP endpoint (default `http://127.0.0.1:$API_PORT`); never taken from a request header |

## Safety

- Platform configuration changes go to the assistant's own branch and publishing stays human. Relayed external tools are the exception: their effects are outside the branch and follow the MCP rights and grants.
- Tool output is data: cut, fenced as untrusted, and it cannot add tools, skip approval or raise a limit. The confinement does not depend on the model obeying a prompt.
- The client sends only its last message; history lives on the server. Only a text user message is accepted; an assistant or tool message sent by a client is refused.
- Model endpoints: https only for remote hosts, every DNS answer must be public, and the connection is pinned to the checked address (TLS still validates the host name), redirects refused. This reduces SSRF, it does not replace egress filtering: restrict outbound traffic and set `IAM_AI_ALLOWED_HOSTS`.
- Limits: 8 steps per turn, 80 tool calls and 400 messages per conversation, one turn at a time (the lock is held until the stream ended and the turn was stored).

## Tests

Unit (providers against fake endpoints, chat turn against a real MCP server with a scripted model, DNS and pinning), end to end (real Dolt and core, scripted model: read, write on the branch only, MCP refusal, unlisted tool, forged history, one turn at a time, privacy, revocation), screen (headless Chrome), and an Ollama workflow that runs a real small model (`.github/workflows/ai-local-model.yml`).

## Option studied, not enabled: GitHub Copilot SDK

The GitHub Copilot SDK (public preview, v0.3.x) can serve models, but only with **per-user GitHub OAuth**: each user authorises an OAuth App and requests run on that user's own Copilot subscription ([GitHub OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth), [authentication methods](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)). It is not a shared API key. Server-to-server mode with organisation billing exists but requires organisation policy. BYOK is the reverse (your key used inside Copilot). Fit: possible later as a third provider type with a per-session token, but it needs the Node SDK (preview, API still moving), an OAuth App, user sign-in with GitHub and a decision on whose licence and policy apply. Nothing is connected and no enterprise licence is used by this PR.
