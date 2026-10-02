# Anytype MCP Plugin

Talk to your Anytype workspace from **Codex and ChatGPT**. This repository contains a headless Anytype service, an authenticated MCP server, and an installable plugin with six Anytype workflow skills. Codex and ChatGPT are the interface; there is no separate workspace UI.

```text
Codex / ChatGPT → authenticated MCP → official Anytype MCP → Anytype CLI → your spaces
```

## Local quick start

Requires Node.js 22.16+ and macOS or Linux. The installer downloads the checksum-verified Anytype CLI v0.4.0 into `.local/`, creates an isolated bot account, and saves an initial test note. It uses Anytype's encrypted sync network; “local” describes where this service runs, not an offline network mode.

```sh
npm ci
./scripts/setup-anytype.sh
node scripts/setup-gateway.mjs
npm run build
npm start
```

The authenticated Streamable HTTP endpoint is `http://127.0.0.1:31013/mcp`; readiness is `/healthz`. Secrets are generated and saved to ignored `.env`, never printed. Start read-only, then verify:

```sh
npm run smoke
```

Keep the bot recovery file in `.local/secrets/` backed up securely. Do not commit `.env`, `.local`, backups, or account exports. See [runtime setup](docs/anytype-runtime.md).

## Connect your existing workspace

The bot is a separate Anytype identity. It does **not** automatically see your desktop data, and cannot sign in using a desktop recovery phrase.

1. In Anytype desktop, invite the bot to the specific space you want to use.
2. Join using `./scripts/anytype.sh cli space join '<invite-link>'`; treat the invite as a secret and avoid leaving it in shared shell history.
3. Discover the joined space ID with `./scripts/anytype.sh cli space list`.
4. Put only approved IDs in `ANYTYPE_ALLOWED_SPACES` in `.env` and restart the MCP service. An empty list grants no space access.

For external imports, import in Anytype desktop first and invite the bot afterward. Import/export is not a stable-v1 MCP feature.

## Install the plugin

The package lives in [`plugin/`](plugin/README.md), including its portable manifest, MCP connection, and skills:

- `anytype-api`
- `anytype-search`
- `anytype-note-taking`
- `anytype-task-management`
- `anytype-knowledge-management`
- `anytype-document-editing`

