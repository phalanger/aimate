"""Start, watch and stop every process this app needs.

Three processes have to be running: the panel server, the voice pipeline and -
for the lip-sync display mode only - MuseTalk. They cannot be merged: the panel
exists because the UI is a browser page, and MuseTalk pins torch 2.0.1 / CUDA
11.8 against the pipeline's torch 2.9.1 / CUDA 12.8, so they cannot even share
an interpreter. What can be fixed is that starting them felt like running three
programs instead of one.

So this owns their lifecycle rather than merging them:

    one command, one window, one merged log
    start order derived from declared dependencies
    readiness probed, not slept on
    a crash is restarted with backoff, and reported when it keeps happening
    Ctrl+C takes the whole tree down, including grandchildren

Deliberately stdlib-only and driven entirely by services.json. The eventual
desktop shell will need exactly this process table, and a data file is
something a Rust supervisor can read too, where a pile of PowerShell is not.

Usage - there is no Python on PATH by design, so name the bundled one, or use
the start-*.ps1 wrappers which already know where it is:

    runtime\\python\\s2s\\python.exe scripts\\supervisor.py
                                         start everything
    ... supervisor.py --only voice       just one, with its dependencies
    ... supervisor.py --skip lipsync     everything else
    ... supervisor.py --list             show the process table and exit
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(HERE, "services.json")
LOG_DIR = os.path.join(ROOT, "var", "logs")
# Startup progress, for the desktop shell's loading screen. A file rather than
# a port because it has to be readable before anything is listening, and the
# shell needs to know which services were skipped - only the supervisor knows
# that.
STATUS_FILE = os.path.join(ROOT, "var", "run", "status.json")

# A service that dies more often than this is not going to be fixed by trying
# again; it needs a human to read the log.
MAX_RESTARTS = 3
RESTART_WINDOW = 120.0
BACKOFF = (2.0, 5.0, 15.0)

COLORS = ("36", "33", "35", "32", "34", "91")
RESET = "\033[0m"


def force_utf8():
    """Write UTF-8 whatever we are attached to.

    Launched from a terminal, stdout is the console and Python picks a codec
    that can carry what the services print. Launched from the desktop shell it
    is a redirected file, and Python falls back to the system codepage - GBK
    here - which cannot encode U+FFFD. A single undecodable byte from a child
    then raised UnicodeEncodeError inside the reader thread and killed it, so
    that service stopped being logged and would eventually block on a full
    pipe.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def enable_ansi():
    """Windows consoles need virtual terminal processing turned on explicitly."""
    if os.name != "nt":
        return sys.stdout.isatty()
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        # -11 is STD_OUTPUT_HANDLE, 0x0004 is ENABLE_VIRTUAL_TERMINAL_PROCESSING.
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


USE_COLOR = enable_ansi() and not os.environ.get("NO_COLOR")


def paint(text, colour):
    if not USE_COLOR or not colour:
        return text
    return "\033[" + colour + "m" + text + RESET


class Service:
    def __init__(self, spec, variables, colour, common_env=None):
        self.id = spec["id"]
        self.label = spec.get("label", self.id)
        self.note = spec.get("note", "")
        # Unmanaged services are probed but never started or stopped: Ollama
        # runs from its own installation directory under its own tray icon,
        # and starting it from here is what made it load conflicting ggml
        # binaries and fall back to CPU.
        self.managed = spec.get("managed", True)
        self.optional = spec.get("optional", False)
        self.depends_on = spec.get("depends_on", [])
        # Expanded like everything else: the probe refers to the same port
        # variables the command line does, and they have to stay one value.
        self.ready = {
            key: expand(value, variables)
            for key, value in (spec.get("ready") or {"type": "none"}).items()
        }
        self.ready_timeout = float(spec.get("ready_timeout", 60))
        self.colour = colour

        self.command = [expand(part, variables) for part in spec.get("command", [])]
        self.cwd = expand(spec.get("cwd", "{root}"), variables)
        self.env = {}
        # Common first so a service can override any of it.
        merged = dict(common_env or {})
        merged.update(spec.get("env") or {})
        for key, value in merged.items():
            # {PATH} and friends expand from the real environment, so a service
            # can prepend to a variable instead of replacing it.
            self.env[key] = expand(value, variables, os.environ)

        self.process = None
        self.reader = None
        self.log = None
        self.restarts = 0
        self.first_restart = 0.0
        self.stopping = False
        self.gave_up = False

    def tag(self):
        return paint("[%-8s]" % self.id, self.colour)


CERT_VARS = ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_DIR")


