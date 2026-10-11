# Deployment

Run Artiface on the machine that can read your artifacts and reach your SSH hosts.
Docker is preferred; a [native build](development.md#run-locally) is also available.
After installation, follow the [quick guide](guide-quick.md).

## Docker quick start

The container setup uses Docker Engine and Docker Compose on Linux.
The published image is `ghcr.io/i207m/artiface:latest`.
Download [compose.yaml](../compose.yaml) into a new directory, or use the copyable commands in the [README](../README.md#quick-start).
From the directory containing `compose.yaml`:

```sh
mkdir -p data
docker pull ghcr.io/i207m/artiface:latest
docker compose run --rm -it \
  -v "$HOME/.ssh:/home/artiface/.ssh:ro" \
  artiface import-ssh --config /data/config.json
docker compose up -d
docker compose logs --tail=50 artiface
```

The published image runs as UID/GID `1000:1000` and needs read/write access to `data`; see [data access](#data-and-ownership) if the operating system denies access.
During first-time import, choose and confirm an admin password, or press Enter to generate one.
Save the generated password shown once after a successful import.
If configuration already exists, enter its current admin password instead.
It creates `data/config.json` with localhost and the imported SSH hosts.
Open `http://127.0.0.1:8787` and sign in with that password to unlock SSH, or use `/admin/` in Team mode.
Server startup creates the default ignore rules.
Re-running import preserves existing projects and accounts; there is no separate initialization step.
For local-only use, skip import and sign in with the **Initial password** printed in the logs, then change it in **Settings → Security**.

Mount the folder you want to display by adding a read-only volume alongside the existing `/data` volume in `compose.yaml`:

```yaml
      - type: bind
        source: /absolute/path/to/your/reports
        target: /projects/reports
        read_only: true
        bind:
          create_host_path: false
```

Recreate the service, then select `/projects/reports` under **Open a project → localhost**.
Add more mounts for other folders, or omit artifact mounts for SSH-only use.
Localhost refers to the container filesystem.

Copy [.env.example](../.env.example) to `.env` for optional Compose overrides:

| Variable | Purpose |
| --- | --- |
| `ARTIFACE_DATA_DIR` | Host data directory, default `./data`. |
| `ARTIFACE_BIND_IP` | Host interface to publish, default `127.0.0.1`. |
| `ARTIFACE_APP_ORIGIN` | Browser URL saved when creating a configuration. |
| `ARTIFACE_MODE` | `personal` or `team`, selected on every startup. |
| `ARTIFACE_DISABLE_SSH` | Set to `true` to disable SSH connectivity; default `false`. |
| `ARTIFACE_IMAGE` | Image to run, default `ghcr.io/i207m/artiface:latest`. |

For unattended CLI setup or import, pass `ARTIFACE_PASSWORD` only to that one-time command.
Compose does not pass it to the running service, and it never unlocks SSH during server startup.
Keep passwords out of committed files and command arguments.

## Data and ownership

Compose bind-mounts the host data directory at `/data`.

```text
data/
├── config.json       # Settings, accounts, and the active credential revision
├── config.ssh.json   # Encrypted SSH credentials, created by import
└── .artifaceignore   # Shared browsing rules
```

The `/data` mount is writable for settings; artifact mounts should be read-only.
On Linux, an empty `config.json.lock` file coordinates command-line and web updates.

The server needs read access to its configuration and credentials, read/write access to the update lock, and permission to create and replace files in the data directory.
If the operating system reports “permission denied”, grant the container user the needed access or [build an image](#build-your-own-image) with your host account's UID/GID.
New application state files are created with mode `0600`.
Keep configuration in regular files without links.
Existing empty or customized ignore files are preserved; a missing file is recreated at startup.
Mount the containing directory, not `config.json` alone, because settings are saved by atomic replacement.

## Build your own image

Build from a source checkout when developing Artiface or customizing its runtime account:

```sh
git clone https://github.com/i207m/artiface.git
cd artiface
docker build -t artiface:local .
```

For a custom account, pass unused, nonzero IDs as build arguments:

```sh
docker build \
  --build-arg ARTIFACE_UID="$(id -u)" \
  --build-arg ARTIFACE_GID="$(id -g)" \
  -t artiface:local .
```

Set `ARTIFACE_IMAGE=artiface:local` in the deployment directory's `.env`.
Use the SSH import and startup commands above, omitting the published-image pull.
The Compose file runs images; it does not build them.
After rebuilding, recreate the service with `docker compose up -d --pull never`.

## SSH sources

### Add a host in the web app

Choose **Settings → Sources → Add SSH host** and enter an alias, hostname, username, and port.
Choose a login password or provide a private key and its passphrase, if needed.
Enter your Artiface admin password to encrypt the credentials in `config.ssh.json`.
An optional jump host must already be saved or imported.
The new host is available immediately; choose its project folder without restarting.
In Team mode, add hosts from `/admin/`.

### Import existing SSH configuration

Import credentials once instead of mounting `.ssh` in the running service.
From the Compose directory:

```sh
docker compose run --rm -it \
  -v "$HOME/.ssh:/home/artiface/.ssh:ro" \
  artiface import-ssh --config /data/config.json
docker compose restart artiface
```

Enter the admin password and any private-key passphrases without echo.
If the app configuration does not exist yet, choose a new admin password or press Enter to generate one.
The generated password is shown once after a successful import; save it for sign-in and future imports.
For a native installation, run `artiface import-ssh --config /path/to/config.json`.
The Sources page contains the same copyable command-line guide.

Only the import container sees the SSH directory, and it is removed when the command finishes.
Use a dedicated import directory if you want to limit the identities available during import.
Its files must be readable by the container user.
For example:

```sshconfig
Host research
    HostName research.example.com
    User researcher
    IdentityFile ~/.ssh/id_artiface
```

Set `User` explicitly when importing into Docker, where the default account name is `artiface`.
Host absolute paths and symlinks are not remapped; use portable `~/.ssh` paths or mount referenced files for the import command.
Existing `known_hosts` entries are imported; the import command does not contact hosts or automatically trust keys.
If a key is unknown, the web app shows its hostname, key type, and SHA-256 fingerprint before connecting.
Changed keys show the previous fingerprint as well.
Verify the fingerprint through a trusted channel, then approve it with your Artiface admin password to save the exact key in the encrypted credential file.
Only the personal owner or Team admin can approve keys; revoked keys and invalid certificates remain blocked.

Add `--host alias` to select a host, repeating it for several hosts.
Add `--password-host alias` to prompt for that host's SSH login password.
Normal Host/Include settings, software private keys, and ProxyJump are supported.
Use a dedicated supported configuration via `--ssh-config` when needed.

Reimport after changing keys, passwords, host settings, or trusted host keys, then restart.
Existing projects and accounts are preserved; the import updates the encrypted credentials and host-key trust snapshot.
Choose an imported host in **Open a project** and select a folder to add its project.
Removing a host deletes its projects, access grants, and saved SSH credentials, and closes its connections.
Enter the admin password to update the encrypted credential file; removing the last SSH host deletes that file.
Keys still used by another host remain available to that host.
A host used as a jump host cannot be removed until its dependent hosts are removed or reconfigured.
To erase all imported credentials, use the explicit `--forget-ssh` option in [password recovery](#updates-and-password-recovery).

### Unlocking and protection

Private keys, SSH passwords, and approved host keys are stored in `config.ssh.json`, separately from `config.json`.
For a custom configuration such as `app.json`, the encrypted file is `app.ssh.json` in the same directory.
The configuration contains only a non-secret credential revision reference; encrypted payloads never appear in it.
Updates publish encrypted data before switching the configuration's password hash and revision reference together.
Startup cleans up any unused revision left by an interrupted update.
The encryption key is derived from the admin password using Argon2id; encryption uses AES-256-GCM with a fresh salt and nonce.
The login password hash is separate and cannot decrypt the credentials.

After every server restart, SSH stays locked until the personal owner signs in or the team admin signs in at `/admin/`.
When `ARTIFACE_DISABLE_SSH=true`, sign-in does not unlock SSH.
Unlocking lasts until the server exits; signing out does not interrupt other users' SSH access.
Local projects remain usable while SSH is locked.
Private keys and passwords are decrypted in server memory and are never returned by settings APIs.

## Network access

### SSH tunnel

Use a tunnel when Artiface runs on a remote server and you want to open it in your laptop's browser.
You need SSH access from your laptop to that server.

1. **On the server**, start Artiface using the Docker or native setup above.
   The default Compose bridge network and localhost port publishing already support this setup.
   Artiface must be reachable at `127.0.0.1:8787` from the server itself.

2. **On your laptop**, open a terminal and run the command below from any directory.
   Replace `your-server` with an SSH alias configured on your laptop, or a login address such as `alice@192.168.1.50`.

   ```sh
   ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 your-server
   ```

   Authenticate with your usual SSH key or server login password if prompted.
   The first `127.0.0.1:8787` is the listening address on your laptop; the second is Artiface's address as reached from the server.
   Keep this terminal open while using Artiface.
   No output after connecting is normal: `-N` keeps the tunnel open without starting a remote shell.

3. **In your laptop's browser**, open `http://127.0.0.1:8787` and sign in to Artiface.
   Use your Artiface password here; the SSH login in the previous step is separate.
   With the default preview settings, the tunnel carries both the app and HTML previews.
   Press `Ctrl+C` in the tunnel terminal when finished.

This example uses the default `appOrigin` of `http://127.0.0.1:8787` and an empty `previewOrigin`.
If you changed them, update the server's configuration and restart Artiface before using this URL.
The browser URL must match `appOrigin`, including the hostname and port.
The tunnel is available only on the computer running the command; for phones or tablets, use [LAN or HTTPS](#lan-or-https).

### LAN or HTTPS

For a new LAN installation, set the server's LAN IP and browser URL in `.env` beside `compose.yaml`:

```dotenv
ARTIFACE_BIND_IP=192.168.1.50
ARTIFACE_APP_ORIGIN=http://192.168.1.50:8787
```

Replace `192.168.1.50` in both values with your server's LAN IP.
Open `http://192.168.1.50:8787` in a browser on the same network, substituting your server's IP.
Compose still publishes port `8787`; edit `ports.published` as well if using another port.
For an existing installation, edit `appOrigin` in `data/config.json`; environment defaults do not overwrite it.
Keep Docker's `listen` as `0.0.0.0:8787`.
For native servers, choose the desired IP in `listen`; anything other than `127.0.0.1` also requires an explicit `appOrigin`.

Use HTTPS for Internet access or other untrusted networks.
Set `appOrigin` to the public URL, such as `https://artifacts.example.com`, and proxy all paths to Artiface while preserving the original `Host` header.
An optional `previewOrigin` must use the same scheme and route to the same listener.
Leave it empty to use the app's URL.

For Nginx running on the Artiface server, keep `ARTIFACE_BIND_IP=127.0.0.1` and add this server block inside Nginx's `http` configuration.
Replace `artifacts.example.com` with your domain and set the paths to its existing TLS certificate chain and private key:

```nginx
server {
    listen 443 ssl;
    server_name artifacts.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $http_host;
    }
}
```

Validate with `sudo nginx -t`, then reload Nginx with `sudo nginx -s reload`.

Restart after direct configuration edits; recreate the container after changing Compose settings.
Unknown configuration fields fail validation.
A phone's localhost refers to the phone itself; use the server's reachable URL.

## Personal and Team modes

Personal mode uses one password and is the default.
Set `ARTIFACE_MODE=team` in Compose's `.env` and recreate the service to use accounts and project grants.
For a native server, use `serve --mode team`.
The native selection order is `--mode`, `ARTIFACE_MODE`, saved `mode`, then `personal`.
Switching modes requires a restart, ends sessions, and preserves sources and accounts.

In Team mode, the initial password opens `/admin/`.
Import SSH hosts from the command line, add project folders in Sources, then create users and assign projects under **Access**.
Users sign in at `/` with their own username and password; there is no public signup.
See [team administration](guide-full.md#team-administration) for access changes.

## Updates and password recovery

To update the published image, run from the deployment directory:

```sh
docker compose pull artiface
docker compose up -d
```

You can pin a commit tag or digest instead of `latest`.
Set `ARTIFACE_IMAGE` in `.env` to select another image or a pinned build.
For locally built images, follow [Build your own image](#build-your-own-image) instead.
Updating the container preserves the bind-mounted data.

Change the admin password in **Settings → Security**, or reset a forgotten password from the CLI:

```sh
docker compose run --rm -it artiface password --config /data/config.json
docker compose restart artiface
```

Changing the password re-encrypts stored SSH credentials and requires the current password.
If it is forgotten, use `password --config /data/config.json --forget-ssh` to explicitly discard the encrypted credentials, then reimport them.
Project definitions and user accounts are retained.
For native installations, use the same command with your configuration path and restart.
Passwords require at least six characters; changes in Settings take effect immediately and sign out all sessions.

## Optional native PDF tools

Docker includes the tools for PDF Compression.
Native servers need Poppler (`pdfinfo`, `pdftoppm`, and `pdftohtml` for outlines), plus `prlimit` on Linux.
Install `poppler-utils` and `util-linux` with your distribution's package manager, then restart Artiface.
They run on the Artiface server, not the SSH target; Original PDF mode works without them.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Ignore rules cannot be read safely | Use regular configuration and ignore files without links; check that the server can read them and write to the data directory. |
| Startup requests `appOrigin` or redirects to another URL | Edit the saved `appOrigin` and open that exact URL; changing `.env` does not repair an existing config. |
| HTML preview cannot connect | Route `/p/` through the same tunnel or proxy; `/p/healthz` should be reachable. |
| SSH is locked after restart | Sign in as the personal owner or at `/admin/`, then retry the file. |
| SSH folders fail to open | Reimport the intended credentials and trusted host keys, and check network reachability. |
| Compression is unavailable | Install the native PDF tools or choose Original mode. |
| Report styles or controls are missing | Check [HTML assets and script trust](guide-full.md#html-and-links). |