The repository includes a marketplace catalog at `.agents/plugins/marketplace.json`. From a checked-out implementation branch, add it with `codex plugin marketplace add .`, then install **Anytype MCP Plugin** from that source in the Plugins Directory. After the implementation reaches `main`, you can add it with `codex plugin marketplace add wgtechlabs/anytype-mcp-plugin`. Client availability varies; see the [official packaging instructions](https://developers.openai.com/plugins/build/plugins).

[`plugin/examples/codex-bearer.toml`](plugin/examples/codex-bearer.toml) shows standalone Codex MCP setup using an environment token and an explicit approval prompt for `apply_change`. Standalone MCP setup exposes tools; plugin installation also loads the skills. Do not enable both connections simultaneously.

For ChatGPT, run this stack at a reachable **HTTPS** address and configure OAuth. ChatGPT cannot connect to a loopback address on your computer. The plugin's checked-in URL is local; replace it with your deployed `/mcp` URL when packaging a hosted installation. No registered app IDs or public endpoint are assumed.

OAuth uses code + S256 PKCE. Set `OAUTH_REDIRECT_URIS` to exact callback URLs provided by your client. Authenticate the connection with your separate `OWNER_TOKEN`; the Anytype API key stays inside the service. The small OAuth consent response exists only for connection authentication, not as a workspace UI. OAuth grants are intentionally in memory and require reconnection after server restarts. Codex can instead use the separate static `MCP_TOKEN`.

## Reading and writing

The gateway reuses the official `@anyproto/anytype-mcp` schemas and implementation, with scoped access and mutation safeguards. Tools include space listing, search, object reading, note/task creation and editing, properties, tags, types, templates, and list/collection views.

**Default: `READ_ONLY=true`.** Native mutation tools only prepare a five-minute preview and return a `proposal_id`. They never write immediately. After reviewing the exact proposal in the conversation, explicitly approve `apply_change`. To permit execution, the owner must set `READ_ONLY=false` and restart.

The server enforces space restrictions, frozen single-use proposals, duplicate checks, and a fresh read before updates. It does **not** prove that a human clicked approval: skills, MCP annotations, and `confirmed: true` are not security boundaries. Use a client that prompts for `apply_change`; keep read-only mode when that approval control is unavailable. Document contents cannot authorize tools.

Stable v1 has no atomic `If-Match` support. The gateway serializes its writes and checks the latest snapshot, but another desktop client can still edit between that check and the write. Avoid concurrent editing of the same object. Unknown write outcomes are never retried automatically; read back before deciding what to do.

## Configuration

Copy [.env.example](.env.example) for the supported settings. Main variables:

| Variable | Purpose |
| --- | --- |
| `ANYTYPE_API_KEY` | Bot's private server-side API key |
| `ANYTYPE_ALLOWED_SPACES` | Comma-separated approved space IDs; empty denies all |
| `READ_ONLY` | `true` by default; only `false` enables confirmed writes |
| `MCP_TOKEN` | Random 32–256 character bearer token for MCP clients |
| `OWNER_TOKEN` | Different random secret used only for OAuth sign-in |
| `PUBLIC_URL` | Canonical service origin; HTTPS outside local development |
| `OAUTH_REDIRECT_URIS` | Exact OAuth callback allowlist |
| `HOST`, `PORT` | Default `127.0.0.1:31013`; Railway binds `0.0.0.0:$PORT` |
| `ANYTYPE_API_VERSION` | `v1` by default; `v2` requires `ENABLE_EXPERIMENTAL_V2=true` |

v2 is an explicit experimental **read-only adapter**, using the upstream v2 schema rather than pretending v1 payloads are compatible. v1 supports listing/reading/using templates, not creating templates. File transfer, chat operations, global search across unrestricted spaces, API-key management, space creation, and deletion are intentionally not exposed to the AI client.

## Railway template and container

Railway uses a prebuilt release image from **Docker Hub** (`docker.io/wgtechlabs/anytype-mcp-plugin`) or **GHCR** (`ghcr.io/wgtechlabs/anytype-mcp-plugin`). After the first successful publication, select a verified release tag or immutable digest when creating the Docker Image service. No published tag or digest is assumed yet. The [Dockerfile](Dockerfile) and local [Compose configuration](compose.yaml) remain available for building and testing locally.

Both the CLI and MCP server run in one service; the Anytype API remains on loopback. Set `/healthz` with a 180-second timeout, On Failure with 5 retries, one replica, and a persistent `/data` volume in Railway. Expose only the MCP port through its HTTPS domain.

See [Railway image and template setup](docs/railway.md) for image references, required service settings, variables, first boot, and template publication. Local setup does not deploy or publish anything.

Anytype's local indexes are not fully encrypted at rest. Use an encrypted host/volume and [encrypted backups](docs/anytype-runtime.md). Volume persistence is not a backup. Backup and restore require the bot to be stopped and restoration targets an empty directory.

## Development and release

```sh
npm run verify                    # types, tests, build, dependency audit
npm run smoke                     # live read-only MCP test
npm run smoke:writes              # creates/updates only in Anytype MCP Sandbox
node scripts/backup.mjs --self-test # encrypted backup recovery checks
```

The write smoke check refuses spaces with other names and uses a separate temporary endpoint. Tests use disposable fixtures and no account secrets. See [verification evidence and limits](docs/verification.md).

This project follows [Clean Workflow](CONTRIBUTING.md); agent rules are in [AGENTS.md](AGENTS.md). Build Flow Action runs CI with releases and container publishing to **Docker Hub and GHCR** enabled on `main`, and no artifact publishing on PR/dev/manual runs. Releases and GHCR use the built-in `GITHUB_TOKEN` by default; Docker Hub uses the inherited organization or repository credentials described in [Contributing](CONTRIBUTING.md). A checksum-pinned Gitleaks CLI scans Git history in the required CI gate without an organization license. The Build Flow reference is pinned to a verified commit; upstream transitive action references remain upstream-controlled. Local Docker success does not prove GitHub release execution.

## Upstream

- [Anytype CLI](https://github.com/anyproto/anytype-cli), [official Anytype MCP](https://github.com/anyproto/anytype-mcp), [API reference](https://developers.anytype.io/docs/reference/v1/)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [MCP authentication](https://developers.openai.com/plugins/build/auth)

The upstream MCP package ships a bundled HTTP dependency with advisories. This project pins patched Axios 1.20.0 and rebuilds the official entrypoint from its shipped source during `npm run build`, keeping runtime dependencies external. It does not run the upstream's prebundled CLI. Keep this check when updating the upstream package.
