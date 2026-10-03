# Anytype runtime

`scripts/setup-anytype.sh` downloads the official Anytype CLI **v0.4.0**, verifies the release archive against its pinned SHA-256, starts it on loopback, and creates a dedicated bot. With no invite or explicit allowlist, it initializes an **Anytype MCP Sandbox** space with a welcome note. Run from the repository after `npm ci`:

```sh
scripts/setup-anytype.sh
scripts/anytype.sh status
scripts/anytype.sh stop
scripts/anytype.sh start
```

The API is `http://127.0.0.1:31012`. Ports 31010–31012 must be free; startup refuses to disturb an existing service. The desktop app normally uses 31007–31009. No system service is installed. `.local` contains the downloaded executable, private home, data, PID and logs. `.env` receives the gateway's API key and automatically selected space ID unless an explicit allowlist is configured, with read-only mode enabled by default. Files containing secrets are created with mode 600; directories are private. Do not commit, paste, or expose these files.

The wrapper passes a separate home and `DATA_PATH` only to the child CLI. On macOS, the upstream Keychain service name is shared across instances. A narrow `sandbox-exec` rule denies `/usr/bin/security` so upstream falls back to the isolated configuration file; the user's normal Keychain and Anytype configuration are untouched. Linux disables desktop D-Bus keyring discovery for the same purpose. Use `scripts/anytype.sh cli ...` for account and space commands so the isolation remains in effect.

## Network and existing desktop data

CLI v0.4.0 supports the default Anytype Network and a custom network configuration; it does **not** provide a local-only network flag. “Local” here describes where the service and storage run. The bot can participate in encrypted Anytype Network sync. For a self-hosted Any-Sync network, set `ANYTYPE_NETWORK_CONFIG` to its YAML path **before the first account creation**. Desktop and bot must use the same network.

Desktop recovery mnemonics cannot log in to the bot CLI. The bot is a separate identity. To connect an existing space, create an invitation in Anytype and privately set `ANYTYPE_INVITE_LINK` in `.env` before local setup, or in service variables before container startup. **This bootstrap behavior is unreleased and unavailable in image `0.1.0`.** Existing deployments and the saved Railway template draft need a newer verified release containing it.

Accepted links include `https://<host>/invite/<cid>#<key>` and `anytype://invite/?cid=<cid>&key=<key>`. The pinned CLI also accepts the HTTP web form. Use the original Anytype-generated CID: bootstrap accepts the pinned generator's lowercase base32 CIDv1 format and rejects alternate CID encodings. Quote the value in `.env` to preserve the `#key` fragment; use the raw complete link in Railway's variable field. An invite grants access: never commit it, paste it into chat, or put it in shared logs or shell history. Normal Railway setup uses a private variable rather than a terminal command.

On startup, the bot attempts the invitation once per fingerprint of its decoded CID and key. Equivalent web/app links, ignored query parameters, query ordering, and percent encoding share the same history. The CLI receives a canonical link built from that same identity. Its private attempt history at `secrets/invite-state.json` contains a format version, fingerprints, and resolved targets (or an uncertain outcome marker); raw invite output is not retained. This history survives configuration rollbacks and is included in runtime backups. When no explicit `ANYTYPE_ALLOWED_SPACES` is set, bootstrap allowlists the exact invitation target. Replacing an invitation updates this automatically managed invite allowlist. An explicit allowlist remains authoritative, including an explicitly empty value that denies all spaces. Check existing overrides when moving an older sandbox deployment to an invited space. With no invite or existing allowlist, bootstrap uses the sandbox default. Removing an invitation does not revoke existing bot membership or clear an already saved allowlist.

Unreleased prototypes saved unversioned hashes of whole URLs. Those hashes cannot safely be converted into invitation identities, so startup with an invite refuses that history without modifying it. Preserve the runtime and its history; remove `ANYTYPE_INVITE_LINK` to continue using its saved permissions, or use a fresh runtime and a newly generated invitation. Do not delete attempt history to force a retry. Released image `0.1.0` does not create invitation history and is unaffected by this prototype safeguard.

