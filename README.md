# docker-sandbox-mcp

A Cloud Run- and VPS-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
server wrapping the official [Docker Sandboxes TypeScript SDK (`@docker/sandboxes`)](https://docs.docker.com/ai/sandboxes-api/),
built with [FastMCP](https://github.com/punkpeye/fastmcp) and a Google OAuth 2.1
proxy so remote AI clients such as **Gemini Web** can create isolated cloud
microVMs, write files, run builds and tests, and iterate end-to-end.

## Features

- **Stateless Streamable HTTP (`POST /mcp`)** via FastMCP (plus `MCP_TRANSPORT=stdio`
  for local CLI clients).
- **Gemini Web-friendly tool design**:
  - `apply_and_run` batches file writes and a build/test command into one write
    tool call to minimize manual write confirmations.
  - Read-only tools (`list_sandboxes`, `get_sandbox`, `read_file`, `list_files`,
    `get_process_output`) are annotated with `readOnlyHint: true`.
  - Long-running builds or dev servers run asynchronously via
    `start_background_process` and `get_process_output`.
- **FastMCP Google OAuth 2.1 Proxy**:
  - Serves RFC 9728 Protected Resource Metadata
    (`/.well-known/oauth-protected-resource/mcp`), RFC 8414 Authorization Server
    Metadata (`/.well-known/oauth-authorization-server`), Dynamic Client
    Registration (`/oauth/register`), CIMD, PKCE S256, consent (`/oauth/consent`),
    and token exchange/refresh (`/oauth/token`).
  - Bridges MCP clients to Google OAuth using a single Web Client and callback
    URL (`https://<your-domain>/oauth/callback`).
  - Enforces a verified-email allowlist (`ALLOWED_EMAILS`) and persists encrypted
    DCR clients and token mappings in `FASTMCP_STATE_DIR` (`/var/lib/fastmcp`).
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

## Google OAuth Setup

1. In Google Cloud Console -> **APIs & Services -> Credentials**, create or open
   a **Web application** OAuth 2.0 Client ID.
2. Add the authorized redirect URI:
   ```text
   https://<your-domain>/oauth/callback
   ```
3. Configure the OAuth consent screen with scopes `openid` and `email` (add your
   Google account as a test user if the app is in Testing mode).
4. Set the environment variables in `.env`:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `PUBLIC_URL` | Yes (OAuth) | Public HTTPS origin (e.g. `https://docker-sbx-mcp.yourdomain.com`) |
| `GOOGLE_OAUTH_CLIENT_ID` | Yes (OAuth) | Google OAuth 2.0 Web Client ID (also reads `OAUTH_AUDIENCE`) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Yes (OAuth) | Google OAuth 2.0 Web Client Secret |
| `ALLOWED_EMAILS` | Recommended | Comma-separated verified Google emails (also reads `OAUTH_ALLOWED_EMAILS`) |
| `ALLOWED_CLIENT_REDIRECT_URIS` | Optional | Override DCR redirect URI patterns (defaults to Gemini + localhost) |
| `FASTMCP_JWT_SIGNING_KEY` | Optional | Explicit signing/encryption seed (defaults to deriving from client secret) |
| `FASTMCP_STATE_DIR` | Optional | Directory for encrypted DiskStore state (set to `/var/lib/fastmcp` in Docker) |
| `MCP_BEARER_TOKEN` | Optional | Static Bearer token fallback for local scripts or smoke tests |

## Deploy with Docker Compose

If using Cloudflare Tunnel, forward **all paths** on your hostname to
`http://docker-sandbox-mcp:8080` so `/.well-known/*`, `/oauth/*`, and `/mcp`
reach FastMCP directly, with browser challenges disabled.

```sh
cp .env.example .env
# Edit .env with DOCKER_USERNAME, DOCKER_PAT, PUBLIC_URL,
# GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and ALLOWED_EMAILS

TUNNEL_TOKEN="$(cat .cf-api-token)" docker compose up -d --build
```

`compose.yml` mounts the `fastmcp_state` volume at `/var/lib/fastmcp` so
registered OAuth clients and tokens survive container restarts.

## Connect to Gemini Web

1. Open [gemini.google.com](https://gemini.google.com) on desktop.
2. Go to **Settings -> Connected Apps -> Custom apps -> Add a custom app**.
3. Enter your deployed HTTPS endpoint URL: `https://<your-domain>/mcp`.
4. Gemini discovers the FastMCP OAuth proxy automatically from
   `/.well-known/oauth-protected-resource/mcp` and registers via DCR.
5. Sign in with a Google account listed in `ALLOWED_EMAILS`.

## Local Development

Requires **Node.js 26 LTS** (or newer) and a Docker account with an active
[Docker Agentic Platform](https://docs.docker.com/ai/sandboxes-api/)
subscription.

```sh
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run dev
```

## License

MIT
