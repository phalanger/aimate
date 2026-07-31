"""Routes the pipeline's LLM calls to whichever provider is currently selected.

speech-to-speech binds its LLM endpoint, API key and model name at startup, and
the realtime protocol has no way to change them mid-session. Pointing it at
this proxy instead makes the provider a runtime choice: the pipeline always
talks to one fixed local URL, and switching providers is a config write rather
than a restart that would reload Whisper and the TTS model.

All five supported providers speak the OpenAI chat-completions protocol, so
this only rewrites the target URL, the credential and the model name - there is
no protocol translation.

The one thing it does rewrite is reasoning: models that think out loud put the
whole chain of thought in the reply, and the pipeline hands the reply straight
to a speech synthesiser. Stripped here rather than in the pipeline because this
is the single point every provider's output passes through. See ThinkStripper.
"""

import json
import os
import urllib.error
import urllib.request

CONFIG_NAME = "providers.json"
REQUEST_TIMEOUT = 300
MODELS_TIMEOUT = 30

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


class ThinkStripper:
    """Removes <think>...</think> from a reply arriving in pieces.

    Reasoning models mark their working with these tags and leave it in the
    content. Nothing downstream reads the text: it goes to the TTS, which
    happily reads a paragraph of deliberation aloud before the actual answer.

    Feeding it in pieces is the whole difficulty. A tag can be split across two
    streamed deltas - "<th" then "ink>" - so anything that might be the start of
    a tag has to be held back until the next piece proves it either way. What is
    held is at most one tag's worth of characters, which is why this can run in
    the streaming path without adding perceptible latency.

    Providers that report reasoning in a separate field instead (DeepSeek's
    reasoning_content) need nothing: the pipeline only ever reads content.
    """

    def __init__(self):
        self.inside = False
        self.held = ""

    def feed(self, text):
        if not text:
            return ""
        buffer = self.held + text
        self.held = ""
        out = []
        while buffer:
            if self.inside:
                end = buffer.find(THINK_CLOSE)
                if end == -1:
                    # Keep only what could still be the start of the closing
                    # tag; the rest is thinking and is dropped.
                    self.held = _tag_prefix_suffix(buffer, THINK_CLOSE)
                    buffer = ""
                else:
                    buffer = buffer[end + len(THINK_CLOSE):]
                    self.inside = False
                continue
            start = buffer.find(THINK_OPEN)
            if start == -1:
                keep = _tag_prefix_suffix(buffer, THINK_OPEN)
                if keep:
                    out.append(buffer[:-len(keep)])
                    self.held = keep
                else:
                    out.append(buffer)
                buffer = ""
            else:
                out.append(buffer[:start])
                buffer = buffer[start + len(THINK_OPEN):]
                self.inside = True
        return "".join(out)

    def flush(self):
        """Whatever was held back, once no more text is coming.

        An unterminated <think> means the model was cut off mid-thought, and
        emitting the held fragment would speak half a tag. Inside one, drop it.
        """
        held = "" if self.inside else self.held
        self.held = ""
        return held


def _tag_prefix_suffix(text, tag):
    """The longest suffix of text that is a proper prefix of tag."""
    limit = min(len(text), len(tag) - 1)
    for size in range(limit, 0, -1):
        if text[-size:] == tag[:size]:
            return text[-size:]
    return ""


class RouterError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class ProviderStore:
    def __init__(self, path):
        self.path = path

    def load(self):
        with open(self.path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def save(self, data):
        temp = self.path + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp, self.path)

    def active(self):
        data = self.load()
        name = data.get("active")
        provider = data.get("providers", {}).get(name)
        if not provider:
            raise RouterError(500, "no active provider configured")
        return name, provider

    def public_view(self):
        """Config for the browser, with credentials reduced to a boolean.

        The panel only ever needs to know whether a key is set, so the key
        itself never leaves the machine's disk.
        """
        data = self.load()
        out = {"active": data.get("active"), "providers": {}}
        for name, provider in data.get("providers", {}).items():
            out["providers"][name] = {
                "label": provider.get("label", name),
                "base_url": provider.get("base_url", ""),
                "model": provider.get("model", ""),
                "needs_key": bool(provider.get("needs_key")),
                "local": bool(provider.get("local")),
                "hint": provider.get("hint", ""),
                "has_key": bool(provider.get("api_key")),
            }
        return out

    def update(self, payload):
        """Apply a partial update from the panel.

        An absent or empty api_key means "leave it alone": the panel never
        receives the stored key, so echoing an empty field back must not wipe
        a working credential.
        """
        data = self.load()
        providers = data.setdefault("providers", {})

        name = payload.get("provider")
        if name:
            if name not in providers:
                raise RouterError(400, "unknown provider: " + name)
            provider = providers[name]
            for field in ("base_url", "model"):
                if field in payload and payload[field] is not None:
                    provider[field] = str(payload[field]).strip()
            key = payload.get("api_key")
            if key:
                provider["api_key"] = str(key).strip()
            elif payload.get("clear_key"):
                provider["api_key"] = ""

        if payload.get("active"):
            if payload["active"] not in providers:
                raise RouterError(400, "unknown provider: " + str(payload["active"]))
            data["active"] = payload["active"]

        self.save(data)
        return data