Membership can require the space owner's approval. The gateway starts while access is pending and reports “waiting for space access; owner approval may be required”. Check the owner's pending requests in Anytype. After approval and sync, the target becomes accessible without restarting the gateway. A successful join command exit is not membership proof: the pinned CLI can mask a rejected join, so check invitation validity and owner approval if access remains absent.

A timeout or crash during a join leaves an attempt marker because the outcome is uncertain. Restarting refuses to repeat that invitation. Inspect membership first; if another attempt is necessary, generate a new invitation and replace `ANYTYPE_INVITE_LINK` before running setup or restarting the container. Do not clear the marker to force a blind retry. Desktop owners can remove the bot to revoke membership. Joining and cross-device synchronization depend on network availability and have not been verified against the user's desktop vault.

Native CLI import/export is unavailable. Import existing material using Anytype desktop, then invite the bot to that space. Official exports do not include chat/discussion messages and can lose member-valued relationships. Do not copy the live desktop database into the bot directory.

## Keys and permissions

The recovery credential is stored privately in `.local/secrets/account-recovery.txt` and `.local/home/.anytype/config.json`; preserve it securely. This is a bot account key, not a desktop mnemonic. The API key is in `.local/secrets/api-key.txt` and `.env`; the gateway never supplies it to MCP clients.

Stable API v1 accepts only an all-spaces/read-write key. Space-scoped/read-only keys work only with experimental v2. Therefore v1 relies on the gateway's space allowlist and write gates, plus limited bot membership. Do not expose the upstream API publicly.

To rotate a key, create a replacement privately with `scripts/anytype.sh cli auth apikey create <name> --all-spaces --read-write`, update `.env` and `.local/secrets/api-key.txt`, restart and verify the gateway, then revoke the old key by ID. Commands that create or list keys can print secrets: do not use them in shared logs. Never retry an uncertain v1 mutation automatically.

## Encrypted backup and restore

Anytype encrypts object data, but its **local indexes are unencrypted**. Use FileVault or an encrypted local volume. Linux/hosting volume encryption must be provided by the storage platform; this repository cannot enable it by declaring an environment variable. Restrict access to the entire runtime directory.

Stop the gateway and CLI before backup. Store `BACKUP_PASSPHRASE` in your secret manager or enter it into the environment without putting its value in the command line. Use a long, unique passphrase; losing it makes the backup unrecoverable.

```sh
scripts/anytype.sh stop
node scripts/backup.mjs create /secure/backups/anytype.enc
node scripts/backup.mjs restore /secure/backups/anytype.enc /secure/restore/anytype
node scripts/backup.mjs --self-test
```

The output path's parent must already exist. Backups use scrypt and AES-256-GCM, include the runtime home/data/secrets and `gateway.env` if present, and never overwrite an existing backup. A native project's root `.env` is outside the runtime: save it separately in your secret manager, or copy it privately to `.local/gateway.env` before backup. The process refuses a running recorded instance; the operator must also ensure no independently started process uses the same directory. Authentication is verified before archive extraction. Restore accepts only an absent or empty destination and rejects archive links and paths outside the expected runtime directories.

To verify recovery without touching the original, stop the original runtime, point `ANYTYPE_RUNTIME_DIR` at the restored directory and `ANYTYPE_BINARY` at the original pinned binary, then start the wrapper and read the welcome note using the recovered API key. The fixed loopback ports allow only one active runtime per host. Keep the original snapshot until verification completes. Install the same CLI version for recovery before attempting an upgrade.

## Sources

- [Pinned CLI source and commands](https://github.com/anyproto/anytype-cli/tree/v0.4.0)
- [CLI self-hosted networks](https://github.com/anyproto/anytype-cli/blob/v0.4.0/SELF-HOSTED.md)
- [Anytype encryption and plaintext indexes](https://github.com/anyproto/docs/blob/main/data/privacy-and-encryption.md)
- [Closed snapshots and storage restrictions](https://github.com/anyproto/docs/blob/main/data/sync-and-backup/README.md)
- [Desktop import and export limitations](https://github.com/anyproto/docs/blob/main/data/import-and-export/README.md)
