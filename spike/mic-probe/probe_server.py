"""Serve the microphone probe page and print whatever it reports back.

Separate from the panel server on purpose: the spike must not depend on, or
disturb, the running application. It also has to be reachable over
http://127.0.0.1 rather than a file:// URL, because that is what makes the page
a secure context - and without a secure context navigator.mediaDevices is not
even defined, which would answer the wrong question.
"""

import http.server
import json
import os
import socketserver
import sys

PORT = 8912
HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.path = "/probe.html"
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length).decode("utf-8"))

        # Also written to disk: the probe reports progressively, and if the
        # permission prompt is left sitting there the last complete state still
        # has to be readable afterwards.
        with open(os.path.join(HERE, "last-report.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

        # Rewritten in place so the console shows the current state rather than
        # a growing pile of partial ones - but only when there is a console.
        if sys.stdout.isatty():
            os.system("cls" if os.name == "nt" else "clear")
        print("=" * 68)
        print("  WebView2 microphone probe")
        print("=" * 68)
        for row in payload.get("report", []):
            mark = {"ok": "[ok]", "bad": "[!!]", "wait": "[..]"}.get(row["state"], "    ")
            print("%s %-34s %s" % (mark, row["key"], row["value"]))
        print("-" * 68)
        print("  %s" % payload.get("verdict", ""))
        print("=" * 68)
        sys.stdout.flush()

        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print("Probe server on http://127.0.0.1:%d/  (Ctrl+C to stop)" % PORT)
        print("Waiting for the probe window to report ...")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")
