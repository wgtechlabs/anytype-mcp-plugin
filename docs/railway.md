# Railway template preparation

The repository includes a Dockerfile, `railway.json`, and local Compose configuration. Nothing has been deployed or published as a Railway template. Codex and ChatGPT provide the interface; the container hosts the MCP gateway and headless Anytype.

## Container architecture

One container runs one pinned Anytype CLI v0.4.0 bot and one Node 22 gateway. Anytype listens only on container loopback at 31012; only the gateway port is exposed. `/data` contains the private CLI home, object data, recovery material, API key, and gateway configuration. The first start creates a dedicated sandbox and test note. Later starts reuse the volume. Startup verifies tokens before creating an account, and no secret is printed to container logs. The entrypoint initializes volume ownership as root, then runs both services as the unprivileged `node` user. Shutdown stops both processes.

The official CLI does not offer a local-only network flag. Its bot uses encrypted Anytype Network sync unless a valid custom network YAML is supplied at first account creation. This is separate from the hosting location.

## Local container check

With Docker running and distinct `MCP_TOKEN`/`OWNER_TOKEN` values in the root `.env`:

```sh
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:31014/healthz
docker compose stop
```

Compose maps only `127.0.0.1:31014` to the container gateway. Its separate named volume and bot do not reuse native `.local` data. Loopback HTTP is permitted for local development; production requires HTTPS. Do not run `docker compose down -v` unless intentionally deleting this test identity and data.

Compose explicitly sets `ALLOW_INSECURE_HTTP=true` because the process binds inside the container while Docker restricts the published port to host loopback. Never set this exception on Railway or another public deployment.

## Railway service and template settings

Create the service from the published source repository when a deployment is authorized. Railway reads `railway.json` and uses the Dockerfile. Add a persistent volume mounted at **`/data`** before first start. Keep exactly one replica; do not share the database volume across processes or hosts. `railway.json` does not provision volumes or publish a template: those are dashboard/template settings.

Configure:

| Variable | Value |
| --- | --- |
| `MCP_TOKEN` | A unique random secret, at least 32 characters |
| `OWNER_TOKEN` | A different unique random secret, at least 32 characters |
| `PUBLIC_URL` | The external HTTPS origin, or omit when `RAILWAY_PUBLIC_DOMAIN` is configured |
| `READ_ONLY` | `true` initially |
| `PORT` | Railway-provided port or `31013` |
| `ANYTYPE_ALLOWED_SPACES` | Optional explicit full IDs; without it, bootstrap restricts access to its dedicated sandbox |
| `ANYTYPE_API_VERSION` | `v1` by default |
| `OAUTH_REDIRECT_URIS` | Exact client callback URLs when configuring OAuth clients |

The entrypoint sets `HOST=0.0.0.0` for gateway reachability and derives `PUBLIC_URL=https://RAILWAY_PUBLIC_DOMAIN` when no URL is supplied. Generate a Railway HTTPS domain targeting the gateway's port. Do not create TCP proxies or public domains for Anytype ports. Railway terminates HTTPS at its edge; the application remains inside the container. The public MCP URL is `https://<domain>/mcp`.

Keep the upstream `ANYTYPE_API_KEY` out of Railway template prompts and client configuration: bootstrap stores it privately in `/data/gateway.env`. Separate operator and MCP secrets stay in Railway Variables. In the template editor, generate the two secrets independently, add the `/data` volume, enable public networking, and retain the one-replica constraint. Do not add a Deploy button until an actual template has been published and its URL verified.

## Storage, upgrades, and recovery

Anytype object encryption does not cover local indexes or the CLI's file-based credential fallback. Confirm your Railway volume's current encryption guarantees and access policy before using sensitive content. The application does not claim to enable volume encryption. Restrict Railway project access and use the authenticated backup utility from [runtime operations](anytype-runtime.md). Stop both processes for a consistent snapshot; scheduled live filesystem copies are unsupported. Keep encrypted backups outside the source volume and keep the passphrase separately.

Pin and review CLI/checksum changes in `scripts/setup-anytype.sh`; build and test the image before rollout. Back up a closed instance first. If an upgrade fails, restore a complete snapshot into a new empty volume and run the previous image. Do not downgrade an already-migrated data directory in place. Verify API auth, allowlisted search/read, denied writes, and persisted test data after a restart and restore.

Railway publication, hosted TLS, custom domains, client OAuth callbacks, and ChatGPT/Codex installation require their own live verification after deployment. Local checks do not prove those integrations are installed.

## Official references

- [Railway config as code](https://docs.railway.com/config-as-code/reference)
- [Persistent volumes](https://docs.railway.com/volumes/reference)
- [Public networking and HTTPS](https://docs.railway.com/networking/public-networking)
- [Creating Railway templates](https://docs.railway.com/templates/create)