def drop_dead_cert_vars(environment):
    """Unset certificate bundle variables that point at something gone.

    These name a CA bundle for every HTTPS client in the process. Python
    package managers like to set them to a file inside their own installation,
    and when that installation is removed the variable outlives it - inherited
    by any shell opened before the removal, and from there by everything
    launched out of that shell.

    A stale one is worse than none at all. ssl.create_default_context opens the
    file eagerly and the error carries no filename:

        FileNotFoundError: [Errno 2] No such file or directory

    which is raised while merely constructing an HTTP client, long before any
    request. This took down the voice pipeline on 2026-07-30, after Anaconda
    was uninstalled and SSL_CERT_FILE still pointed into it. Dropping the
    variable falls back to the certifi bundle inside each service's own
    interpreter, which is what we want anyway.
    """
    for name in CERT_VARS:
        value = environment.get(name)
        if value and not os.path.exists(value):
            print(
                "dropping %s: it points at %s, which does not exist" % (name, value),
                flush=True,
            )
            environment.pop(name, None)
    return environment


def expand(text, variables, extra=None):
    """Substitute {name} from the variable table, then from the environment."""
    if not isinstance(text, str):
        return text
    out = text
    # Repeated because variables may themselves contain placeholders, for
    # instance tts_model referring to {root}.
    for _ in range(5):
        before = out
        for key, value in variables.items():
            out = out.replace("{" + key + "}", str(value))
        if extra:
            for key, value in extra.items():
                out = out.replace("{" + key + "}", str(value))
        if out == before:
            break
    return out


