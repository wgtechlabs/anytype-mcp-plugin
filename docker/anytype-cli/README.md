# Container Anytype security build

The container rebuilds Anytype CLI `v0.4.0` as `v0.4.0-security.1-dirty`. The `dirty` suffix records the applied source patches. This is a project-maintained security build, not an official Anytype release binary. Native local setup continues to download the official `v0.4.0` binary.

The build starts from the same CLI release and its pinned Anytype Heart `v0.51.4` source. Its changes are limited to:

- Go `1.26.5` → `1.26.8` for standard-library security fixes.
- `golang.org/x/image` `0.38.0` → `0.45.0` and gRPC `1.83.1` → `1.83.2`.
- JWT `3.2.2` → `4.5.2`, using the [upstream-supported import migration](https://github.com/golang-jwt/jwt/blob/v4.5.2/MIGRATION_GUIDE.md) in Heart's session service. JWT v3 has no patched release for [CVE-2025-30204](https://github.com/golang-jwt/jwt/security/advisories/GHSA-mh63-6h87-95cp).

`security.patch` locks the CLI module graph and checksums. `heart-security.patch` changes one import and the corresponding module files in a separate Heart source directory; it never modifies the Go module cache. A direct v3-to-v4 module replacement was rejected because `go mod tidy` resolves the replacement under two module paths.

## Pinned inputs

| Input | Immutable identity |
| --- | --- |
| [Anytype CLI v0.4.0](https://github.com/anyproto/anytype-cli/tree/bb73c27503dde4e5632629b8b7dbd4c78e1b28a1) | Commit `bb73c27503dde4e5632629b8b7dbd4c78e1b28a1`; archive SHA-256 `e00fdcfed05f0e4d883ac29a98484bb9ed71f0a2aed6b11cc9f498edbaa3eea3` |
| [Anytype Heart v0.51.4](https://github.com/anyproto/anytype-heart/tree/11eb77c889c2eda1e4fc902751194813239c4590) | Commit `11eb77c889c2eda1e4fc902751194813239c4590`; archive SHA-256 `ad44b175644a866913f14c58de8dceec62e02e3bbcfb42b6bae8e29adbbc36ce` |
| Official Go `1.26.8-alpine3.24` | Image index `sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c` |
| [Tantivy Go v1.0.6](https://github.com/anyproto/tantivy-go/releases/tag/v1.0.6) | Upstream musl archive SHA-256 values for amd64 and arm64 are checked in `build.sh` against the published release asset digests. |

The script follows [Anytype's static musl build](https://github.com/anyproto/anytype-cli/blob/bb73c27503dde4e5632629b8b7dbd4c78e1b28a1/Makefile), including the `noheic` build tag and pinned Tantivy library. It runs upstream JWT and Heart session tests, then builds with a read-only module graph. It outputs `/out/anytype` and the upstream licenses `/out/LICENSE-anytype-cli.md` and `/out/LICENSE-anytype-heart.md`; the application image retains both licenses under `/opt/anytype/`.

## Maintenance and verification

Review these patches whenever updating Anytype. Prefer a fixed official release when available; remove the local Heart override and security patches only after its binary passes the same vulnerability scan and runtime checks. Keep the version suffix while any project patch remains.

On 2026-10-03, the patched Linux amd64 binary built successfully and its upstream JWT and Heart session tests passed. Trivy `0.70.0`, using the same vulnerability database as the published-image baseline, reported **zero HIGH and CRITICAL findings** for the rebuilt binary, down from 12 HIGH findings. The binary's build metadata confirmed Go `1.26.8`, JWT `4.5.2`, x/image `0.45.0`, and gRPC `1.83.2`. Arm64 build inputs are pinned, but arm64 compilation and execution were not tested in this verification.

Dependency and session tests do not prove full Anytype synchronization, invitation joining, or ChatGPT/Codex integration. Those behaviors require the application's separate runtime checks. Vulnerability scans cover detected packages and known advisories; they do not establish that every reported vulnerability is reachable.
