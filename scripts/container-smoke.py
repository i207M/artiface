#!/usr/bin/env python3
"""Check a built Docker image on a bridge with disposable volumes and loopback publishing."""

import argparse
import base64
import contextlib
import http.cookiejar
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from smoke import pdf_fixture


OWNER_LABEL = "io.artiface.container-smoke"
COMMAND_TIMEOUT = 30
READY_TIMEOUT = 20
SHUTDOWN_TIMEOUT = 30
MAX_RESPONSE = 8 << 20
NOTE = b"Artiface container fixture.\n"

# This volume is initialized at the image-owned /data, then mounted at /projects.
FIXTURES = """\
umask 077
mkdir -p /data/project/reports/assets
printf 'Artiface container fixture.\\n' > /data/project/note.txt
cat > /data/project/reports/index.html <<'REPORT'
<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head>
<body><h1>Container report</h1><script>document.title = 'fixture';</script></body></html>
REPORT
printf 'body { color: navy; }\\n' > /data/project/reports/assets/style.css
printf 'before Git inspection\\n' > /data/project/.git-probe.txt
git -C /data/project init -q -b main
git -C /data/project add -- .git-probe.txt
git -C /data/project -c user.name=Fixture -c user.email=fixture@invalid commit -q -m fixture
printf 'after Git inspection\\n' > /data/project/.git-probe.txt
"""

SSH_FIXTURES = """\
umask 077
mkdir -p /data/conf.d
ssh-keygen -q -t ed25519 -N '' -f /data/id_fixture
printf 'example.invalid ' > /data/known_hosts
cat /data/id_fixture.pub >> /data/known_hosts
cat > /data/config <<'SSH'
Include ~/.ssh/conf.d/*.conf
SSH
cat > /data/conf.d/hosts.conf <<'SSH'
Host fixture-alias
    HostName example.invalid
    User fixture-user
    IdentityFile ~/.ssh/id_fixture
    IdentitiesOnly yes
    UserKnownHostsFile ~/.ssh/known_hosts
SSH
"""


class SmokeFailure(Exception):
    pass


def check(condition, message):
    if not condition:
        raise SmokeFailure(message)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_client(cookies=False):
    # CI proxy settings must not send requests or fixture credentials elsewhere.
    handlers = [urllib.request.ProxyHandler({}), NoRedirects()]
    if cookies:
        handlers.append(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    return urllib.request.build_opener(*handlers)


def request(client, method, url, data=None, headers=None, timeout=3):
    headers = dict(headers or {})
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        url, method=method, headers=headers,
        data=None if data is None else json.dumps(data).encode(),
    )
    try:
        response = client.open(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_RESPONSE + 1)
        check(len(body) <= MAX_RESPONSE, "HTTP response exceeded the smoke test limit")
        return response.status, response.headers, body


