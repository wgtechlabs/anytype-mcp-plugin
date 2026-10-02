# Railway template preparation

Deploy the prebuilt release image on Railway after it has been published to Docker Hub and GHCR. Registry publication and a live Railway deployment have not yet been verified. Codex and ChatGPT provide the interface; the container hosts the MCP gateway and headless Anytype. The repository also includes a Dockerfile and Compose configuration for local builds.

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

After the first successful image publication, create a Railway service with **Docker Image** as its source and choose either registry:

| Registry | Image reference |
| --- | --- |
| Docker Hub | `docker.io/wgtechlabs/anytype-mcp-plugin:<image-tag>` |
| GHCR | `ghcr.io/wgtechlabs/anytype-mcp-plugin:<image-tag>` |

Replace `<image-tag>` with an actually published, verified image tag. Build Flow removes the GitHub tag's leading `v`: a GitHub release `v0.1.0` produces image tag `0.1.0`. For an immutable deployment, replace `:<image-tag>` with `@sha256:<verified-digest>` from that registry's release manifest. These are reference formats, not claims that a tag or digest already exists. Keep the selected image public for a public template; private images require Railway registry credentials. Railway supports both [Docker Hub and GHCR image sources](https://docs.railway.com/services#deploying-a-public-docker-image).

Set these values explicitly in the service settings and reusable template before first start:

| Setting | Value |
| --- | --- |
| Source | The verified release image reference above |
| Start command | Leave unset; use the image entrypoint |
| Healthcheck path | `/healthz` |
| Healthcheck timeout | `180` seconds |
| Restart policy | On Failure, maximum `5` retries |
| Replicas | `1` |
| Persistent volume mount | `/data` |

Apply these settings in Railway's service and template editor. An image deployment does not read source-repository configuration or build the Dockerfile. Add the volume explicitly: the Docker `VOLUME` declaration does not provision a Railway volume.

The gateway accepts Railway's `healthcheck.railway.app` hostname only for `GET /healthz`. MCP and OAuth requests must use the configured service hostname.

Keep one instance per volume. Railway [does not support replicas with volumes](https://docs.railway.com/volumes/reference#caveats), and redeploying a volume-backed service has brief downtime even with a healthcheck.

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

Keep the upstream `ANYTYPE_API_KEY` out of Railway template prompts and client configuration: bootstrap stores it privately in `/data/gateway.env`. Separate operator and MCP secrets stay in Railway Variables. In the template editor, select the verified Docker Hub or GHCR image, generate the two secrets independently, add the `/data` volume, copy the service settings above, and enable public networking. Do not add a Deploy button until an actual template has been published and its URL verified.

## Storage, upgrades, and recovery

Anytype object encryption does not cover local indexes or the CLI's file-based credential fallback. Confirm your Railway volume's current encryption guarantees and access policy before using sensitive content. The application does not claim to enable volume encryption. Restrict Railway project access and use the authenticated backup utility from [runtime operations](anytype-runtime.md). Stop both processes for a consistent snapshot; scheduled live filesystem copies are unsupported. Keep encrypted backups outside the source volume and keep the passphrase separately.

Pin and review CLI/checksum changes in `scripts/setup-anytype.sh`; build and test the release image before publication. Upgrade Railway by selecting the verified new image tag or digest, after backing up a closed instance. Keep image updates manual until the release and recovery checks pass. If an upgrade fails, restore a complete snapshot into a new empty volume and run the previous image digest. Do not downgrade an already-migrated data directory in place. Verify API auth, allowlisted search/read, denied writes, and persisted test data after a restart and restore.

Railway publication, hosted TLS, custom domains, client OAuth callbacks, and ChatGPT/Codex installation require their own live verification after deployment. Local checks do not prove those integrations are installed.

## Official references

- [Docker image services](https://docs.railway.com/services#deploying-a-public-docker-image)
- [Private registry authentication](https://docs.railway.com/builds/private-registries)
- [Healthcheck configuration](https://docs.railway.com/deployments/healthchecks)
- [Restart policy](https://docs.railway.com/deployments/restart-policy)
- [Persistent volumes](https://docs.railway.com/volumes/reference)
- [Public networking and HTTPS](https://docs.railway.com/networking/public-networking)
- [Creating Railway templates](https://docs.railway.com/templates/create)
