"""Stream a chat completion through the panel's GLM proxy.

The panel already proxies the active provider at /v1/chat/completions
(server/server.py:889, _proxy_chat -> llm_router.proxy_chat) and:
  - overrides the model with the provider's configured one, so the model we
    send here is ignored - we send the GLM name only for legibility;
  - streams SSE and strips any <think> chain-of-thought
    (llm_router._stream_without_thinking), so the deltas are clean reply text.

We therefore never touch a key. The system message is the persona carried in
session.update.instructions (web/js/app.js:761).
"""

import json

import httpx


async def stream_chat(panel_url, system, user, model="glm-5-turbo", timeout=60.0):
    """Yield reply text deltas from the streamed chat completion."""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})
    payload = {"model": model, "messages": messages, "stream": True}
    url = panel_url.rstrip("/") + "/v1/chat/completions"

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, json=payload) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if not data or data == "[DONE]":
                    if data == "[DONE]":
                        break
                    continue
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield content
