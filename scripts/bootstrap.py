#!/usr/bin/env python3
"""WebUI-style bootstrap for Hermes-Desktop-Web.

Mirrors nesquena/hermes-webui's bootstrap.py ergonomics: detect prerequisites,
make sure deps + build exist, start the server, wait for health, open the
browser (unless --no-browser). The server itself is Node (proxy/server.js) —
the renderer is a TypeScript/React app that cannot run under Python — but the
launcher experience matches the WebUI project: clone, ./start.sh, done.

Env honored (same names as the bare-metal proxy):
  PORT, HERMES_TARGET, WEB_FS_ROOT, HERMES_TERM_CWD, HERMES_PLUGINS_DIR
Also loads ./env from the repo root if present (webui reads .env too).
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROXY = REPO_ROOT / "proxy" / "server.js"
DIST = REPO_ROOT / "web" / "dist"
INDEX = DIST / "index.html"
LOG = Path(os.environ.get("HERMES_WEB_LOG", Path.home() / ".hermes" / "hermes-desktop-web.log"))


def log(msg: str) -> None:
    print(f"[hdw] {msg}", flush=True)


def load_dotenv() -> None:
    """Minimal .env loader (webui's start.sh sources .env; keep the same)."""
    env_file = REPO_ROOT / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ and key not in ("UID", "GID", "EUID", "EGID", "PPID"):
            os.environ[key] = value


def find_node() -> str:
    node = shutil.which("node")
    if not node:
        log("✗ node not found — required to run the proxy and build the renderer")
        log("  install Node 20+: https://nodejs.org (or use Docker: docker compose up -d --build)")
        sys.exit(1)
    return node


def ensure_deps(node: str, no_install: bool) -> None:
    if (REPO_ROOT / "node_modules").exists():
        return
    if no_install:
        log("✗ node_modules missing and --no-install given")
        sys.exit(1)
    log("installing dependencies (npm ci)…")
    run(node, ["npm", "ci"], cwd=REPO_ROOT)


def ensure_build(node: str, rebuild: bool, no_build: bool) -> None:
    if not rebuild and INDEX.exists():
        return
    if no_build:
        log("✗ web/dist missing and --no-build given")
        sys.exit(1)
    log("building renderer (npm run build)…")
    run(node, ["npm", "run", "build"], cwd=REPO_ROOT)


def run(node: str, argv: list[str], cwd: Path) -> None:
    proc = subprocess.run([node, *argv], cwd=cwd)
    if proc.returncode != 0:
        log(f"✗ {' '.join(argv)} failed (exit {proc.returncode})")
        sys.exit(proc.returncode)


def health_ok(port: int) -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def wait_healthy(port: int, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if health_ok(port):
            return True
        time.sleep(0.5)
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Hermes-Desktop-Web launcher (webui-style)")
    parser.add_argument("--port", type=int, default=None, help="listen port (default $PORT or 4000)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser")
    parser.add_argument("--no-install", action="store_true", help="fail if node_modules missing instead of npm ci")
    parser.add_argument("--no-build", action="store_true", help="fail if web/dist missing instead of building")
    parser.add_argument("--rebuild", action="store_true", help="force a rebuild even if web/dist exists")
    parser.add_argument("--log", default=None, help="log file (default ~/.hermes/hermes-desktop-web.log)")
    args = parser.parse_args()

    load_dotenv()

    if args.log:
        os.environ["HERMES_WEB_LOG"] = args.log
    global LOG
    LOG = Path(os.environ.get("HERMES_WEB_LOG", str(Path.home() / ".hermes" / "hermes-desktop-web.log")))

    port = args.port or int(os.environ.get("PORT", "4000"))
    os.environ.setdefault("PORT", str(port))

    node = find_node()
    ensure_deps(node, args.no_install)
    ensure_build(node, args.rebuild, args.no_build)

    if health_ok(port):
        log(f"already serving http://127.0.0.1:{port} — not starting a second instance")
        return

    LOG.parent.mkdir(parents=True, exist_ok=True)
    logfile = open(LOG, "a", buffering=1)

    env = {**os.environ}
    log(f"starting proxy on :{port} (log: {LOG})")
    proc = subprocess.Popen(
        [node, str(PROXY)],
        cwd=REPO_ROOT,
        env=env,
        stdout=logfile,
        stderr=logfile,
    )

    def _forward(signum, _frame):
        proc.send_signal(signum)
    signal.signal(signal.SIGTERM, _forward)
    signal.signal(signal.SIGINT, _forward)

    if not wait_healthy(port):
        log("✗ server did not become healthy; see log for errors")
        proc.terminate()
        sys.exit(1)

    log(f"● Hermes Desktop Web running at http://127.0.0.1:{port}")
    log("  remote access: ssh -N -L 4000:127.0.0.1:4000 user@server  (then open http://127.0.0.1:4000)")

    if not args.no_browser:
        webbrowser.open(f"http://127.0.0.1:{port}")

    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        proc.wait()
    sys.exit(proc.returncode or 0)


if __name__ == "__main__":
    main()
