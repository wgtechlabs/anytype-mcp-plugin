# Verification

Local verification on 2026-10-03 (Asia/Manila), with a dedicated sandbox bot and no personal workspace data.

| Layer | Evidence | Status |
| --- | --- | --- |
| TypeScript | `npm run check` | Passed |
| Regression suite | `npm test` | 22 tests passed, including real subprocess lifecycle |
| Authentication | OAuth PKCE, callback/resource binding, consent CSRF, token expiry/rotation/replay/revocation; separate owner and bearer secrets | Automated integration tests |
| MCP gateway | Real HTTP protocol initialization/discovery, validation, scope restrictions, read-only, frozen proposals, duplicate scans, conflicts, expiry/replay, sanitized errors | Automated integration tests |
| Dependency audit | Pinned dependencies and rebuilt upstream entrypoint with patched Axios | No reported vulnerabilities at verification time |
| Native Anytype | Pinned v0.4.0 checksum; new bot; sandbox and welcome note; API authenticated | Passed |
| Experimental v2 | Live schema discovery, approved space selection, search, and no mutation tools | Passed; read-only |
| Live MCP reads | `npm run smoke`; 26 tools, auth/search/read/types/properties/scope and invalid-ID rejection | Passed |
| Container | Docker build; isolated volume bootstrap; same smoke before and after container restart | Passed locally |
| Recovery | Encrypted snapshot restored into empty directory; restored bot authenticated and found sandbox/welcome note; original runtime restarted | Passed locally |
| Backup negative cases | Wrong passphrase, tampering, running instance, nonempty restore path | Passed self-check |
| Plugin package | Six SKILL.md validators, portable plugin and MCP JSON schemas | Passed |
| CI definition | Reusable Build Flow SHA verified and all input names/types checked | Passed static validation |

Live confirmed-write smoke passed for note creation and editing, duplicate rejection, single-use proposals, property/tag creation and updates, type creation and updates, task creation and completion, and template listing. Every mutation was restricted to the disposable **Anytype MCP Sandbox**. The normal endpoint remains read-only.

Runtime testing found that Anytype returns properties in arbitrary array order. Revision comparison now canonicalizes that unordered property map, with a regression check, while preserving ordered content. Independent review also corrected incomplete duplicate pagination and gateway lifecycle failure propagation.

## Deliberate verification boundaries

- No existing personal space was invited or synchronized. Only isolated test identities and data were used.
- No Railway deployment, hosted TLS, public template listing, GHCR publication, or release execution is claimed by these local checks.
- The package is prepared for supported plugin installation. ChatGPT web/desktop and Codex app/CLI/IDE installation and native approval behavior require separate signed-in client checks.
- Experimental v2 read support is isolated from stable v1 and remains read-only. v1 has no template-create API or atomic conditional writes.
- The server checks current object state immediately before a write. It cannot prevent a desktop edit racing the v1 HTTP update.
- `confirmed=true` is not evidence of a human click. Keep read-only mode unless the connecting client enforces the intended approval prompt.
- OAuth registrations/grants and proposals are in memory and revoke on restart. This deployment uses a single bot owner, one process and one volume.
- A pinned Build Flow caller does not pin every mutable reference inside the upstream workflow. No claim of fully immutable transitive CI is made.
