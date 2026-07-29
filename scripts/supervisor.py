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

Usage
    python supervisor.py                 start everything
    python supervisor.py --only voice    just one, with its dependencies
    python supervisor.py --skip lipsync  everything else
    python supervisor.py --list          show the process table and exit
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

# A service that dies more often than this is not going to be fixed by trying
# again; it needs a human to read the log.
MAX_RESTARTS = 3
RESTART_WINDOW = 120.0
BACKOFF = (2.0, 5.0, 15.0)

COLORS = ("36", "33", "35", "32", "34", "91")
RESET = "\033[0m"


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
    def __init__(self, spec, variables, colour):
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
        for key, value in (spec.get("env") or {}).items():
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

    services = []
    for index, spec in enumerate(config.get("services", [])):
        services.append(Service(spec, variables, COLORS[index % len(COLORS)]))
    return services, variables


# ---------- readiness ----------


def probe(check, timeout=1.5):
    kind = check.get("type", "none")
    if kind == "none":
        return True
    if kind == "tcp":
        port = int(check["port"])
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=timeout):
                return True
        except OSError:
            return False
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

        if not os.path.isdir(LOG_DIR):
            os.makedirs(LOG_DIR)

    def say(self, service, message, colour=None):
        line = (service.tag() + " " if service else "") + paint(message, colour)
        with self.lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    # ---------- process handling ----------

    def spawn(self, service):
        service.stopping = False
        service.log = open(
            os.path.join(LOG_DIR, service.id + ".log"), "a", encoding="utf-8", errors="replace"
        )
        service.log.write("\n=== started %s ===\n" % time.strftime("%Y-%m-%d %H:%M:%S"))

        environment = dict(os.environ)
        environment.update(service.env)
        # Unbuffered, so a crashing child's last words are not lost in a pipe
        # buffer - which is exactly when they matter most.
        environment["PYTHONUNBUFFERED"] = "1"

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
            )
        else:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    # ---------- orchestration ----------

    def start_all(self):
        for service in self.services:
            if not self.running:
                return False

            for need in service.depends_on:
                other = self.by_id.get(need)
                if other and other.managed and (not other.process or other.process.poll() is not None):
                    self.say(service, "skipped: %s is not running" % need, "91")
                    if not service.optional:
                        return False

            if not service.managed:
                state = "up" if probe(service.ready) else "not running"
                colour = "32" if state == "up" else "33"
                self.say(service, "%s (external) - %s" % (service.label, state), colour)
                if state != "up" and service.note:
                    self.say(service, service.note, "90")
                continue

            if probe(service.ready) and service.ready.get("type") != "none":
                self.say(service, "%s already running, adopting it" % service.label, "32")
                continue

            self.say(service, "starting %s ..." % service.label, "36")
            if not self.spawn(service):
                if service.optional:
                    continue
                return False

            if self.wait_ready(service):
                self.say(service, "ready", "32")
            else:
                self.say(service, "did not become ready in %.0fs" % service.ready_timeout, "91")
                if not service.optional:
                    return False
        return True

    def watch(self, restart=True):
        """Keep an eye on the children until Ctrl+C or nothing is left alive."""
        while self.running:
            time.sleep(1.0)
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
    args = parser.parse_args()

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
            supervisor.watch(restart=not args.no_restart)
        else:
            supervisor.say(None, "startup failed; see the messages above.", "91")
    except KeyboardInterrupt:
        pass
    finally:
        supervisor.shutdown()

    return 0 if started else 1


if __name__ == "__main__":
    sys.exit(main())
