# Development

Artiface uses Go for the server and React/TypeScript for the interface.
The frontend is embedded in the executable; SSH targets need no Artiface installation.

## Run locally

The project is built with Go 1.26 and Node.js 24, using npm and `make`.
Linux is the primary development platform; importing SSH configuration needs an OpenSSH client.

```sh
make setup
make build
./bin/artiface serve --config .local/config.json
```

Open `http://127.0.0.1:8787` using the initial password printed once.
The first run creates the configuration and ignore rules automatically.
Keep development data in the ignored `.local/` directory.
Without `--config`, native commands use the platform configuration directory, usually `~/.config/artiface/config.json` on Linux.
See [Deployment](deployment.md) for Docker, SSH setup, and remote access.

After frontend edits, rebuild **and restart the executable**; changing `web/dist` alone does not update a running server.
For Go-only edits after a frontend build, `go build -trimpath -o bin/artiface ./cmd/artiface` reuses those assets.

## Build and test commands

| Command | Purpose |
| --- | --- |
| `make setup` | Download Go modules and install locked frontend dependencies. |
| `make build` | Type-check, build the frontend, and compile `bin/artiface`. |
| `make web-build` | Build frontend assets only. |
| `make test` | Go race tests, vet, TypeScript, and focused non-browser checks. |
| `make browser-test` | Browser regressions using synthetic fixtures. |
| `make smoke` | Build, run SSH/API/browser and Team integration checks, then browser regressions. |

Install the browser once before running browser checks:

```sh
node web/node_modules/@playwright/test/cli.js install --with-deps chromium
make test
make browser-test
```

Smoke tests also need Python 3, Git, and OpenSSH client/server tools.
They use temporary services, generated keys, and sample artifacts rather than your configured SSH hosts.
Run them in a user-owned checkout with local process and socket access.
For an already-built binary, `python3 scripts/smoke.py --binary bin/artiface` runs the API/SSH checks; add `--browser` for its browser checks.

For a container change:

```sh
docker build -t artiface:ci .
python3 scripts/container-smoke.py --image artiface:ci
```

The container check creates isolated runtime fixtures without using live configuration or SSH credentials.
Prefer regressions for bugs and non-obvious behavior rather than tests that mirror implementation.
Check UI changes on desktop and phone widths, both densities, enlarged text, and keyboard navigation.
Verify the production build when CSS order or lazy-loaded viewers matter.
See [Contributing](../CONTRIBUTING.md) for reporting and reviewing changes.

## Source map

| Path | Responsibility |
| --- | --- |
| `cmd/artiface/` | CLI, startup, passwords, and SSH imports. |
| `internal/config/` | Configuration validation, persistence, and alias discovery. |
| `internal/server/` | Authentication, settings, APIs, and preview capabilities. |
| `internal/storage/` | Local/SFTP access, project containment, and Git inspection. |
| `internal/ignore/`, `internal/pdfpreview/` | Ignore rules and server PDF rendering. |
| `internal/sshvault/` | Encrypted credentials, admin unlock, and SSH transport. |
| `web/src/` | Workspace, settings, viewers, and device preferences. |
| `web/public/` | Manifest, service worker, and icons. |
| `scripts/` | Integration fixtures, browser checks, and asset generation. |

Server configuration stores sources, grants, and shared open-project lists with atomic updates.
Encrypted SSH credentials live in a separate sidecar, normally `config.ssh.json`.
The sidecar stages the new and current revisions before an atomic configuration update selects one; unused revisions are pruned after saving or at startup.
File tabs use browser session storage; device preferences use local storage.
Readers and PDF caches are bounded in memory, with access checked when reused.
SSH/SFTP uses a bounded connection pool and revalidates project paths for each lease.
The CLI snapshots SSH settings and credentials once; the running server never reads the user's `.ssh` directory.
Only a personal-owner or team-admin sign-in unlocks credentials after startup.
There is no background artifact index or external database.

## Build metadata and assets

**Settings → About** shows the commit and build time.
`make build` embeds a UTC timestamp; `ARTIFACE_BUILD_TIME` can supply a fixed value.
Native builds read Go's Git metadata and mark uncommitted changes as dirty.
Docker accepts `--build-arg ARTIFACE_GIT_COMMIT=<commit>` because `.git` is excluded from its build context.
Direct `go build` does not stamp a build time.

The brand and favicon use `web/public/favicon.svg`.
Keep its artwork consistent with `scripts/generate-icons.py`; run that script to regenerate installable-app icons.
Generated builds, dependencies, credentials, and test output stay out of Git.

## Container publishing

The [workflow](../.github/workflows/container.yml) tests the app, runs browser checks, builds a container, and checks its runtime before publishing Linux `amd64` and `arm64` images.
The package name is `ghcr.io/<owner>/<repository>`, lowercased.

| Trigger | Result |
| --- | --- |
| Push to `main` | Validate, then publish `latest` and `sha-<full-commit-sha>`. |
| Push a `v*` version tag | Validate, then publish version and commit tags. |
| Pull request into `main` | Validate without publishing. |
| Manual run | Validate; publish only from `main` or a `v*` tag. |
