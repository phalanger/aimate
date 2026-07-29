// Voice library.
//
// A voice is a matched pair - a short reference clip and the exact transcript
// of it - because cloning conditions on both, and a transcript belonging to a
// different clip is worse than none. They used to be two fields on every
// character, so the same voice was written out once per character and the
// copies drifted apart. Here they are one record that characters point at.
//
// Making one is a sequence: pick a file, cut a few seconds out of it, get the
// words, name it. That sequence is why this is its own dialog rather than four
// controls wedged into the character editor.

function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error("missing element: " + id);
  }
  return node;
}

function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined ? match : String(values[key])
  );
}

// The clip becomes a file on disk, so it needs a name the filesystem and the
// API will both accept. The label the user types is free text and may be
// Chinese, so it cannot be the filename.
function clipName() {
  return "voice-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class VoiceLibrary {
  constructor(options) {
    this.t = options.translate;
    this.onChanged = options.onChanged;
    this.packs = [];
    // The clip cut but not yet saved as a voice. Kept here so the transcribe
    // and save steps know what they are working on.
    this.pending = null;

    el("voices-close").addEventListener("click", () => this.close());
    el("voices-done").addEventListener("click", () => this.close());
    el("voices-backdrop").addEventListener("click", (event) => {
      if (event.target === el("voices-backdrop")) {
        this.close();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el("voices-backdrop").hidden) {
        this.close();
      }
    });

    el("vp-clip").addEventListener("click", () => this._clip());
    el("vp-transcribe").addEventListener("click", () => this._transcribe());
    el("vp-save").addEventListener("click", () => this._save());
  }

  applyStaticText() {
    const t = this.t;
    el("voices-title").textContent = t("voices_title");
    el("lb-voice-list").textContent = t("lb_voice_list");
    el("lb-voice-new").textContent = t("lb_voice_new");
    el("lb-voice-new-note").textContent = t("lb_voice_new_note");
    el("lb-vp-start").textContent = t("lb_start");
    el("lb-vp-duration").textContent = t("lb_duration");
    el("vp-clip").textContent = t("btn_vp_clip");
    el("lb-vp-text").textContent = t("lb_vp_text");
    el("vp-transcribe").textContent = t("btn_transcribe");
    el("lb-vp-name").textContent = t("lb_vp_name");
    el("vp-save").textContent = t("btn_vp_save");
    el("voices-done").textContent = t("btn_done");
  }

  async open() {
    this._reset();
    await this.load();
    el("voices-backdrop").hidden = false;
  }

  close() {
    el("voices-backdrop").hidden = true;
    el("preview").pause();
    if (this.onChanged) {
      this.onChanged();
    }
  }

  _reset() {
    this.pending = null;
    el("vp-file").value = "";
    el("vp-start").value = "0";
    el("vp-duration").value = "10";
    el("vp-text").value = "";
    el("vp-name").value = "";
    el("vp-clip-status").textContent = "";
    el("vp-text-status").textContent = "";
    el("voices-error").hidden = true;
  }

  _fail(message) {
    const node = el("voices-error");
    node.textContent = message;
    node.hidden = false;
  }

  async load() {
    try {
      const response = await fetch("/api/voicepacks", { cache: "no-store" });
      const data = await response.json();
      this.packs = data.voices || [];
    } catch (err) {
      this.packs = [];
    }
    this._render();
    return this.packs;
  }

  _render() {
    const list = el("voices-list");
    list.innerHTML = "";

    if (!this.packs.length) {
      const empty = document.createElement("p");
      empty.className = "field-note";
      empty.textContent = this.t("voices_empty");
      list.appendChild(empty);
      return;
    }

    for (const pack of this.packs) {
      const row = document.createElement("div");
      row.className = "voice-row";

      const name = document.createElement("span");
      name.className = "voice-name";
      name.textContent = pack.label;

      const meta = document.createElement("span");
      meta.className = "voice-meta";
      if (pack.missing) {
        meta.dataset.warn = "true";
        meta.textContent = this.t("voice_missing");
      } else {
        // No transcript means the clip is there but half the pair is not, and
        // cloning quality suffers without any error being raised.
        meta.dataset.warn = String(!pack.ref_text);
        meta.textContent = pack.ref_text
          ? format(this.t("voice_meta"), { duration: pack.duration })
          : format(this.t("voice_meta_notext"), { duration: pack.duration });
      }

      const actions = document.createElement("span");
      actions.className = "voice-actions";
      for (const [key, handler] of [
        ["btn_play", () => this._play(pack)],
        ["btn_rename", () => this._rename(pack)],
        ["btn_delete", () => this._delete(pack)],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost small";
        button.textContent = this.t(key);
        button.addEventListener("click", handler);
        actions.appendChild(button);
      }

      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  _play(pack) {
    const file = String(pack.file || "").split("/").pop();
    const audio = el("preview");
    audio.src =
      "/api/voice-file?name=" +
      encodeURIComponent(file.replace(/\.wav$/i, "")) +
      "&ts=" +
      Date.now();
    audio.play().catch(() => {});
  }

  async _rename(pack) {
    const label = window.prompt(this.t("voice_rename_prompt"), pack.label);
    if (!label || !label.trim() || label.trim() === pack.label) {
      return;
    }
    await this._post({ id: pack.id, label: label.trim(), file: pack.file, ref_text: pack.ref_text });
  }

  async _delete(pack) {
    if (!window.confirm(format(this.t("voice_delete_confirm"), { name: pack.label }))) {
      return;
    }
    try {
      const response = await fetch("/api/voicepacks?id=" + encodeURIComponent(pack.id), {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      this.packs = data.voices || [];
      this._render();
    } catch (err) {
      this._fail(this.t("err_voice_delete") + err.message);
    }
  }

  // Step one: cut a few seconds out of whatever was picked and normalise it.
  // Video is accepted because a clean sample is often easier to find in one.
  async _clip() {
    const file = el("vp-file").files[0];
    if (!file) {
      this._fail(this.t("err_no_file"));
      return;
    }
    const status = el("vp-clip-status");
    status.dataset.warn = "false";
    status.textContent = this.t("vp_clipping");
    el("voices-error").hidden = true;

    const name = clipName();
    const query =
      "?name=" +
      encodeURIComponent(name) +
      "&start=" +
      encodeURIComponent(el("vp-start").value || "0") +
      "&duration=" +
      encodeURIComponent(el("vp-duration").value || "10");

    try {
      const response = await fetch("/api/voices" + query, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      this.pending = { name: name, path: data.path };
      status.textContent = format(this.t("vp_clipped"), {
        duration: data.duration,
        rate: data.sample_rate,
      });
      if (!el("vp-name").value.trim()) {
        el("vp-name").value = file.name.replace(/\.[^.]+$/, "");
      }
    } catch (err) {
      status.dataset.warn = "true";
      status.textContent = "";
      this._fail(this.t("err_upload") + err.message);
    }
  }

  async _transcribe() {
    if (!this.pending) {
      this._fail(this.t("err_clip_first"));
      return;
    }
    const status = el("vp-text-status");
    status.textContent = this.t("transcribing");
    try {
      const response = await fetch(
        "/api/transcribe?file=" + encodeURIComponent(this.pending.name),
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      el("vp-text").value = data.text || "";
      status.textContent = this.t("transcribed");
    } catch (err) {
      status.textContent = "";
      this._fail(this.t("err_transcribe") + err.message);
    }
  }

  async _save() {
    const label = el("vp-name").value.trim();
    if (!this.pending) {
      this._fail(this.t("err_clip_first"));
      return;
    }
    if (!label) {
      this._fail(this.t("err_no_name"));
      return;
    }
    const ok = await this._post({
      label: label,
      file: this.pending.path,
      ref_text: el("vp-text").value.trim(),
    });
    if (ok) {
      this._reset();
    }
  }

  async _post(body) {
    try {
      const response = await fetch("/api/voicepacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      this.packs = data.voices || [];
      this._render();
      return true;
    } catch (err) {
      this._fail(this.t("err_voice_save") + err.message);
      return false;
    }
  }
}
