# docker-sandbox-mcp

A Cloud Run-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server wrapping the official [Docker Sandboxes TypeScript SDK (`@docker/sandboxes`)](https://docs.docker.com/ai/sandboxes-api/), designed so remote AI agents—such as **Gemini Web**—can create isolated cloud microVMs, write files, run builds and tests, and iterate end-to-end before returning verified results.

## Features

- **Stateless Streamable HTTP (`POST /mcp`)** — Scales horizontally and scales to zero on Google Cloud Run (also supports `MCP_TRANSPORT=stdio` for local clients like Gemini CLI).
- **Gemini Web-friendly tool design**:
  - `apply_and_run` batches multiple file writes and a build/test command into a single write tool call to minimize manual write confirmations in Gemini Web.
  - Read-only inspection tools (`list_sandboxes`, `get_sandbox`, `read_file`, `list_files`, `get_process_output`) are annotated with `readOnlyHint: true`.
  - Long-running builds or dev servers can be started with `start_background_process` and polled via `get_process_output` without hitting HTTP timeouts.
- **Native OAuth 2.0 / OIDC JWT verification (JWKS)**:
  - Automatically discovers `jwks_uri` from `${OAUTH_ISSUER}/.well-known/openid-configuration` (or uses `OAUTH_JWKS_URI`) and verifies JWT signatures, `iss`, `aud`, `exp`, and `nbf` via [`jose`](https://github.com/panva/jose).
  - Supports `OAUTH_ALLOWED_EMAILS`, `OAUTH_ALLOWED_SUBS`, and `OAUTH_REQUIRED_SCOPES` so only your authorized identity can spin up sandboxes.
  - Serves RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) and returns `WWW-Authenticate` challenges on `401`/`403`.
  - Optional static `MCP_BEARER_TOKEN` fallback for local testing or CI probes.

## MCP Tools

| Tool | Read-only | Purpose |
| :--- | :---: | :--- |
| `list_sandboxes` | Yes | List all Docker Cloud Sandboxes in the account |
| `get_sandbox` | Yes | Inspect a sandbox's status and metadata |
| `create_sandbox` | No | Launch a cloud sandbox from a kit (default: `shell`) and wait until running |
| `apply_and_run` | No | Write one or more files and execute a command in a single step |
| `run_command` | No | Run a command inside a sandbox and return exit code, stdout, and stderr |
| `start_background_process` | No | Start an async/long-running process and return its handle |
| `get_process_output` | Yes | Poll status and buffered output of a background process |
| `read_file` | Yes | Read a UTF-8 file from a sandbox |
| `list_files` | Yes | List files and directories inside a sandbox |
| `stop_sandbox` | No | Stop a running sandbox to pause compute billing |
| `start_sandbox` | No | Start or resume a stopped sandbox |
| `delete_sandbox` | No (destructive) | Permanently delete a sandbox |

## Local Development

Requires **Node.js 26 LTS** (or newer) and a Docker account with an active [Docker Agentic Platform](https://docs.docker.com/ai/sandboxes-api/) subscription.

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run dev
```

## OAuth 2.0 / OIDC Configuration

Set these environment variables when deploying for Gemini Web:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `PUBLIC_URL` | Recommended | Public HTTPS origin of this server (e.g. `https://mcp.example.com`) |
| `OAUTH_ISSUER` | Yes (OAuth) | OIDC issuer URL (e.g. Auth0, Keycloak, Okta, Clerk, or Google) |
| `OAUTH_AUDIENCE` | Recommended | Expected JWT `aud` claim (e.g. `https://mcp.example.com/mcp`) |
| `OAUTH_JWKS_URI` | Optional | Explicit JWKS endpoint if your IdP does not serve OIDC discovery |
| `OAUTH_ALLOWED_EMAILS` | Recommended | Comma-separated allowlist of authorized `email` claims |
| `OAUTH_ALLOWED_SUBS` | Optional | Comma-separated allowlist of authorized `sub` claims |
| `OAUTH_REQUIRED_SCOPES` | Optional | Comma-separated scopes required in the JWT `scope`/`scp` claim |
| `MCP_BEARER_TOKEN` | Optional | Static Bearer token fallback for local scripts or smoke tests |

## Deploy to Google Cloud Run

```bash
gcloud run deploy docker-sandbox-mcp \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "PUBLIC_URL=https://YOUR_SERVICE_URL,DOCKER_USERNAME=your-docker-user,OAUTH_ISSUER=https://your-idp.example.com,OAUTH_AUDIENCE=https://YOUR_SERVICE_URL/mcp,OAUTH_ALLOWED_EMAILS=you@example.com" \
  --set-secrets "DOCKER_PAT=docker-pat:latest"
```

## Connect to Gemini Web

1. Open [gemini.google.com](https://gemini.google.com) on desktop.
2. Go to **Settings → Connected Apps → Custom apps → Add a custom app**.
3. Enter your deployed HTTPS endpoint URL: `https://<your-domain-or-cloud-run-url>/mcp`.
4. Gemini discovers your IdP from `/.well-known/oauth-protected-resource`; if your IdP does not support Dynamic Client Registration (DCR), click **Show more** under **Advanced features** and enter your OAuth client ID and client secret.
5. Mention `@docker-sandbox-mcp` in chat to have Gemini spin up a sandbox, write and test code, and verify results end-to-end.

## License

MIT
