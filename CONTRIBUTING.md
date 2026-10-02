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

`.github/workflows/build-flow.yml` calls [Build Flow Action](https://github.com/wgtechlabs/build-flow-action) at the verified upstream commit `b46ac3e40de838b87e1da6b3e69382982d080916`. CI installs the lockfile, checks types, runs tests and an npm vulnerability audit, and builds. Gitleaks and CodeQL use the reusable workflow's enabled defaults; container scans fail on findings at the configured threshold.

Release and container flows are enabled; npm/package publication is disabled. Pushes to `main` can publish a GHCR image and finalize a GitHub release after the workflow gates pass. Pull requests, `dev`, and manual dispatches do not publish artifacts. The initial supported container target is `linux/amd64`; add other architectures after verifying them.

GHCR and release operations use GitHub's built-in `GITHUB_TOKEN`, with the caller permissions declared in the workflow. No personal token is configured. Repository policy must allow the release commit/tag operations and package publication; do not bypass branch protection with a PAT. An organization using licensed Gitleaks features may need its own configuration.

The caller's immutable pin does not freeze the reusable workflow's internal action and nested workflow references. Review those dependencies when updating the pin. This local configuration has not run on GitHub until the repository is published and a workflow executes successfully.

Keep deployment a separate, explicit action. A release workflow or container publication does not deploy a Railway service.
