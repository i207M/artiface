# Security and trust

Artiface exposes selected local and SSH files to authenticated browser sessions.
Choose project roots deliberately and run the server as an account with only the filesystem and SSH access it needs.

## Application boundaries

Artifact APIs are read-only.
Project roots and user grants constrain listing, file reads, downloads, Git previews, and HTML preview capabilities.
Contained symlinks are supported; escaping a project root is rejected.
Ignore patterns, hidden-file settings, and type filters are presentation controls, not access restrictions.

Personal mode uses one password.
Team mode uses admin-created accounts and explicit project grants, with separate admin and workspace sessions.
Passwords are stored as salted Argon2id hashes, and authenticated writes have CSRF checks.
Disabling a user or changing access prevents subsequent authorized requests; it cannot recall bytes already received by a browser.

## Report trust

HTML reports run in an opaque iframe sandbox with scripts disabled by default.
Allowing JavaScript trusts every HTML report in that project.
Scripts remain isolated from the app's DOM and browser storage but can read their preview folder and may contact external services.
Use the stable app share link for navigation; temporary preview URLs are bearer capabilities and should be treated like the report contents.

Git inspection is read-only and bounded.
Repositories requiring custom filters or partial-clone fetching are excluded from Git previews.
PDF Compression uses bounded native renderer processes and private temporary snapshots on the Artiface server.

## Deployment

Use HTTPS for access over untrusted networks.
The default Compose setup publishes the app only on loopback, with optional read-only artifact mounts.
Limit access to the configuration directory and exclude credentials and runtime data from Git.
The one-time SSH import mounts only the directory selected for that command; the running service does not mount `.ssh`.
Validate host-key fingerprints through a trusted channel before importing or approving them.
Unknown and changed keys require explicit owner/admin approval of the observed key before SSH authentication.
Approved keys are saved with encrypted credentials; revoked keys and invalid certificates cannot be approved.
The supplied Docker build context excludes local data, SSH files, environment files, and generated outputs.

Imported credentials use AES-256-GCM with fresh random salt/nonce and an Argon2id-derived key separate from the login hash.
The encrypted payload is stored in `config.ssh.json`, created with mode `0600`; `config.json` contains only its revision reference.
Only a personal-owner or team-admin login decrypts them after restart; ordinary team accounts cannot unlock the vault.
Private keys and SSH passwords remain in server memory while unlocked and are never included in settings responses.
Removing a host deletes its credential profile and unused key material, invalidates pending key approvals, and closes its connections.
Removing the last SSH host removes the encrypted credential file.
Changing the admin password re-encrypts credentials; recovery without the old password explicitly discards them for reimport.
This protects saved configuration and backups, not a compromised running process or an easily guessed admin password.

See [Deployment](docs/deployment.md) for configuration details.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting option.
Please include the affected commit, a minimal reproduction, impact, and any suggested fix.
Do not test against the demo or deployments operated by others.
