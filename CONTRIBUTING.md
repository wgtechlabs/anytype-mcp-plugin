# Contributing to Anytype MCP Plugin

The server and plugin live in one repository. Keep tool behavior, skill instructions, and installation examples consistent. This project follows [Clean Workflow](https://github.com/wgtechlabs/clean-workflow), with [Clean Commit](https://github.com/wgtechlabs/clean-commit) and [Clean Flow](https://github.com/wgtechlabs/clean-flow).

## Branches and reviews

Create a short-lived `feature/`, `fix/`, `docs/`, `chore/`, `test/`, or `refactor/` branch from `dev`. Open feature PRs against `dev` and squash merge them after review and passing checks. Keep `main` stable. Promote `dev` to `main` with a regular merge commit and a meaningful `🚀 release:` PR title; do not squash or rebase the release promotion.

Describe the concrete behavior change, checks performed, and material limitations. Preserve unrelated changes. When addressing review feedback, verify the finding, fix it, test, and reply in the existing review thread with evidence before resolving it. Publication, merge, and deployment require authorization.

## Commit format

Use present tense, lowercase the start of the description, omit the final period, and aim for fewer than 72 characters:

```text
<emoji> <type>: <description>
<emoji> <type> (<scope>): <description>
<emoji> <type>!: <description>
<emoji> <type>! (<scope>): <description>
```

| Emoji | Type | Purpose |
| --- | --- | --- |
| 📦 | `new` | New functionality or files |
| 🔧 | `update` | Improvements or bug fixes |
| 🗑️ | `remove` | Deleted functionality or dependencies |
| 🔒 | `security` | Security fixes and hardening |
| ⚙️ | `setup` | Configuration, CI, and tooling |
| ☕ | `chore` | Maintenance |
| 🧪 | `test` | Tests |
| 📖 | `docs` | Documentation |
| 🚀 | `release` | Releases |

Examples: `📦 new (mcp): add reviewed object proposals` and `🔒 security (auth): reject an unlisted callback`.

## Local validation

Use Node.js 22.16 or later and the committed lockfile:

```sh
npm ci
npm run check
npm test
npm run build
npm audit --audit-level=high
```

For behavior changes, add the smallest meaningful regression test and exercise the changed protocol path. Use disposable Anytype data for integration testing. Confirm authentication, space restrictions, dry-run proposals, read-only refusal, and explicit approval before enabling writes against a real workspace. Keep source content and credentials out of logs and test fixtures.

When changing plugin skills, validate their frontmatter and manually test representative prompts through the target client. Update `plugin/plugin.json` when publishing a changed plugin package; its package version is not evidence of a hosted deployment. State which clients were actually tested.

## Build and release automation

`.github/workflows/build-flow.yml` calls [Build Flow Action](https://github.com/wgtechlabs/build-flow-action) at the verified upstream commit `23e78d3242a09c9250bb186b1e3d271fd611690a`. CI installs the lockfile, checks types, runs tests and an npm vulnerability audit, and builds. The required setup step runs the checksum-pinned open-source Gitleaks CLI over Git history, replacing the license-dependent Action. CodeQL remains enabled; container scans fail on findings at the configured threshold.

The CI Docker hook runs `bash scripts/check-container-security.sh` on every supported workflow event, including pull requests and pushes to `main`, before release finalization or publication. It checks the Dockerfile at every severity, builds `linux/amd64`, verifies startup and lifecycle with an isolated fake Anytype API, and scans the complete exported image for HIGH/CRITICAL vulnerabilities, including those without fixes. The runtime check covers both default non-root startup and Railway's root-owned volume initialization, authentication, read-only enforcement, health failures, restart, backup, and shutdown. It does not connect to Anytype's network. Findings, runtime failures, and scan errors fail CI. The scanner uses the digest-pinned official Trivy 0.75.0 image, receives only a read-only Dockerfile/image archive mount, and does not use a Docker socket or suppression file. The script also runs locally with Docker available and removes its temporary files and image tag when it exits.

This gate checks the CI image. Upstream still rebuilds and scans the release image after pushing it, so the gate does not prove the exact published digest was scanned before publication. The updated workflow pin requires the container job to succeed before creating the GitHub Release; it cannot retract an image already pushed by that job.

Release and container flows are enabled; npm/package publication is disabled. Pushes to `main` can publish versioned images to both `wgtechlabs/anytype-mcp-plugin` on Docker Hub and `ghcr.io/wgtechlabs/anytype-mcp-plugin`, then finalize a GitHub release. Pull requests, `dev`, and manual dispatches do not publish artifacts. The initial supported container target is `linux/amd64`; add other architectures after verifying them.

GHCR and release operations use GitHub's built-in `GITHUB_TOKEN` by default, with the caller permissions declared in the workflow. Leave the optional `GHCR_TOKEN` override unset so the inherited secrets do not replace that default. No GitHub personal token or Gitleaks license is required. Repository policy must allow the release commit/tag operations and package publication; do not bypass branch protection with a PAT.

For Docker Hub, add `DOCKER_HUB_USERNAME` (the login account) and `DOCKER_HUB_ACCESS_TOKEN` (a token with write access to `wgtechlabs/anytype-mcp-plugin`) in GitHub Actions repository secrets or organization secrets available to this repository. The reusable workflow receives them through `secrets: inherit`; never commit or paste tokens into issues. An organization namespace can differ from the login account. Both registry image names derive from the GitHub owner and `container-image-name`.

Before publishing the Railway template, verify the image tag exists and can be pulled from **both** registries, then pin that version or digest in the template. Build Flow removes the GitHub tag's leading `v` (release `v0.1.0` produces image tag `0.1.0`). It can report partial publication if one registry succeeds and the other fails; inspect its per-registry result instead of treating workflow success as proof that both images exist.

The caller's immutable pin does not freeze the reusable workflow's internal action and nested workflow references. Review those dependencies when updating the pin. Check the pull request's GitHub Actions results separately from local verification; PR success does not prove release execution.

Keep deployment a separate, explicit action. A release workflow or container publication does not deploy a Railway service.
