#!/usr/bin/env python3
"""Exercise the real app against an isolated, temporary OpenSSH server."""

import argparse
import base64
import contextlib
import csv
import http.cookiejar
import io
import json
import os
from pathlib import Path
import pwd
import secrets
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


REPO = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def free_ports(count):
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(count)]
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]


def svg_fixture():
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">'
        '<rect width="200" height="80" fill="#0f766e"/>'
        '<text x="12" y="45" fill="white">Local artifact</text>'
        '<script><![CDATA[try { parent.artifaceSVGExecuted = true; } catch {}'
        "fetch('svg-script-executed');]]></script></svg>"
    )


def pdf_fixture(title="Artiface PDF smoke test", pages=1, width=400, height=200, stamp=False, outline=False):
    kids = " ".join(f"{3 + i * 3} 0 R" for i in range(pages))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode(),
    ]
    for i in range(pages):
        label = title if pages == 1 else f"{title} page {i + 1}"
        stream = f"BT /F1 20 Tf 40 {height - 80} Td ({label}) Tj ET".encode("ascii")
        annotation = f"/Annots [{3 + pages * 3} 0 R]" if stamp else ""
        objects.extend([
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Resources << /Font << /F1 {4 + i * 3} 0 R >> >> /Contents {5 + i * 3} 0 R {annotation} >>".encode(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        ])
    if stamp:
        appearance = b"1 0 0 rg 0 0 120 40 re f"
        objects.extend([
            f"<< /Type /Annot /Subtype /Stamp /Rect [240 20 360 60] /F 4 /AP << /N {4 + pages * 3} 0 R >> >>".encode(),
            b"<< /Type /XObject /Subtype /Form /BBox [0 0 120 40] /Resources << >> /Length "
            + str(len(appearance)).encode() + b" >>\nstream\n" + appearance + b"\nendstream",
        ])
    if outline:
        root = len(objects) + 1
        objects[0] = f"<< /Type /Catalog /Pages 2 0 R /Outlines {root} 0 R >>".encode()
        objects.extend([
            f"<< /Type /Outlines /First {root + 1} 0 R /Last {root + 2} 0 R /Count 2 >>".encode(),
            f"<< /Title (Beginning) /Parent {root} 0 R /Next {root + 2} 0 R /Dest [3 0 R /Fit] >>".encode(),
            f"<< /Title (Final section) /Parent {root} 0 R /Prev {root + 1} 0 R /Dest [{3 + (pages - 1) * 3} 0 R /Fit] >>".encode(),
        ])
    data, offsets = b"%PDF-1.4\n", [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(data)
    data += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets[1:]:
        data += f"{offset:010d} 00000 n \n".encode()
    data += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return data


def write_browse_fixtures(root):
    files = {
        "plain.txt": "Visible plain text.\n",
        "left/shared.md": "# Left shared note\n",
        "right/shared.md": "# Right shared note\n",
        "left/large.txt": "A larger sortable nested fixture.\n" * 256,
        "right/example.py": "answer = 42\n",
        "left/report.html": "<!doctype html><h1>Nested HTML report</h1>",
        ".hidden.md": "# Hidden flat note\n",
        ".hidden-folder/secret.md": "# Hidden folder note\n",
        "left/.nested-hidden/secret.md": "# Nested hidden folder note\n",
        "__pycache__/cached.py": "cached = True\n",
        "node_modules/package/index.js": "export default 42;\n",
        "left/__pycache__/cached.py": "cached = True\n",
        "left/node_modules/package/index.js": "export default 42;\n",
        ".git/config": "[core]\n",
        "left/.git/config": "[core]\n",
        ".venv/installed.txt": "Virtual environment fixture.\n",
    }
    for relative, contents in files.items():
        filename = root / "browse-checks" / relative
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(contents)


def write_fixtures(root, app_origin):
    assets = root / "reports" / "assets"
    assets.mkdir(parents=True)
    (root / "outside.txt").write_text("outside the HTML capability")
    (root.parent / "project-outside.txt").write_text("outside the configured SSH project")
    (root / "reports" / "escape").symlink_to(root / "outside.txt")
    (root / "reports" / "project-escape").symlink_to(root.parent / "project-outside.txt")
    (assets / "project-escape.json").symlink_to(root.parent / "project-outside.txt")
    (assets / "data.json").write_text('{"answer":42}')
    (assets / "app-probe.js").write_text("window.artifacePreviewExecutedInApp = true;\n")
    (assets / "data-alias.json").symlink_to("data.json")
    (assets / "style.css").write_text("body{font:18px system-ui;padding:24px;color:#134e4a}")
    (assets / "plot.svg").write_text(svg_fixture())
    (assets / "script.js").write_text(
        "fetch('./assets/data.json').then(r=>r.json()).then(d=>document.querySelector('#answer').textContent=String(d.answer));\n"
        "try { document.cookie; document.querySelector('#cookies').textContent='accessible'; }"
        "catch { document.querySelector('#cookies').textContent='isolated'; }\n"
        f"fetch({json.dumps(app_origin + '/api/hosts')},{{credentials:'include'}})"
        ".then(()=>document.querySelector('#api').textContent='accessible')"
        ".catch(()=>document.querySelector('#api').textContent='blocked');\n"
    )
    (root / "reports" / "index.html").write_text(
        '<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head>'
        '<body><h1>SSH report fixture</h1><img src="assets/plot.svg" alt="Local plot">'
        '<p>Answer: <b id="answer">loading</b></p><p id="cookies"></p><p id="api"></p>'
        '<script src="assets/script.js"></script></body></html>'
    )
    (root / "reports" / "second.html").write_text(
        (root / "reports" / "index.html").read_text().replace("SSH report fixture", "Second SSH report")
    )
    (root / "reports" / "notes.md").write_text(
        "# Experiment notes\n\nA **remote artifact** with math: $E = mc^2$.\n\n"
        "![Local plot](assets/plot.svg)\n\n| Metric | Value |\n| --- | --- |\n| Score | 42 |\n\n"
        '<img src="missing" onerror="window.artifaceXSS=true">\n\n'
        "[Report](index.html)\n"
    )
    (root / "reports" / "example.py").write_text('def experiment():\n    return {"score": 42}\n')
    (root / "reports" / "example.ts").write_text("export const score = 42;\n")
    csv_output = io.StringIO()
    csv.writer(csv_output).writerows([
        ["metric", "value", "notes"],
        ["score", "42", "left, right"],
        ["quoted", 'He said "hello"', "line one\nline two"],
        ["markup", '<img src=x onerror="window.csvExecuted=true">', "=1+1"],
        *[[f"record-{i}", str(i), ""] for i in range(1, 121)],
    ])
    (root / "reports" / "metrics.csv").write_text(csv_output.getvalue())
    (root / "reports" / "run.sh").write_text("#!/bin/sh\nprintf 'hello\\n'\n")
    (root / "reports" / "settings.yaml").write_text("batch_size: 32\n")
    (root / "reports" / "result.json").write_text('{"score": 42}\n')
    (root / "reports" / ".hidden.md").write_text("# Hidden fixture\n")
    (root / "reports" / "checkpoint.pt").write_bytes(bytes(range(256)))
    (root / "reports" / "sorting-large.txt").write_text("A larger sortable fixture.\n" * 512)
    nested = root / "reports" / "experiments" / "run-a"
    nested.mkdir(parents=True)
    (nested / "summary.md").write_text("# Nested experiment\n\nA folder-picker fixture.\n")
    (root / "reports" / "report.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nArtiface test.\n\\end{document}\n"
    )
    (root / "reports" / "report.pdf").write_bytes(pdf_fixture())
    (root / "reports" / "reader-pages.pdf").write_bytes(pdf_fixture("Mobile PDF fixture", pages=3, width=595, height=842, outline=True))
    (root / "reports" / "long-reader.pdf").write_bytes(pdf_fixture("Long PDF fixture", pages=50, width=595, height=842, outline=True))
    # Exercise URL encoding and UTF-8 names without assuming shell-safe paths.
    (root / "reports" / "résultats #1.md").write_text("# Encoded artifact\n\nA UTF-8 path.\n")
    (root / "reports" / "binary.dat").write_bytes(bytes([0, 1, 2, 3]))
    (assets / "pixel.png").write_bytes(base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="
    ))
    for name, target in {
        "notes-link.md": "notes.md",
        "notes-absolute.md": str(root / "reports" / "notes.md"),
        "notes-chain.md": "notes-link.md",
        "experiments-link": "experiments",
        "index-alias.html": "index.html",
        "broken-link": "missing-target",
        "cycle-a": "cycle-b",
        "cycle-b": "cycle-a",
    }.items():
        (root / "reports" / name).symlink_to(target)
    (root / "alias-report.html").symlink_to("reports/index.html")
    write_browse_fixtures(root / "reports")


def write_local_fixtures(root):
    project = root / "projects" / "local-report"
    project.mkdir(parents=True)
    (project / "notes.md").write_text("# Local dispatch notes\n\nRead directly from the server machine.\n")
    (project / "report.pdf").write_bytes(pdf_fixture("Artiface local PDF smoke test", stamp=True))
    (project / "plot.SVG").write_text(svg_fixture())
    (project / "records.tsv").write_text('id\tlabel\tvalue\n1\t"two\tfields"\t007\n2\tplain\t8\n')
    (root / "outside.txt").write_text("Outside the configured local project")
    (project / "escape").symlink_to(root / "outside.txt")
    (project / "nested").mkdir()
    (project / "nested" / "child.md").write_text("# Local nested note\n")
    for name, target in {
        "notes-link.md": "notes.md",
        "notes-absolute.md": str(project / "notes.md"),
        "notes-chain.md": "notes-link.md",
        "nested-link": "nested",
        "broken-link": "missing-target",
        "cycle-a": "cycle-b",
        "cycle-b": "cycle-a",
    }.items():
        (project / name).symlink_to(target)
    write_browse_fixtures(project)
    return project


def request(opener, method, url, *, data=None, headers=None):
    body = json.dumps(data).encode() if data is not None else None
    headers = dict(headers or {})
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        response = opener.open(req, timeout=30)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        return response.status, response.headers, response.read()


def wait_for(url, process):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError("Test server exited before becoming ready")
        try:
            urllib.request.urlopen(url, timeout=0.5).close()
            return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError("Timed out waiting for test server")


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def check_recursive_listing(opener, app_origin, file_query, directory):
    visible = {
        "plain.txt", "left/shared.md", "right/shared.md", "left/large.txt",
        "right/example.py", "left/report.html",
    }
    hidden = {".hidden.md", ".hidden-folder/secret.md", "left/.nested-hidden/secret.md"}
    for show_hidden in (0, 1):
        status, _, body = request(
            opener, "GET", app_origin + "/api/list?" + file_query(directory)
            + f"&recursive=1&showHidden={show_hidden}",
        )
        check(status == 200, f"Recursive listing failed ({status}): {body[:500]!r}")
        listing = json.loads(body)
        entries = listing["entries"]
        expected = {f"{directory}/{name}" for name in visible | (hidden if show_hidden else set())}
        check(listing["path"] == directory and not listing.get("truncated"),
              "Small recursive fixture returned the wrong directory or a partial listing")
        check(len(entries) == len(expected) and {entry["path"] for entry in entries} == expected,
              f"Recursive paths, hidden handling, or default cache rules failed: {entries!r}")
        check(all(entry["type"] == "file" for entry in entries),
              "Recursive listing returned folders or unavailable entries")
    status, _, body = request(opener, "GET", app_origin + "/api/file?"
                             + file_query(directory + "/left/__pycache__/cached.py"))
    check(status == 200 and body == b"cached = True\n",
          "Browse ignore rules blocked direct file access")


def smoke(binary, browser):
    sshd = shutil.which("sshd") or "/usr/sbin/sshd"
    check(Path(sshd).is_file(), "OpenSSH server is required for this integration test")
    ssh = shutil.which("ssh")
    check(ssh is not None, "OpenSSH client is required")
    ssh_port, app_port = free_ports(2)
    app_origin = f"http://127.0.0.1:{app_port}"
    processes = []
    # Keep the authorized_keys ancestry owner-controlled so sshd StrictModes
    # remains enabled even when /tmp has unusual ownership in a sandbox.
    local_dir = (REPO / ".local").resolve()
    local_dir.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ssh-smoke-", dir=local_dir) as tmp:
        task_dir = Path(tmp)
        try:
            for name in ("host_key", "client_key"):
                run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(task_dir / name))
            authorized = task_dir / "authorized_keys"
            authorized.write_text((task_dir / "client_key.pub").read_text())
            authorized.chmod(0o600)
            known_hosts = task_dir / "known_hosts"
            known_hosts.write_text(f"[127.0.0.1]:{ssh_port} " + (task_dir / "host_key.pub").read_text())
            sshd_config = task_dir / "sshd_config"
            sshd_config.write_text(
                f"Port {ssh_port}\nListenAddress 127.0.0.1\nHostKey {task_dir / 'host_key'}\n"
                f"PidFile {task_dir / 'sshd.pid'}\nAuthorizedKeysFile {authorized}\n"
                "PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n"
                "PermitRootLogin prohibit-password\nStrictModes yes\n"
                "Subsystem sftp internal-sftp\nLogLevel ERROR\n"
            )
            discovery_home = task_dir / "discovery-home"
            discovery_ssh = discovery_home / ".ssh"
            discovery_ssh.mkdir(mode=0o700, parents=True)
            ssh_config = discovery_ssh / "config"
            ssh_config.write_text(
                f"Host artiface-smoke artiface-spare artiface-discovered\n HostName 127.0.0.1\n Port {ssh_port}\n"
                f" User {pwd.getpwuid(os.getuid()).pw_name}\n IdentityFile {task_dir / 'client_key'}\n"
                f" UserKnownHostsFile {known_hosts}\n IdentitiesOnly yes\n"
            )
            wrapper_dir = task_dir / "bin"
            wrapper_dir.mkdir()
            wrapper = wrapper_dir / "ssh"
            wrapper.write_text(f"#!/bin/sh\nexec {shlex.quote(ssh)} -F {shlex.quote(str(ssh_config))} \"$@\"\n")
            wrapper.chmod(0o700)
            test_env = os.environ.copy()
            test_env["PATH"] = str(wrapper_dir) + os.pathsep + test_env["PATH"]
            password = secrets.token_urlsafe(24)
            config_path = task_dir / "config.json"
            run(str(binary), "init", "--config", str(config_path), env={**test_env, "ARTIFACE_PASSWORD": password})
            cfg = json.loads(config_path.read_text())
            artifacts = task_dir / "artifacts"
            write_fixtures(artifacts, app_origin)
            git_probe = artifacts / ".git check ' + ü.txt"
            git_probe.write_text("before Git inspection\n")
            git_env = {**test_env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_COUNT": "0"}
            run("git", "-C", str(artifacts), "init", "-b", "main", env=git_env)
            run("git", "-C", str(artifacts), "add", "--", git_probe.name, env=git_env)
            run("git", "-C", str(artifacts), "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid",
                "commit", "-m", "Git inspection fixture", env=git_env)
            git_probe.write_text("after Git inspection\n")
            local_artifacts = task_dir / "local-artifacts"
            local_project = write_local_fixtures(local_artifacts)
            cfg.update({
                "listen": f"127.0.0.1:{app_port}",
                "hosts": [{"id": "smoke", "label": "SSH fixture", "target": "artiface-smoke",
                           "roots": [{"id": "artifacts", "label": "Artifacts", "path": str(artifacts)}]}],
            })
            config_path.write_text(json.dumps(cfg, indent=2) + "\n")
            check(config_path.stat().st_mode & 0o077 == 0, "Configuration permissions are too broad")
            run(str(binary), "import-ssh", "--config", str(config_path), "--ssh-config", str(ssh_config),
                env={**os.environ, "ARTIFACE_PASSWORD": password})
            imported = json.loads(config_path.read_text())
            check(imported["passwordHash"] == cfg["passwordHash"], "SSH import changed the password hash")
            check(imported["hosts"][0] == cfg["hosts"][0], "SSH import changed the existing host or project")
            spare = next(host for host in imported["hosts"] if host["target"] == "artiface-spare")
            check(spare["roots"] == [], "SSH import granted a folder without user selection")
            run(str(binary), "import-ssh", "--config", str(config_path), "--ssh-config", str(ssh_config),
                env={**os.environ, "ARTIFACE_PASSWORD": password})
            repeated = json.loads(config_path.read_text())
            check(repeated.pop("sshCredentialsRevision") != imported.pop("sshCredentialsRevision"),
                  "Repeated import reused its encryption envelope")
            check(repeated == imported, "Repeated SSH import changed sources or accounts")
            check("sshCredentials" not in repeated and "ciphertext" not in config_path.read_text(),
                  "Encrypted credentials were embedded in the application configuration")
            credential_file = config_path.with_suffix(".ssh.json")
            check(credential_file.is_file() and credential_file.stat().st_mode & 0o077 == 0,
                  "Separate SSH credentials are missing or not private")
            original_ssh_config = ssh_config.read_bytes()
            with (task_dir / "sshd.log").open("w") as ssh_log, (task_dir / "app.log").open("w") as app_log:
                ssh_process = subprocess.Popen([sshd, "-D", "-e", "-f", str(sshd_config)], stdout=ssh_log, stderr=ssh_log)
                processes.append(ssh_process)
                # Runtime must not depend on the import directory or system SSH.
                empty_home = task_dir / "runtime-home"
                empty_home.mkdir(mode=0o700)
                app_process = subprocess.Popen([str(binary), "serve", "--config", str(config_path)],
                                               env={**os.environ, "HOME": str(empty_home)},
                                               stdout=app_log, stderr=app_log)
                processes.append(app_process)
                wait_for(app_origin + "/api/session", app_process)
                time.sleep(0.2)
                check(ssh_process.poll() is None, "Isolated SSH server exited")
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                file_query = lambda rel: urllib.parse.urlencode({"host": "smoke", "root": "artifacts", "path": rel})
                status, _, _ = request(opener, "GET", app_origin + "/api/list?" + file_query(""))
                check(status == 401, "Unauthenticated directory access was accepted")
                status, _, _ = request(opener, "GET", app_origin + "/api/file-info?" + file_query("reports/notes.md"))
                check(status == 401, "Unauthenticated file metadata access was accepted")
                status, _, _ = request(opener, "GET", app_origin + "/api/settings")
                check(status == 401, "Unauthenticated settings access was accepted")
                status, _, _ = request(opener, "POST", app_origin + "/api/folders",
                                       data={"kind": "local", "path": str(local_artifacts)},
                                       headers={"Origin": app_origin})
                check(status == 401, "Unauthenticated folder-picker access was accepted")
                status, _, body = request(opener, "POST", app_origin + "/api/login",
                                           data={"password": password}, headers={"Origin": app_origin})
                check(status == 200, "Password login failed")
                csrf = json.loads(body)["csrfToken"]
                auth = {"Origin": app_origin, "X-CSRF-Token": csrf}
                status, _, body = request(opener, "GET", app_origin + "/api/git/status?" + file_query(""))
                git_status = json.loads(body)
                check(status == 200 and git_status.get("state") == "ready" and git_status.get("branch") == "main",
                      f"Real SSH Git status failed ({status}): {body.decode(errors='replace')[:500]}")
                check(any(change["path"] == git_probe.name and change["worktree"] == "M"
                          for change in git_status["changes"]), "SSH Git status missed the changed fixture")
                status, _, body = request(opener, "GET", app_origin + "/api/git/diff?" + file_query(git_probe.name))
                check(status == 200 and "+after Git inspection" in json.loads(body).get("patch", ""),
                      f"Real SSH Git diff failed ({status}): {body.decode(errors='replace')[:500]}")
                status, _, _ = request(opener, "POST", app_origin + "/api/folders",
                                       data={"kind": "local", "path": str(local_artifacts)},
                                       headers={"Origin": app_origin})
                check(status == 403, "Folder-picker request without CSRF was accepted")
                status, _, body = request(opener, "GET", app_origin + "/api/list?" + file_query("reports"))
                check(status == 200 and b"notes.md" in body,
                      f"Real SFTP directory browsing failed ({status}): {body.decode(errors='replace')[:500]}")
                listing = {entry["name"]: entry for entry in json.loads(body)["entries"]}
                for alias, canonical, kind in (
                    ("notes-link.md", "reports/notes.md", "file"),
                    ("notes-absolute.md", "reports/notes.md", "file"),
                    ("notes-chain.md", "reports/notes.md", "file"),
                    ("experiments-link", "reports/experiments", "directory"),
                    ("index-alias.html", "reports/index.html", "file"),
                    ("escape", "outside.txt", "file"),
                ):
                    entry = listing[alias]
                    check(entry["type"] == kind and entry["symlink"] is True
                          and entry["resolvedPath"] == canonical,
                          f"Contained SSH link did not expose its canonical target: {alias}")
                for alias in ("project-escape", "broken-link", "cycle-a", "cycle-b"):
                    check(listing[alias]["type"] == "symlink" and not listing[alias].get("resolvedPath"),
                          f"Unavailable SSH link became openable: {alias}")
                status, _, body = request(opener, "GET", app_origin + "/api/ignore")
                ignore_document = json.loads(body)
                check(status == 200 and set(ignore_document) == {"content", "revision", "path", "editable"}
                      and ignore_document["editable"] is True and bool(ignore_document["revision"]),
                      "Global ignore editor did not expose its editable document and revision")
                check(Path(ignore_document["path"]) == task_dir / ".artifaceignore"
                      and (task_dir / ".artifaceignore").read_text() == ignore_document["content"],
                      "Startup did not persist default ignores beside the isolated configuration")
                check_recursive_listing(opener, app_origin, file_query, "reports/browse-checks")
                status, headers, body = request(opener, "GET", app_origin + "/api/file-info?" + file_query("reports/report.pdf"))
                metadata = json.loads(body)
                check(status == 200 and headers.get("Cache-Control") == "no-store",
                      "Real SFTP metadata polling failed or allowed caching")
                check(set(metadata) == {"name", "path", "type", "size", "modified", "version", "trustedScripts"}
                      and metadata["name"] == "report.pdf" and metadata["path"] == "reports/report.pdf"
                      and metadata["type"] == "file" and metadata["trustedScripts"] is False
                      and metadata["size"] == (artifacts / "reports" / "report.pdf").stat().st_size,
                      "Metadata endpoint returned unexpected fields or file identity")
                status, _, body = request(opener, "GET", app_origin + "/api/file-info?" + file_query("reports/report.pdf"))
                check(status == 200 and json.loads(body)["version"] == metadata["version"],
                      "Unchanged real SFTP metadata produced an unstable version")
                status, headers, body = request(opener, "GET", app_origin + "/api/file?" + file_query("reports/report.pdf"),
                                                headers={"Range": "bytes=0-4"})
                check(status == 206 and body == b"%PDF-", "Real SFTP PDF range request failed")
                for alias in ("notes-link.md", "notes-absolute.md", "notes-chain.md"):
                    status, _, body = request(opener, "GET", app_origin + "/api/file?" + file_query("reports/" + alias))
                    check(status == 200 and body == (artifacts / "reports" / "notes.md").read_bytes(),
                          f"Contained SSH file link was not readable: {alias}")
                status, _, body = request(opener, "GET", app_origin + "/api/list?" + file_query("reports/experiments-link"))
                check(status == 200 and b"run-a" in body, "Contained SSH directory link was not browsable")
                status, _, body = request(opener, "GET", app_origin + "/api/file?" + file_query("reports/escape"))
                check(status == 200 and body == (artifacts / "outside.txt").read_bytes(),
                      "A link inside the project was incorrectly rejected by the file API")
                for rel in ("../project-outside.txt", "reports/project-escape", "reports/broken-link", "reports/cycle-a"):
                    for endpoint in ("file", "file-info"):
                        status, _, _ = request(opener, "GET", app_origin + f"/api/{endpoint}?" + file_query(rel))
                        check(status == 403, f"An escaping, missing, or cyclic SSH link was accepted by {endpoint}: {rel}")
                status, _, body = request(opener, "POST", app_origin + "/api/preview",
                                           data={"host": "smoke", "root": "artifacts", "path": "alias-report.html"}, headers=auth)
                check(status == 200, "HTML preview creation failed")
                preview = json.loads(body)
                preview_url = preview["url"]
                check(preview["path"] == "reports/index.html" and preview["scripts"] is False,
                      "HTML preview did not canonicalize its alias or honor project script trust")
                preview_origin = app_origin
                check(preview_url.startswith(preview_origin + "/p/"),
                      "Default HTML preview does not share the application origin")
                status, health_headers, _ = request(opener, "HEAD", preview_origin + "/p/healthz",
                                                    headers={"Origin": app_origin})
                check(status == 204 and health_headers.get("Access-Control-Allow-Origin") == app_origin,
                      "Same-port preview health check failed or omitted application CORS")
                status, _, body = request(opener, "GET", urllib.parse.urljoin(preview_url, "assets/data.json"))
                check(status == 200 and json.loads(body)["answer"] == 42, "Relative report asset failed")
                status, _, body = request(opener, "GET", urllib.parse.urljoin(preview_url, "assets/data-alias.json"))
                check(status == 200 and json.loads(body)["answer"] == 42, "Contained preview asset symlink failed")
                for asset in ("escape", "project-escape", "assets/project-escape.json"):
                    status, _, _ = request(opener, "GET", urllib.parse.urljoin(preview_url, asset))
                    check(status == 403, f"HTML capability followed a link outside its preview folder: {asset}")
                if browser:
                    browser_env = {**test_env, "ARTIFACE_TEST_URL": app_origin, "ARTIFACE_TEST_PASSWORD": password,
                                   "ARTIFACE_TEST_ROOT": str(artifacts), "ARTIFACE_TEST_SPARE": spare["id"],
                                   "ARTIFACE_TEST_LOCAL_ROOT": str(local_artifacts)}
                    subprocess.run(["node", str(REPO / "scripts" / "browser-smoke.mjs")],
                                   env=browser_env, check=True, timeout=420)
                    # The password form revokes every session, including this client's.
                    status, _, body = request(opener, "POST", app_origin + "/api/login",
                                              data={"password": password}, headers={"Origin": app_origin})
                    check(status == 200, "Browser password check did not restore the fixture password")
                    auth = {"Origin": app_origin, "X-CSRF-Token": json.loads(body)["csrfToken"]}
                    saved = json.loads(config_path.read_text())
                    saved_spare = next(host for host in saved["hosts"] if host["target"] == "artiface-spare")
                    check(any(root["path"] == str(artifacts / "reports") for root in saved_spare["roots"]),
                          "Browser project setup was not persisted")
                    saved_local = next(host for host in saved["hosts"] if host.get("kind") == "local")
                    check(saved_local.get("target", "") == "", "Local source acquired an SSH target")
                    local_root = next(root for root in saved_local["roots"] if root["path"] == str(local_project))
                    local_query = lambda rel: urllib.parse.urlencode({
                        "host": saved_local["id"], "root": local_root["id"], "path": rel,
                    })
                    status, _, body = request(opener, "GET", app_origin + "/api/file?" + local_query("report.pdf"),
                                              headers={"Range": "bytes=0-4"})
                    check(status == 206 and body == b"%PDF-", "Local dispatch PDF range request failed")
                    for alias in ("notes-link.md", "notes-absolute.md", "notes-chain.md"):
                        status, _, body = request(opener, "GET", app_origin + "/api/file?" + local_query(alias))
                        check(status == 200 and body == (local_project / "notes.md").read_bytes(),
                              f"Contained local link was not readable: {alias}")
                    status, _, body = request(opener, "GET", app_origin + "/api/list?" + local_query(""))
                    local_entries = {entry["name"]: entry for entry in json.loads(body)["entries"]}
                    check(status == 200 and local_entries["nested-link"]["type"] == "directory"
                          and local_entries["nested-link"]["resolvedPath"] == "nested",
                          "Contained local directory link was not canonicalized")
                    for rel in ("../outside.txt", "escape", "broken-link", "cycle-a"):
                        for endpoint in ("file", "file-info"):
                            status, _, _ = request(opener, "GET", app_origin + f"/api/{endpoint}?" + local_query(rel))
                            check(status == 403, f"Local traversal or unavailable link was accepted by {endpoint}: {rel}")
                    status, _, body = request(opener, "GET", app_origin + "/api/file-info?" + local_query("notes.md"))
                    check(status == 200 and json.loads(body)["type"] == "file",
                          "Local file metadata dispatch failed")
                    check_recursive_listing(opener, app_origin, local_query, "browse-checks")
                    check((task_dir / ".artifaceignore").read_text() == ignore_document["content"],
                          "Browser ignore edits did not restore the default rules in the sibling file")
                    check((task_dir / ".artifaceignore").stat().st_mode & 0o077 == 0,
                          "Saved ignore file permissions are too broad")
                    check(ssh_config.read_bytes() == original_ssh_config, "Settings removal modified the user's SSH config")
                    check((artifacts / "reports" / "notes.md").is_file() and (local_project / "notes.md").is_file(),
                          "Removing a project or host deleted artifact files")
                # Settings changes revoke capabilities too, so mint a fresh one
                # to prove logout itself invalidates an otherwise working preview.
                status, _, body = request(opener, "POST", app_origin + "/api/preview",
                                           data={"host": "smoke", "root": "artifacts", "path": "reports/index.html"}, headers=auth)
                check(status == 200, "Could not create the logout-revocation fixture")
                preview_url = json.loads(body)["url"]
                status, _, _ = request(opener, "GET", preview_url)
                check(status == 200, "Preview was already invalid before logout")
                status, _, _ = request(opener, "POST", app_origin + "/api/logout", data={}, headers=auth)
                check(status == 200, "Logout failed")
                status, _, _ = request(opener, "GET", preview_url)
                check(status == 401, "Logout did not revoke preview access")
            print("PASS: isolated SSH import/persistence, real SSH/local browsing, contained symlinks, preview-folder boundaries, shared-origin HTML/health with one listener, project trust, PDF ranges, and logout revocation")
        except Exception:
            for name in ("sshd.log", "app.log"):
                log = task_dir / name
                if log.exists():
                    print(f"{name}:\n{log.read_text()[-4000:]}")
            raise
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=REPO / "bin" / "artiface")
    parser.add_argument("--browser", action="store_true", help="Also run Chromium browser checks (requires Playwright)")
    args = parser.parse_args()
    smoke(args.binary.resolve(), args.browser)
