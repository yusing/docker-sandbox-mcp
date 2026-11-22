# docker-sandbox-mcp

A Cloud Run-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server wrapping the official [Docker Sandboxes TypeScript SDK (`@docker/sandboxes`)](https://docs.docker.com/ai/sandboxes-api/), designed so remote AI agents—such as **Gemini Web**—can create isolated cloud microVMs, write files, run builds and tests, and iterate end-to-end before returning verified results.

## Features

- **Stateless Streamable HTTP (`POST /mcp`)** — Scales horizontally and scales to zero on Google Cloud Run (also supports `MCP_TRANSPORT=stdio` for local clients like Gemini CLI).
- **Gemini Web-friendly tool design**:
  - `apply_and_run` batches multiple file writes and a build/test command into a single write tool call to minimize manual write confirmations in Gemini Web.
  - Read-only inspection tools (`list_sandboxes`, `get_sandbox`, `read_file`, `list_files`, `get_process_output`) are annotated with `readOnlyHint: true`.
  - Long-running builds or dev servers can be started with `start_background_process` and polled via `get_process_output` without hitting HTTP timeouts.
- **Built-in auth & health endpoints**: Bearer token protection on `/mcp`, RFC 9728 `/.well-known/oauth-protected-resource` metadata, and `/healthz` for Cloud Run probes.

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

## Deploy to Google Cloud Run

```bash
gcloud run deploy docker-sandbox-mcp \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "PUBLIC_URL=https://YOUR_SERVICE_URL,DOCKER_USERNAME=your-docker-user" \
  --set-secrets "DOCKER_PAT=docker-pat:latest,MCP_BEARER_TOKEN=mcp-bearer-token:latest"
```

> **Note:** Cloud Run `--allow-unauthenticated` lets Gemini Web reach the HTTPS endpoint while `MCP_BEARER_TOKEN` (or your OAuth proxy/IdP) authenticates requests at the application layer.

## Connect to Gemini Web

1. Open [gemini.google.com](https://gemini.google.com) on desktop.
2. Go to **Settings → Connected Apps → Custom apps → Add a custom app**.
3. Enter your deployed HTTPS endpoint URL: `https://<your-cloud-run-service>.run.app/mcp`.
4. Configure OAuth credentials under **Advanced features** if you are fronting the service with an OAuth IdP.
5. Mention `@docker-sandbox-mcp` in chat to have Gemini spin up a sandbox, write and test code, and verify results end-to-end.

## License

MIT
