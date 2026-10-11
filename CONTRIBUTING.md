# Contributing to Artiface

Artiface aims to make artifacts easy to inspect without turning the workspace into a complicated IDE.
Changes should preserve responsive reading, clear project boundaries, and a compact interface.

## Run locally

The project is built with Go 1.26 and Node.js 24, using npm and `make` on Linux.
From the repository directory:

```sh
make setup
make build
./bin/artiface serve --config .local/config.json
```

The initial password is printed once.
Rebuild and restart after frontend changes because the web assets are embedded in the executable.
See [Development](docs/development.md) for source layout and focused checks.

## Validate a change

```sh
make test
node web/node_modules/@playwright/test/cli.js install --with-deps chromium
make browser-test
```

For changes to authentication, storage, SSH, or project access, also run `make smoke`.
The smoke suite needs Python 3, Git, and OpenSSH client/server tools; it uses disposable local fixtures.
Run `python3 scripts/container-smoke.py --image artiface:ci` after building a container change.

Prefer focused regressions for bugs and non-obvious behavior.
Check UI changes at desktop and phone widths, in both densities, with enlarged text and keyboard navigation.
When layout depends on CSS order, check the production build as well as isolated component fixtures.

## Report a bug

Include the commit shown in **Settings → About**, deployment method, browser/device, reproduction steps, and expected behavior.
For viewer issues, a small synthetic file that reproduces the problem is especially useful.
Remove private paths, hostnames, credentials, and report data from logs or screenshots before sharing them.
Report suspected vulnerabilities through the process in [Security](SECURITY.md), not a public issue containing sensitive details.