def docker(step, *args, input=None, env=None, timeout=COMMAND_TIMEOUT, required=True):
    # Never echo arguments, captured config, HTTP bodies, or subprocess output.
    # In particular, init receives its password by environment name, not value.
    try:
        result = subprocess.run(
            ["docker", *args], input=input, env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise SmokeFailure(f"{step} timed out") from None
    except OSError:
        raise SmokeFailure(f"{step}: could not execute Docker") from None
    check(not required or result.returncode == 0,
          f"{step} failed (Docker exit {result.returncode})")
    return result


class Resources:
    def __init__(self, image):
        self.image = image
        self.owner = secrets.token_hex(12)
        self.prefix = f"artiface-smoke-{self.owner}"
        self.containers = []
        self.volumes = []
        self.server = None

    def volume(self, suffix):
        name = f"{self.prefix}-{suffix}"
        self.volumes.append(name)  # Also recover a create that times out.
        docker("create owned volume", "volume", "create",
               "--label", f"{OWNER_LABEL}={self.owner}", name)
        owner = docker("verify new volume ownership", "volume", "inspect", "--format",
                       '{{index .Labels "' + OWNER_LABEL + '"}}', name).stdout.strip()
        check(owner == self.owner, "Refusing to mount a volume owned by another run")
        return name

    def run(self, step, *command, options=(), detached=False, input=None, env=None):
        name = f"{self.prefix}-{len(self.containers)}"
        self.containers.append(name)
        flags = ["--detach"] if detached else ["--rm"]
        if input is not None:
            flags.append("--interactive")
        if detached:
            self.server = name
        result = docker(
            step, "run", "--pull=never", "--name", name,
            "--label", f"{OWNER_LABEL}={self.owner}",
            "--network", "bridge" if detached else "none",
            *flags, *options, self.image, *command, input=input, env=env,
        )
        return result.stdout

    def shell(self, step, script, options=(), input=None):
        return self.run(step, "-ec", script,
                        options=(*options, "--entrypoint", "/bin/sh"), input=input)

    def config(self, mount):
        return self.run("read private configuration", "/data/config.json",
                        options=(*mount, "--entrypoint", "/bin/cat"))

    def check_owner(self, mount, uid, gid):
        metadata = self.shell("inspect configuration and ignore-file ownership",
                              "stat -c '%u %g %a' /data/config.json /data/.artifaceignore\n"
                              "if test -e /data/config.ssh.json; then stat -c '%u %g %a' /data/config.ssh.json; fi", mount)
        fields = metadata.split()
        check(len(fields) in (6, 9) and fields == [uid, gid, "600"] * (len(fields) // 3),
              "Configuration, ignore rules, and SSH credentials must be owned by the image user with mode 0600")

    def wait_ready(self, origin):
        deadline = time.monotonic() + READY_TIMEOUT
        client = http_client()
        while time.monotonic() < deadline:
            running = docker(
                "check server readiness", "container", "inspect", "--format",
                "{{.State.Running}}", self.server,
                timeout=max(0.01, min(3, deadline - time.monotonic())),
            )
            check(running.stdout.strip() == "true", "Container exited before readiness")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                status, _, body = request(
                    client, "GET", origin + "/api/session", timeout=min(1, remaining),
                )
                if status == 200 and json.loads(body).get("authenticated") is False:
                    return
            except (OSError, urllib.error.URLError, ValueError):
                pass
            time.sleep(max(0, min(0.2, deadline - time.monotonic())))
        raise SmokeFailure("Container did not become ready within 20 seconds")

    def cleanup(self):
        failures = []
        # Never select resources globally, prune, or delete a mismatched owner.
        for kind, names, label_path in (
            ("container", reversed(self.containers), ".Config.Labels"),
            ("volume", reversed(self.volumes), ".Labels"),
        ):
            for name in names:
                try:
                    result = docker(
                        "inspect cleanup ownership", kind, "inspect", "--format",
                        '{{index ' + label_path + ' "' + OWNER_LABEL + '"}}', name,
                        required=False,
                    )
                    if result.returncode:
                        if "no such" in result.stderr.lower():
                            continue  # Successful --rm helpers are already gone.
                        raise SmokeFailure(f"could not inspect {name}")
                    check(result.stdout.strip() == self.owner,
                          f"refusing cleanup of resource with different owner: {name}")
                    if kind == "container" and name == self.server:
                        # A timed-out graceful stop must not prevent exact-name removal.
                        try:
                            docker("stop smoke server", "container", "stop",
                                   "--time", str(SHUTDOWN_TIMEOUT), name,
                                   timeout=SHUTDOWN_TIMEOUT + 5)
                        except SmokeFailure:
                            failures.append(f"graceful stop failed: {name}")
                    flags = ["--force"] if kind == "container" else []
                    docker("remove owned resource", kind, "rm", *flags, name)
                except SmokeFailure as error:
                    failures.append(str(error))
        return failures


def mount(volume, target, readonly=False):
    value = f"type=volume,source={volume},target={target}"
    return ("--mount", value + (",readonly" if readonly else ""))


def login(client, origin, password):
    status, headers, body = request(
        client, "POST", origin + "/api/login", {"password": password}, {"Origin": origin},
    )
    check(status == 200, "Six-character fixture password did not authenticate")
    session = json.loads(body)
    check(session.get("authenticated") is True and bool(session.get("csrfToken")),
          "Login did not establish an authenticated session")
    check("httponly" in headers.get("Set-Cookie", "").lower(),
          "Session cookie is missing HttpOnly")
    return {"Origin": origin, "X-CSRF-Token": session["csrfToken"]}


def read_note(client, origin, location):
    query = urllib.parse.urlencode({**location, "path": "note.txt"})
    status, headers, body = request(client, "GET", origin + "/api/file?" + query)
    check(status == 200 and body == NOTE, "Mounted local fixture could not be read")
    check(headers.get("Content-Disposition", "").startswith("attachment"),
          "Raw artifact was not served as an attachment")


def build_info(client, origin):
    status, _, body = request(client, "GET", origin + "/api/settings")
    check(status == 200, "Could not read application build metadata")
    info = json.loads(body)
    try:
        time.strptime(info.get("buildTime", ""), "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        check(False, "Container build did not embed a UTC compilation timestamp")
    check(info.get("gitCommit") == "unknown" or
          re.fullmatch(r"[a-f0-9]{40}(-dirty)?", info.get("gitCommit", "")),
          "Container build has invalid Git metadata")
    return info["gitCommit"], info["buildTime"]


def smoke(resources):
    check(sys.platform.startswith("linux"), "This smoke requires a Linux Docker host")
    image = json.loads(docker(
        "inspect built image", "image", "inspect", "--format", "{{json .Config}}",
        resources.image,
    ).stdout)
    check(bool(image.get("User")), "Image does not declare a non-root user")
    check(image.get("Entrypoint") == ["artiface"] and
          image.get("Cmd") == ["serve", "--config", "/data/config.json"],
          "Image entrypoint/default command does not match the runtime contract")
    image_env = dict(value.split("=", 1) for value in image.get("Env", []))
    check(image_env.get("ARTIFACE_LISTEN") == "0.0.0.0:8787" and
          image_env.get("ARTIFACE_APP_ORIGIN") == "http://127.0.0.1:8787",
          "Image is missing its initial network environment defaults")
    identity = resources.shell(
        "probe runtime user, HOME, OpenSSH, and ProxyCommand",
        'test "$HOME" = /home/artiface\n'
        "ssh -V >/dev/null 2>&1\n"
        "pdfinfo -v >/dev/null 2>&1\n"
        "pdftoppm -v >/dev/null 2>&1\n"
        "prlimit --version >/dev/null\n"
        # Check proxy execution using a file marker, not SSH's error wording.
        # This disposable helper has no network and reads no SSH configuration.
        "test ! -e /tmp/artiface-proxy-ran\n"
        "ssh -T -F /dev/null -o BatchMode=yes "
        "-o 'ProxyCommand=touch /tmp/artiface-proxy-ran; exit 1' "
        "example.invalid >/dev/null 2>&1 || true\n"
        "test -f /tmp/artiface-proxy-ran\n"
        "id -u\nid -g",
    ).split()
    check(len(identity) == 2 and all(value.isdecimal() for value in identity),
          "Image runtime identity could not be determined")
    uid, gid = identity
    check(int(uid) != 0, "Image runs as root")

    state = mount(resources.volume("state"), "/data")
    fixture = resources.volume("fixtures")
    resources.shell("prepare owned local fixtures", FIXTURES, mount(fixture, "/data"))
    resources.shell("prepare owned PDF fixture", "base64 -d > /data/project/report.pdf\nchmod 600 /data/project/report.pdf",
                    mount(fixture, "/data"), input=base64.b64encode(pdf_fixture()).decode("ascii"))
    ssh_fixture = resources.volume("ssh")
    resources.shell("prepare owned SSH configuration", SSH_FIXTURES, mount(ssh_fixture, "/data"))
    ssh_mount = mount(ssh_fixture, "/home/artiface/.ssh", True)
    password = "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(6))
    startup_env = {**os.environ, "ARTIFACE_PASSWORD": password}
    resolved = resources.run(
        "check OpenSSH resolves the same mounted alias", "-G", "fixture-alias",
        options=(*ssh_mount, "--entrypoint", "ssh"),
    )
    check("hostname example.invalid\n" in resolved and "user fixture-user\n" in resolved,
          "OpenSSH did not resolve the mounted home-relative Include")

    # Reserve only the published host port; the container has its own network.
    # Never read, bind, stop, or reconfigure the native app's listeners.
    with contextlib.ExitStack() as reservations:
        while True:
            sock = reservations.enter_context(socket.socket())
            sock.bind(("127.0.0.1", 0))
            app_port = sock.getsockname()[1]
            if app_port not in (8787, 8788):
                break
        origin = f"http://127.0.0.1:{app_port}"
    preview_origin = origin
    startup_env["ARTIFACE_APP_ORIGIN"] = origin
    resources.run("start with an empty data directory",
                  options=(*state, *mount(fixture, "/projects", True),
                           "--publish", f"127.0.0.1:{app_port}:8787",
                           "--env", "ARTIFACE_PASSWORD", "--env", "ARTIFACE_APP_ORIGIN"),
                  env=startup_env, detached=True)
    resources.wait_ready(origin)
    resources.check_owner(state, uid, gid)
    default_ignore = resources.shell("read startup ignore rules", "cat /data/.artifaceignore", state)
    check(".git/\n__pycache__/\n" in default_ignore,
          "Startup did not populate the default ignore rules")
    cfg = json.loads(resources.config(state))
    local_source = {"id": "local", "label": "localhost", "kind": "local", "target": "", "roots": []}
    check(cfg.get("passwordHash", "").startswith("$argon2id$") and cfg["hosts"] == [local_source] and
          cfg["listen"] == "0.0.0.0:8787" and cfg["appOrigin"] == origin,
          "Startup did not create a usable private configuration")
    startup_logs = docker("inspect first-start output", "logs", resources.server).stdout
    check(password not in startup_logs and "Initial password:" not in startup_logs,
          "Startup printed the supplied password")
    resources.run(
        "import mounted SSH aliases with a literal tilde path",
        "import-ssh", "--config", "/data/config.json", "--ssh-config", "~/.ssh/config",
        options=(*state, *ssh_mount, "--env", "ARTIFACE_PASSWORD"),
        env=startup_env,
    )
    cfg = json.loads(resources.config(state))
    check(cfg["hosts"][0] == local_source and
          any(host["target"] == "fixture-alias" and host["roots"] == [] for host in cfg["hosts"][1:]),
          "Tilde source or Include did not append the mounted SSH alias after localhost")
    credential_state = resources.shell("read separate encrypted credentials", "cat /data/config.ssh.json", state)
    encrypted = json.loads(credential_state)
    revision = cfg.get("sshCredentialsRevision")
    check(revision and set(encrypted["revisions"]) == {revision} and
          encrypted["revisions"][revision].get("version") == 1 and
          "sshCredentials" not in cfg and "ciphertext" not in json.dumps(cfg) and
          "PRIVATE KEY" not in json.dumps(cfg) and "fixture-user" not in json.dumps(cfg),
          "SSH import did not separate encrypted credentials from configuration")
    docker("restart with encrypted SSH configuration", "restart", resources.server)
    resources.wait_ready(origin)
    network = json.loads(docker(
        "inspect published port", "container", "inspect", "--format", "{{json .HostConfig}}",
        resources.server,
    ).stdout)
    check(network["NetworkMode"] == "bridge" and
          network["PortBindings"] == {"8787/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(app_port)}]},
          "Container must use a bridge and publish only its application port on loopback")

    mounts = json.loads(docker(
        "inspect project mount", "container", "inspect", "--format",
        "{{json .Mounts}}", resources.server,
    ).stdout)
    check(any(item["Destination"] == "/projects" and item["Name"] == fixture and
              item["RW"] is False for item in mounts), "Project volume is not mounted read-only")
    check(not any(item["Destination"].startswith("/home/artiface/.ssh") for item in mounts),
          "The runtime container must not mount SSH credentials")
    docker("verify read-only source", "exec", resources.server, "/bin/sh", "-ec",
           "test -r /projects/project/note.txt\n"
           "if (: > /projects/project/.write-probe) 2>/dev/null; then exit 1; fi\n"
           "test ! -e /projects/project/.write-probe")
    docker("verify SSH directory is absent at runtime", "exec", resources.server, "/bin/sh", "-ec",
           "test ! -e /home/artiface/.ssh/config\n"
           "test ! -e /home/artiface/.ssh/id_fixture")

    public = http_client()
    status, _, shell = request(public, "GET", origin + "/")
    check(status == 200 and b'id="root"' in shell, "Embedded application shell is missing")
    assets = set(re.findall(rb'(?:src|href)="(/assets/[^"]+\.(?:js|css))"', shell))
    check(any(path.endswith(b".js") for path in assets) and
          any(path.endswith(b".css") for path in assets), "Built frontend asset references are missing")
    for path in assets:
        status, headers, body = request(public, "GET", origin + path.decode("ascii"))
        check(status == 200 and body and "text/html" not in headers.get("Content-Type", ""),
              "Embedded JavaScript or stylesheet could not be loaded")
    for endpoint in ("hosts", "settings", "list", "file"):
        status, _, _ = request(public, "GET", origin + "/api/" + endpoint)
        check(status == 401, f"Unauthenticated {endpoint} API was not blocked")

    client = http_client(cookies=True)
    auth = login(client, origin, password)
    status, _, session = request(client, "GET", origin + "/api/session")
    check(status == 200 and json.loads(session).get("sshLocked") is False,
          "Admin sign-in did not unlock imported SSH credentials")
    build = build_info(client, origin)
    project = {"kind": "local", "target": "", "path": "/projects/project", "label": "Container fixture"}
    status, _, _ = request(client, "POST", origin + "/api/projects", project, {"Origin": origin})
    check(status == 403, "Project creation accepted a missing CSRF token")
    status, _, body = request(client, "POST", origin + "/api/projects", project, auth)
    check(status == 200, "Could not persist a local project in the config volume")
    saved = json.loads(body)
    check(saved["host"].get("kind") == "local" and saved["root"]["path"] == "/projects/project",
          "Project setup saved the wrong local source")
    location = {"host": saved["host"]["id"], "root": saved["root"]["id"]}
    status, _, body = request(client, "GET", origin + "/api/list?" + urllib.parse.urlencode(location))
    check(status == 200 and {"note.txt", "reports"} <=
          {entry["name"] for entry in json.loads(body)["entries"]}, "Local project listing failed")
    read_note(client, origin, location)
    status, _, body = request(client, "GET", origin + "/api/git/status?" + urllib.parse.urlencode(location))
    git_status = json.loads(body)
    check(status == 200 and git_status.get("state") == "ready"
          and any(change["path"] == ".git-probe.txt" and change["worktree"] == "M" for change in git_status.get("changes", [])),
          "Git status failed on the read-only container project mount")
    status, _, body = request(client, "GET", origin + "/api/git/diff?" + urllib.parse.urlencode({**location, "path": ".git-probe.txt"}))
    check(status == 200 and "+after Git inspection" in json.loads(body).get("patch", ""),
          "Git diff failed on the read-only container project mount")
    status, _, body = request(client, "POST", origin + "/api/pdf/info",
                              {**location, "path": "report.pdf"}, auth)
    check(status == 200, "Container could not prepare PDF Compression")
    compressed = json.loads(body)
    page_url = origin + "/api/pdf/page?" + urllib.parse.urlencode({
        **location, "path": "report.pdf", "document": compressed["id"], "page": 1, "size": 960,
    })
    status, headers, body = request(client, "GET", page_url)
    check(status == 200 and body.startswith(b"\xff\xd8") and headers.get("Content-Type") == "image/jpeg"
          and headers.get("Cache-Control") == "no-store", "Compressed PDF page did not render privately")
    status, _, _ = request(public, "GET", page_url)
    check(status == 401, "Compressed page bypassed authentication")

    status, _, body = request(
        client, "POST", origin + "/api/preview",
        {**location, "path": "reports/index.html"}, auth,
    )
    check(status == 200, "HTML preview creation failed")
    preview = json.loads(body)
    url = urllib.parse.urlsplit(preview["url"])
    check((url.scheme, url.netloc) == ("http", f"127.0.0.1:{app_port}") and
          url.path.startswith("/p/"), "Preview does not use the application URL under /p/")
    check(preview.get("scripts") is False, "Preview bypassed project script trust")
    status, headers, body = request(public, "GET", preview["url"])
    policy = headers.get("Content-Security-Policy", "")
    check(status == 200 and b"Container report" in body, "HTML preview content could not be read")
    nonce = re.search(r"(?:^|; )script-src 'nonce-([A-Za-z0-9_-]{43})';", policy)
    check(preview.get("bridge") is True and nonce is not None and
          body.count((' nonce="' + nonce.group(1) + '"').encode()) == 1 and
          policy.endswith("; sandbox allow-scripts") and "allow-same-origin" not in policy and
          "Set-Cookie" not in headers, "HTML preview lost its default isolation policy")
    status, _, body = request(
        public, "GET", urllib.parse.urljoin(preview["url"], "assets/style.css"),
    )
    check(status == 200 and b"color: navy" in body, "Report-relative asset could not be read")
    status, _, _ = request(public, "GET", preview_origin + "/api/hosts")
    check(status == 401, "Shared-origin application API accepted an anonymous request")
    status, headers, _ = request(
        public, "HEAD", preview_origin + "/p/healthz", headers={"Origin": origin},
    )
    check(status == 204 and headers.get("Access-Control-Allow-Origin") == origin,
          "Shared-origin preview health check failed")

    status, _, body = request(client, "POST", origin + "/api/workspace/projects", {"open": [location]}, auth)
    check(status == 200 and json.loads(body)["projects"] == [location],
          "Shared project could not be saved in the container")
    persisted = resources.config(state)
    check(json.loads(persisted)["passwordHash"] == cfg["passwordHash"],
          "Project setup changed the application password hash")
    resources.check_owner(state, uid, gid)
    custom_ignore = "# Custom container rules\ncustom-cache/\n"
    resources.shell("customize disposable ignore rules", "cat > /data/.artifaceignore", state, input=custom_ignore)
    docker("restart smoke server", "container", "restart", "--time", str(SHUTDOWN_TIMEOUT),
           resources.server, timeout=SHUTDOWN_TIMEOUT + 5)
    resources.wait_ready(origin)
    check(resources.config(state) == persisted, "Restart did not retain private configuration")
    check(resources.shell("read retained ignore rules", "cat /data/.artifaceignore", state) == custom_ignore,
          "Restart replaced custom ignore rules")
    status, _, _ = request(client, "GET", origin + "/api/hosts")
    check(status == 401, "Restart retained an old authenticated session")
    status, _, _ = request(public, "GET", preview["url"])
    check(status == 401, "Restart retained an old preview capability")
    client = http_client(cookies=True)
    login(client, origin, password)
    read_note(client, origin, location)
    check(build_info(client, origin) == build, "Restart changed the compilation timestamp or Git commit")
    status, _, body = request(client, "GET", origin + "/api/workspace/projects")
    check(status == 200 and json.loads(body)["projects"] == [location],
          "Container restart lost the shared project list")

    # A separate preview hostname remains optional on the same published port.
    cfg = json.loads(resources.config(state))
    cfg["previewOrigin"] = f"http://localhost:{app_port}"
    resources.shell("configure optional preview origin", "cat > /data/config.json",
                    state, input=json.dumps(cfg) + "\n")
    resources.shell("disable disposable ignore rules", ": > /data/.artifaceignore", state)
    docker("restart with optional preview origin", "container", "restart",
           "--time", str(SHUTDOWN_TIMEOUT), resources.server, timeout=SHUTDOWN_TIMEOUT + 5)
    resources.wait_ready(origin)
    check(resources.shell("read empty ignore rules", "cat /data/.artifaceignore", state) == "",
          "Restart replaced intentionally empty ignore rules")
    client = http_client(cookies=True)
    auth = login(client, origin, password)
    status, _, body = request(client, "POST", origin + "/api/preview",
                              {**location, "path": "reports/index.html"}, auth)
    check(status == 200, "Optional separate preview could not be created")
    separate = json.loads(body)["url"]
    check(separate.startswith(cfg["previewOrigin"] + "/p/"),
          "Explicit separate preview origin was ignored")
    status, _, body = request(public, "GET", separate)
    check(status == 200 and b"Container report" in body,
          "Optional preview hostname could not reach the same published port")

    # Missing ignore files are recreated on restart.
    persisted = resources.config(state)
    resources.shell("remove disposable ignore rules", "rm /data/.artifaceignore", state)
    docker("restart to recreate missing ignore file", "container", "restart",
           "--time", str(SHUTDOWN_TIMEOUT), resources.server, timeout=SHUTDOWN_TIMEOUT + 5)
    resources.wait_ready(origin)
    resources.check_owner(state, uid, gid)
    check(resources.shell("read recreated default ignores", "cat /data/.artifaceignore", state) == default_ignore,
          "Restart with an existing configuration did not recreate missing ignore rules")
    check(resources.config(state) == persisted, "Ignore initialization changed an existing configuration")

    # Disabled SSH is a startup policy; owner login cannot unlock or enable it.
    docker("stop Personal mode", "container", "stop", "--time", str(SHUTDOWN_TIMEOUT),
           resources.server, timeout=SHUTDOWN_TIMEOUT + 5)
    resources.run("start with SSH disabled by environment",
                  options=(*state, *mount(fixture, "/projects", True),
                           "--publish", f"127.0.0.1:{app_port}:8787", "--env", "ARTIFACE_DISABLE_SSH=true"), detached=True)
    resources.wait_ready(origin)
    client = http_client(cookies=True)
    auth = login(client, origin, password)
    status, _, body = request(client, "GET", origin + "/api/settings")
    check(status == 200 and json.loads(body).get("sshDisabled") is True and
          json.loads(body).get("sshLocked") is True,
          "Owner login bypassed disabled SSH or unlocked credentials")
    read_note(client, origin, location)
    status, _, body = request(client, "GET", origin + "/api/git/status?" + urllib.parse.urlencode(location))
    check(status == 200 and json.loads(body).get("state") == "ready",
          "Disabling SSH also disabled local Git status")
    status, _, body = request(client, "GET", origin + "/api/git/diff?" + urllib.parse.urlencode({**location, "path": ".git-probe.txt"}))
    check(status == 200 and "+after Git inspection" in json.loads(body).get("patch", ""),
          "Disabling SSH also disabled local Git diffs")
    status, _, body = request(client, "POST", origin + "/api/folders",
                              {"target": "fixture-alias", "path": "/"}, auth)
    check(status == 503 and b"SSH connectivity is disabled" in body,
          "Disabled SSH reached the remote folder picker")
    check(resources.config(state) == persisted, "Disabling SSH rewrote existing configuration")

    # The same policy applies in Team mode, including its separate admin login.
    docker("stop disabled Personal mode", "container", "stop", "--time", str(SHUTDOWN_TIMEOUT),
           resources.server, timeout=SHUTDOWN_TIMEOUT + 5)
    resources.run("start Team mode with existing configuration",
                  options=(*state, *mount(fixture, "/projects", True),
                           "--publish", f"127.0.0.1:{app_port}:8787", "--env", "ARTIFACE_MODE=team",
                           "--env", "ARTIFACE_DISABLE_SSH=true"),
                  detached=True)
    resources.wait_ready(origin)
    check(resources.config(state) == persisted, "Team startup rewrote the existing configuration")
    status, _, body = request(public, "GET", origin + "/api/session")
    check(status == 200 and json.loads(body).get("mode") == "team", "Container ignored Team startup mode")
    status, _, _ = request(public, "POST", origin + "/api/login", {"password": password}, {"Origin": origin})
    check(status == 401, "Admin password entered the team workspace without a username")
    admin = http_client(cookies=True)
    status, _, body = request(admin, "POST", origin + "/api/admin/login", {"password": password}, {"Origin": origin})
    check(status == 200, "Could not authenticate the Team admin")
    admin_auth = {"Origin": origin, "X-CSRF-Token": json.loads(body)["csrfToken"]}
    status, _, body = request(admin, "GET", origin + "/api/admin/settings")
    check(status == 200 and json.loads(body).get("sshDisabled") is True and
          json.loads(body).get("sshLocked") is True, "Team admin bypassed disabled SSH")
    status, _, body = request(admin, "GET", origin + "/api/admin/access")
    check(status == 200, "Could not load Team access settings")
    status, _, body = request(admin, "POST", origin + "/api/admin/access", {
        "revision": json.loads(body)["revision"],
        "user": {"username": "reader", "password": password, "projects": [location]},
    }, admin_auth)
    check(status == 200 and b"passwordHash" not in body, "Could not create a private Team account")
    reader = http_client(cookies=True)
    status, _, body = request(reader, "POST", origin + "/api/login",
                              {"username": "reader", "password": password}, {"Origin": origin})
    check(status == 200 and json.loads(body).get("role") == "user", "Team user could not sign in")
    reader_auth = {"Origin": origin, "X-CSRF-Token": json.loads(body)["csrfToken"]}
    read_note(reader, origin, location)
    status, _, body = request(reader, "GET", origin + "/api/hosts")
    check(status == 200 and json.loads(body).get("setupEnabled") is False and b"fixture-alias" not in body,
          "Team catalog exposed machine management")
    status, _, _ = request(reader, "POST", origin + "/api/projects", project, reader_auth)
    check(status == 403, "Team user could create a project")
    status, _, _ = request(reader, "GET", origin + "/api/admin/access")
    check(status == 401, "Team user cookie authenticated the admin panel")
    resources.check_owner(state, uid, gid)

    # Explicit false restores the normal unlock flow without reimport.
    retained = resources.config(state)
    docker("stop disabled Team mode", "container", "stop", "--time", str(SHUTDOWN_TIMEOUT),
           resources.server, timeout=SHUTDOWN_TIMEOUT + 5)
    resources.run("restart Team mode with SSH enabled",
                  options=(*state, *mount(fixture, "/projects", True),
                           "--publish", f"127.0.0.1:{app_port}:8787", "--env", "ARTIFACE_MODE=team",
                           "--env", "ARTIFACE_DISABLE_SSH=false"),
                  detached=True)
    resources.wait_ready(origin)
    admin = http_client(cookies=True)
    status, _, _ = request(admin, "POST", origin + "/api/admin/login", {"password": password}, {"Origin": origin})
    check(status == 200, "Could not unlock SSH after setting ARTIFACE_DISABLE_SSH=false")
    status, _, body = request(admin, "GET", origin + "/api/admin/settings")
    check(status == 200 and json.loads(body).get("sshDisabled") is False and
          json.loads(body).get("sshLocked") is False, "ARTIFACE_DISABLE_SSH=false did not restore SSH unlock")
    check(resources.config(state) == retained, "Re-enabling SSH changed saved credentials or accounts")
    check(resources.shell("verify retained SSH sidecar", "cat /data/config.ssh.json", state) == credential_state,
          "Settings edits or restarts changed the encrypted SSH file")


def interrupted(signum, frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="artiface:ci", help="Already-built image (default: artiface:ci)")
    args = parser.parse_args()
    resources = Resources(args.image)
    signal.signal(signal.SIGTERM, interrupted)
    passed = False
    try:
        smoke(resources)
        passed = True
    except SmokeFailure as error:
        print(f"FAIL: {error}", file=sys.stderr)
    except KeyboardInterrupt:
        print("FAIL: container smoke interrupted", file=sys.stderr)
    except Exception as error:
        # Avoid tracebacks containing captured fixture credentials or capabilities.
        print(f"FAIL: unexpected {type(error).__name__} during container smoke", file=sys.stderr)
    finally:
        failures = resources.cleanup()
        for failure in failures:
            print(f"FAIL: cleanup: {failure}", file=sys.stderr)
        passed = passed and not failures
    if passed:
        print("PASS: non-root bridge image, loopback-only publishing, automatic private configuration and ignore rules, "
              "read-only local projects, one-time encrypted SSH import without runtime SSH mounts, admin unlock, "
              "shared-origin sandboxed previews, PDF Compression, optional separate origin, restart, "
              "Personal/Team SSH-disable policy and re-enabling, and Team-mode access")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