def parent_alive(pid):
    """Whether the process that launched us is still running.

    The desktop shell passes its own pid so that closing the window can never
    leave a voice pipeline holding the GPU. The shell kills the tree itself on
    a normal exit; this covers the cases where it does not get the chance -
    killed from Task Manager, or crashed.

    os.kill(pid, 0) is not usable here: on Windows os.kill terminates rather
    than probes. Opening the process with SYNCHRONIZE and doing a zero-length
    wait asks the same question without touching it.
    """
    if pid <= 0:
        return True
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    import ctypes

    SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def read_setting(key, default=None):
    """One value out of the settings file, before anything is running."""
    path = os.path.join(ROOT, "config", "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for group in data.get("groups", []):
            for item in group.get("items", []):
                if item.get("key") == key:
                    return item.get("value", default)
    except Exception:
        pass
    return default


def read_lan_setting():
    """Whether the user opted into serving the whole network.

    All three services have to agree on this. A panel reachable from the
    network with a voice server bound to loopback loads the page on another
    device and then fails to connect, with nothing obvious to point at.
    """
    path = os.path.join(ROOT, "config", "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for group in data.get("groups", []):
            for item in group.get("items", []):
                if item.get("key") == "lan_access":
                    return bool(item.get("value"))
    except Exception:
        pass
    return False


def load_services():
    with open(CONFIG, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    variables = dict(config.get("vars", {}))
    variables["root"] = ROOT
    variables["bind"] = "0.0.0.0" if read_lan_setting() else "127.0.0.1"
    # Only the panel reaches the public internet, and only to call whichever
    # cloud model is selected. Proxy variables are usually set per shell
    # session, so a process launched from Explorer has none and those calls
    # time out - which shows up as the voice pipeline never finishing its
    # warm-up. Empty means "use whatever the environment already had".
    variables["proxy"] = str(read_setting("llm_proxy", "") or "")

    services = []
    for index, spec in enumerate(config.get("services", [])):
        services.append(
            Service(spec, variables, COLORS[index % len(COLORS)], config.get("common_env"))
        )
    return services, variables


# ---------- readiness ----------


def probe(check, timeout=1.5):
    kind = check.get("type", "none")
    if kind == "none":
        return True
    if kind == "tcp":
        port = int(check["port"])
        try:
            connection = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        except OSError:
            return False
        # Close it politely, and give the server a moment to finish accepting
        # first. Dropping a connection the server has not accepted yet fails
        # its pending AcceptEx with WinError 64, and asyncio's proactor
        # responds to an accept error by closing the *listening* socket - so
        # one badly timed probe silently takes the service off its port for
        # good, and every later probe then times out against a process that
        # looks alive. This cost a startup that hung at "starting" forever.
        #
        # Do not mistake this for a cure. It narrows the window; it cannot
        # close it, because nothing on this side can tell when the server has
        # accepted. It was measured recurring afterwards, on a service that
        # had simply got faster to start. So: never use a tcp check against an
        # asyncio server; use an http one. This check is for servers that do
        # their own blocking accept, where dropping the connection is harmless.
        #
        # An http check is not a cure either, and this comment used to claim it
        # was - "the server has to accept and answer before the client can
        # close". It does not: the client gives up on its own timeout, and a
        # server busy enough to be slow at accepting is exactly the server
        # everything is probing. The lip-sync service lost its port that way on
        # 2026-07-30. The only real fix is on the server, which now serves on a
        # selector event loop - see services/lipsync/service.py serve().
        try:
            connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        time.sleep(0.05)
        connection.close()
        return True
    if kind == "http":
        try:
            request = urllib.request.Request(check["url"], method="GET")
            # Explicitly no proxy: this machine has HTTP_PROXY set with an
            # empty NO_PROXY, which would send a loopback probe through it.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=timeout) as response:
                return 200 <= response.status < 500
        except urllib.error.HTTPError:
            # Answering at all means the port is serving, which is the question.
            return True
        except Exception:
            return False
    return True


# ---------- supervisor ----------


class Supervisor:
    def __init__(self, services):
        self.services = services
        self.by_id = {service.id: service for service in services}
        self.running = True
        self.lock = threading.Lock()
        # Services now start concurrently, so the status file is written
        # from several threads.
        self.status_lock = threading.Lock()

        if not os.path.isdir(LOG_DIR):
            os.makedirs(LOG_DIR)

        # Only the services actually selected appear, so a run with
        # --skip lipsync does not leave the shell waiting for something that
        # was never going to start.
        self.progress = {service.id: "waiting" for service in services}
        self.done = False
        self._write_status()

    def _write_status(self):
        try:
            folder = os.path.dirname(STATUS_FILE)
            os.makedirs(folder, exist_ok=True)
            payload = {
                "done": self.done,
                "services": [
                    {
                        "id": service.id,
                        "label": service.label,
                        "optional": service.optional or not service.managed,
                        "state": self.progress.get(service.id, "waiting"),
                    }
                    for service in self.services
                ],
            }
            temp = STATUS_FILE + ".tmp"
            # Replaced atomically: the shell polls this file several times a
            # second and must never read a half-written one. The lock keeps
            # two services reaching ready at once from sharing the temp file.
            with self.status_lock:
                with open(temp, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False)
                os.replace(temp, STATUS_FILE)
        except Exception:
            # Progress reporting is not worth failing a startup over.
            pass

    def mark(self, service, state):
        self.progress[service.id] = state
        self._write_status()

    def say(self, service, message, colour=None):
        line = (service.tag() + " " if service else "") + paint(message, colour)
        with self.lock:
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except Exception:
                # Never let the console kill a reader thread. The per-service
                # log file is written before this is called, so the line is
                # already safe on disk either way.
                pass

    # ---------- process handling ----------

    def spawn(self, service):
        service.stopping = False
        service.log = open(
            os.path.join(LOG_DIR, service.id + ".log"), "a", encoding="utf-8", errors="replace"
        )
        service.log.write("\n=== started %s ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))

        environment = drop_dead_cert_vars(dict(os.environ))
        # An entry that expands to nothing is left alone rather than set empty:
        # an empty HTTP_PROXY means "no proxy" and would override one the
        # launching shell had already provided.
        environment.update({k: v for k, v in service.env.items() if v})
        # Unbuffered, so a crashing child's last words are not lost in a pipe
        # buffer - which is exactly when they matter most.
        environment["PYTHONUNBUFFERED"] = "1"
        # And UTF-8 both ways: a child writing to a pipe otherwise picks the
        # system codepage, which cannot carry the paths and library messages
        # that turn up here. The reader decodes UTF-8.
        environment["PYTHONIOENCODING"] = "utf-8"

        flags = 0
        if os.name == "nt":
            # Its own process group, so a console Ctrl+C is delivered here and
            # not straight to the children. Shutdown then happens in one place
            # and in a known order.
            flags = subprocess.CREATE_NEW_PROCESS_GROUP

        try:
            service.process = subprocess.Popen(
                service.command,
                cwd=service.cwd,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=flags,
            )
        except FileNotFoundError as exc:
            self.say(service, "cannot start: %s" % exc, "91")
            service.process = None
            return False

        service.reader = threading.Thread(target=self.pump, args=(service,), daemon=True)
        service.reader.start()
        return True

    def pump(self, service):
        """Forward one child's output to the console and its own log file."""
        stream = service.process.stdout
        for raw in iter(stream.readline, b""):
            text = raw.decode("utf-8", "replace").rstrip("\r\n")
            if service.log:
                service.log.write(text + "\n")
                service.log.flush()
            self.say(service, text)
        stream.close()

    def wait_ready(self, service):
        if service.ready.get("type", "none") == "none":
            return True
        deadline = time.time() + service.ready_timeout
        while time.time() < deadline:
            if probe(service.ready):
                return True
            # A child that died is never going to become ready; say so now
            # rather than at the end of a fifteen-minute timeout.
            if service.managed and service.process and service.process.poll() is not None:
                return False
            time.sleep(0.4)
        return False

    def stop(self, service):
        service.stopping = True
        process = service.process
        if not process or process.poll() is not None:
            return
        if os.name == "nt":
            # taskkill /T, because terminating the child alone can orphan the
            # grandchildren - torch spawns workers, and an orphan holding the
            # port makes the next start fail with "address already in use".
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                # Under the desktop shell this process has no console of its
                # own, so starting a console program would be given a fresh
                # window - a black flash on every shutdown.
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    # ---------- orchestration ----------

    def _bring_up(self, service):
        """Start one service and wait for it to answer. True if it is usable."""
        if not service.managed:
            up = probe(service.ready)
            state = "up" if up else "not running"
            self.say(service, "%s (external) - %s" % (service.label, state), "32" if up else "33")
            if not up and service.note:
                self.say(service, service.note, "90")
            self.mark(service, "ready" if up else "failed")
            return up

        if probe(service.ready) and service.ready.get("type") != "none":
            self.say(service, "%s already running, adopting it" % service.label, "32")
            self.mark(service, "ready")
            return True

        self.say(service, "starting %s ..." % service.label, "36")
        self.mark(service, "starting")
        if not self.spawn(service):
            self.mark(service, "failed")
            return False

        if self.wait_ready(service):
            self.say(service, "ready", "32")
            self.mark(service, "ready")
            return True

        self.say(service, "did not become ready in %.0fs" % service.ready_timeout, "91")
        self.mark(service, "failed")
        return False

    def start_all(self):
        """Start everything, each service as soon as its own needs are met.

        Started one after another, the lip-sync service and the voice pipeline
        added up: about thirty-five seconds each, and the second spent the
        first thirty-five doing nothing. They do not depend on each other -
        only the pipeline depends on the panel - so they run at the same time
        and the wait is the longer of the two rather than the sum.

        Waves would not have been enough: a wave holds the pipeline until the
        whole first wave is done, which includes the lip-sync service it has
        no need of. Each service waits on its own dependencies instead.
        """
        done = {service.id: threading.Event() for service in self.services}
        ok = {}

        def run(service):
            for need in service.depends_on:
                event = done.get(need)
                if event is None:
                    continue
                event.wait()
                if not ok.get(need):
                    self.say(service, "skipped: %s is not running" % need, "91")
                    self.mark(service, "failed")
                    ok[service.id] = False
                    done[service.id].set()
                    return
            if not self.running:
                ok[service.id] = False
                done[service.id].set()
                return
            try:
                ok[service.id] = self._bring_up(service)
            except Exception as exc:
                self.say(service, "failed to start: %s" % exc, "91")
                self.mark(service, "failed")
                ok[service.id] = False
            finally:
                # Set even on failure, or anything waiting on it would hang.
                done[service.id].set()

        threads = [
            threading.Thread(target=run, args=(service,), daemon=True)
            for service in self.services
        ]
        for thread in threads:
            thread.start()

        # Let the shell in as soon as the services it cannot open without are
        # up, and leave the optional ones loading behind the main window.
        #
        # Waiting for everything meant the splash sat there for the slowest
        # service on the list, which is the lip-sync one: six and a half
        # minutes measured here, of which four and a half were it reading a
        # 6 GB checkpoint that nothing needs until the user actually speaks.
        # The panel already copes with it being absent - it polls for the
        # service and mounts the renderer when it appears - so that wait
        # bought nothing.
        required = [service for service in self.services if not service.optional]
        for service in required:
            done[service.id].wait()
        if all(ok.get(service.id) for service in required):
            self.done = True
            self._write_status()

        for thread in threads:
            thread.join()

        # Optional services are allowed to be missing; the rest are not.
        for service in self.services:
            if not service.optional and not ok.get(service.id):
                return False
        return True

    def finish_startup(self, ok):
        """Startup is over - the shell can stop waiting either way."""
        self.done = True
        if not ok:
            for service in self.services:
                if self.progress.get(service.id) in ("waiting", "starting"):
                    self.progress[service.id] = "failed"
        self._write_status()

    def watch(self, restart=True, parent_pid=0):
        """Keep an eye on the children until Ctrl+C or nothing is left alive."""
        while self.running:
            time.sleep(1.0)

            if parent_pid and not parent_alive(parent_pid):
                self.say(None, "launcher exited; shutting down.", "33")
                return

            alive = 0
            for service in self.services:
                if not service.managed or not service.process or service.stopping:
                    continue
                code = service.process.poll()
                if code is None:
                    alive += 1
                    continue
                if service.gave_up:
                    continue

                self.say(service, "exited with code %s" % code, "91")
                if not restart:
                    service.gave_up = True
                    continue

                now = time.time()
                if now - service.first_restart > RESTART_WINDOW:
                    service.first_restart = now
                    service.restarts = 0
                service.restarts += 1
                if service.restarts > MAX_RESTARTS:
                    service.gave_up = True
                    self.say(
                        service,
                        "giving up after %d restarts - see var\\logs\\%s.log"
                        % (MAX_RESTARTS, service.id),
                        "91",
                    )
                    continue

                delay = BACKOFF[min(service.restarts - 1, len(BACKOFF) - 1)]
                self.say(service, "restarting in %.0fs (%d/%d)" % (delay, service.restarts, MAX_RESTARTS), "33")
                time.sleep(delay)
                if self.running and self.spawn(service):
                    if self.wait_ready(service):
                        self.say(service, "recovered", "32")
                    else:
                        self.say(service, "restarted but never became ready", "91")
                    alive += 1

            if alive == 0 and any(s.managed for s in self.services):
                self.say(None, "nothing left running.", "91")
                return

    def shutdown(self):
        self.running = False
        self.say(None, "", None)
        self.say(None, "stopping services ...", "36")
        # Reverse order: dependents go down before what they depend on, so the
        # voice pipeline is not left making LLM calls into a dead panel.
        for service in reversed(self.services):
            if service.managed and service.process:
                self.stop(service)
                if service.log:
                    service.log.close()
        self.say(None, "stopped.", "32")


def print_table(services, variables):
    print("Process table from %s\n" % CONFIG)
    for service in services:
        kind = "external" if not service.managed else ("optional" if service.optional else "required")
        print("  %-9s %-9s %s" % (service.id, kind, service.label))
        if service.note:
            print("            %s" % service.note)
        if service.command:
            print("            %s" % " ".join(service.command[:3]) + " ...")
        print("")
    print("Bind address: %s" % variables["bind"])


def main():
    parser = argparse.ArgumentParser(description="Start and watch the companion's services.")
    parser.add_argument("--only", default="", help="comma-separated ids; dependencies come along")
    parser.add_argument("--skip", default="", help="comma-separated ids to leave out")
    parser.add_argument("--no-restart", action="store_true", help="do not restart a crashed service")
    parser.add_argument("--list", action="store_true", help="print the process table and exit")
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=0,
        help="shut down if this process exits; the desktop shell passes its own pid",
    )
    args = parser.parse_args()

    force_utf8()
    services, variables = load_services()

    if args.only:
        wanted = set(part.strip() for part in args.only.split(",") if part.strip())
        # Pull in dependencies: asking for the voice pipeline without the panel
        # produces a pipeline that cannot reach a text model.
        for _ in range(len(services)):
            for service in services:
                if service.id in wanted:
                    wanted.update(service.depends_on)
        services = [service for service in services if service.id in wanted]
    if args.skip:
        unwanted = set(part.strip() for part in args.skip.split(",") if part.strip())
        services = [service for service in services if service.id not in unwanted]

    if not services:
        print("No services selected.")
        return 1

    # After filtering, so it doubles as a way to see what --only actually
    # resolves to once dependencies are pulled in.
    if args.list:
        print_table(services, variables)
        return 0

    supervisor = Supervisor(services)

    def on_signal(signum, frame):
        supervisor.running = False

    signal.signal(signal.SIGINT, on_signal)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, on_signal)

    port = variables.get("panel_port", "8900")
    started = False
    try:
        started = supervisor.start_all()
        supervisor.finish_startup(started)
        if started:
            supervisor.say(None, "", None)
            supervisor.say(None, "  Open http://127.0.0.1:%s/" % port, "32")
            if variables["bind"] == "0.0.0.0":
                supervisor.say(
                    None,
                    "  LAN access is on: anyone who can reach this machine can use it.",
                    "33",
                )
            supervisor.say(None, "  Ctrl+C stops everything.", "90")
            supervisor.say(None, "", None)
            supervisor.watch(restart=not args.no_restart, parent_pid=args.parent_pid)
        else:
            supervisor.say(None, "startup failed; see the messages above.", "91")
    except KeyboardInterrupt:
        pass
    finally:
        supervisor.shutdown()

    return 0 if started else 1


if __name__ == "__main__":
    sys.exit(main())
