// Client for the speech-to-speech OpenAI Realtime WebSocket endpoint.
//
// The server accepts the connection without authentication and without a
// subprotocol, so a plain browser WebSocket is enough - no SDK needed.

export class RealtimeClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.handlers = new Map();
    this.connected = false;
    this._pendingSession = null;
  }

  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  _emit(eventType, payload) {
    const list = this.handlers.get(eventType);
    if (list) {
      for (const handler of list) {
        handler(payload);
      }
    }
    const any = this.handlers.get("*");
    if (any) {
      for (const handler of any) {
        handler(payload);
      }
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.onopen = () => {
        this.connected = true;
        settled = true;
        if (this._pendingSession) {
          this._sendRaw(this._pendingSession);
          this._pendingSession = null;
        }
        this._emit("open", null);
        resolve();
      };

      socket.onclose = (event) => {
        this.connected = false;
        this._emit("close", event);
        if (!settled) {
          settled = true;
          reject(new Error("closed-before-open"));
        }
      };

      socket.onerror = () => {
        // onerror carries no detail in browsers; onclose follows and reports
        // the useful part, so only surface it for the caller's status line.
        this._emit("socket-error", null);
        if (!settled) {
          settled = true;
          reject(new Error("connect-failed"));
        }
      };

      socket.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch (err) {
          return;
        }
        if (event && event.type) {
          this._emit(event.type, event);
        }
      };
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
  }

  _sendRaw(payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  // Builds the session payload. The 16 kHz pipeline default is expressed by
  // omitting the format field: the OpenAI realtime schema only validates
  // audio/pcm at 24 kHz, so declaring 16 kHz explicitly is rejected.
  buildSessionUpdate(options) {
    const output = {};
    if (options && options.voice) {
      output.voice = options.voice;
    }

    const session = {
      type: "realtime",
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            interrupt_response: true,
          },
        },
        output: output,
      },
    };

    if (options && options.instructions) {
      session.instructions = options.instructions;
    }

    return { type: "session.update", session: session };
  }

  updateSession(options) {
    const payload = this.buildSessionUpdate(options);
    if (!this._sendRaw(payload)) {
      // Queue it so a switch made before the socket opens is not lost.
      this._pendingSession = payload;
    }
  }

  appendAudio(base64Audio) {
    return this._sendRaw({ type: "input_audio_buffer.append", audio: base64Audio });
  }

  cancelResponse() {
    return this._sendRaw({ type: "response.cancel" });
  }

  sendText(text) {
    this._sendRaw({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text }],
      },
    });
    this._sendRaw({ type: "response.create" });
  }
}