def _auth_headers(provider):
    headers = {"Content-Type": "application/json"}
    key = provider.get("api_key")
    if key:
        headers["Authorization"] = "Bearer " + key
    return headers


def _endpoint(provider, suffix):
    return provider.get("base_url", "").rstrip("/") + suffix


def list_models(store, name=None):
    data = store.load()
    providers = data.get("providers", {})
    name = name or data.get("active")
    provider = providers.get(name)
    if not provider:
        raise RouterError(400, "unknown provider: " + str(name))

    if provider.get("needs_key") and not provider.get("api_key"):
        raise RouterError(400, "this provider needs an API key first")

    request = urllib.request.Request(
        _endpoint(provider, "/models"),
        headers=_auth_headers(provider),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=MODELS_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RouterError(exc.code, "provider rejected the request: " + detail)
    except Exception as exc:
        raise RouterError(502, "could not reach provider: %s" % exc)

    models = []
    for entry in payload.get("data", []) or []:
        model_id = entry.get("id")
        if model_id:
            models.append(model_id)
    models.sort()
    return {"provider": name, "models": models}


def proxy_chat(store, body, write_status, write_chunk):
    """Forward one chat-completions call to the active provider.

    Streams the response straight through: the pipeline splits the reply into
    sentences as they arrive and starts synthesising before generation
    finishes, so buffering here would add latency to every single turn.
    """
    name, provider = store.active()

    try:
        payload = json.loads(body.decode("utf-8"))
    except ValueError as exc:
        raise RouterError(400, "invalid JSON body: %s" % exc)

    # The pipeline sends whatever --model_name it was started with; the real
    # choice lives in the provider config.
    if provider.get("model"):
        payload["model"] = provider["model"]

    if provider.get("needs_key") and not provider.get("api_key"):
        raise RouterError(400, "provider '%s' has no API key set" % name)

    request = urllib.request.Request(
        _endpoint(provider, "/chat/completions"),
        data=json.dumps(payload).encode("utf-8"),
        headers=_auth_headers(provider),
        method="POST",
    )

    try:
        response = urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:600]
        raise RouterError(exc.code, detail or "provider returned an error")
    except Exception as exc:
        raise RouterError(502, "could not reach provider: %s" % exc)

    with response:
        content_type = response.headers.get("Content-Type", "application/json")
        write_status(200, content_type)
        if "text/event-stream" in content_type:
            _stream_without_thinking(response, write_chunk)
        else:
            _forward_without_thinking(response, write_chunk)


def _stream_without_thinking(response, write_chunk):
    """Pass the event stream through, minus any chain of thought.

    Rewritten event by event rather than buffered: the pipeline starts
    synthesising on the first complete sentence, so holding the reply until it
    finished would add its whole generation time to every turn.

    Anything that is not a data event, or not JSON, or shaped differently from
    what is expected, goes out untouched. A provider doing something unusual
    should degrade to the old pass-through behaviour, not break.
    """
    stripper = ThinkStripper()
    pending = b""
    while True:
        chunk = response.read(4096)
        if not chunk:
            break
        pending += chunk
        # Events are newline-delimited; hold an incomplete trailing line.
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            write_chunk(_rewrite_event_line(line, stripper) + b"\n")
    if pending:
        write_chunk(_rewrite_event_line(pending, stripper))
    tail = stripper.flush()
    if tail:
        write_chunk(_tail_event(tail))


def _rewrite_event_line(line, stripper):
    text = line.decode("utf-8", "replace")
    if not text.startswith("data:"):
        return line
    payload = text[len("data:"):].strip()
    if not payload or payload == "[DONE]":
        return line
    try:
        event = json.loads(payload)
        delta = event["choices"][0]["delta"]
    except (ValueError, KeyError, IndexError, TypeError):
        return line
    if not isinstance(delta, dict) or not isinstance(delta.get("content"), str):
        return line
    delta["content"] = stripper.feed(delta["content"])
    return ("data: " + json.dumps(event, ensure_ascii=False)).encode("utf-8")


def _tail_event(text):
    """Emit text the stripper was holding when the stream ended."""
    event = {"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}
    return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8")


def _forward_without_thinking(response, write_chunk):
    """The non-streaming shape: one JSON object with the whole reply in it."""
    raw = response.read()
    try:
        event = json.loads(raw.decode("utf-8"))
        message = event["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError, UnicodeDecodeError):
        write_chunk(raw)
        return
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        write_chunk(raw)
        return
    stripper = ThinkStripper()
    message["content"] = stripper.feed(message["content"]) + stripper.flush()
    write_chunk(json.dumps(event, ensure_ascii=False).encode("utf-8"))
