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
    // Which cloning mode the pipeline runs in, learned from the server on
    // load. Assume the one that needs a transcript until told otherwise, so a
    // failed load never hides a field that turns out to be required.
    this.cloneMode = "icl";
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
    // lb-voice-new-note is not set here: it depends on the cloning mode, and
    // _applyCloneMode owns it.
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

  // Errors go above the list, not at the foot of the dialog.
  //
  // The refusal to delete a voice a character still uses worked exactly as
  // intended and was invisible: the message rendered three screens below the
  // button that had just been pressed, so it read as "nothing happened". The
  // user made a second copy of the voice, which is the failure this guard
  // exists to prevent.
  _fail(message) {
    for (const id of ["voices-error", "voices-error-top"]) {
      const node = document.getElementById(id);
      if (node) {
        node.textContent = message;
        node.hidden = false;
      }
    }
  }

  _warn(message) {
    const node = document.getElementById("voices-error-top");
    if (node) {
      node.textContent = message;
      node.hidden = false;
      node.dataset.tone = "warn";
    }
  }

  _clearMessages() {
    for (const id of ["voices-error", "voices-error-top"]) {
      const node = document.getElementById(id);
      if (node) {
        node.hidden = true;
        node.dataset.tone = "";
      }
    }
  }

  async load() {
    try {
      const response = await fetch("/api/voicepacks", { cache: "no-store" });
      const data = await response.json();
      this.packs = data.voices || [];
      this.cloneMode = data.clone_mode || "icl";
    } catch (err) {
      this.packs = [];
    }
    this._applyCloneMode();
    this._render();
    return this.packs;
  }

  // The pipeline can clone in either of two modes, and they disagree about
  // whether a voice needs a transcript. Under ICL it is required. Under
  // xvec_only the library throws it away before the model sees it, so the
  // field, the recognise button and the "no transcript, quality suffers"
  // badge are all asking for or complaining about something nothing reads.
  //
  // Driven by what the pipeline is actually configured with rather than by a
  // setting of its own: the mode lives on a command line in services.json,
  // and a second switch here could only ever disagree with it.
  _applyCloneMode() {
    const usesText = this.cloneMode !== "xvec_only";
    el("vp-text-step").hidden = !usesText;
    el("lb-voice-new-note").textContent = this.t(
      usesText ? "lb_voice_new_note" : "lb_voice_new_note_xvec"
    );
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
        // cloning quality suffers without any error being raised. Only true in
        // ICL mode - see _applyCloneMode - and a warning that is not true is
        // worse than no warning.
        const wantsText = this.cloneMode !== "xvec_only" && !pack.ref_text;
        meta.dataset.warn = String(wantsText);
        meta.textContent = wantsText
          ? format(this.t("voice_meta_notext"), { duration: pack.duration })
          : format(this.t("voice_meta"), { duration: pack.duration });
      }

      const actions = document.createElement("span");
      actions.className = "voice-actions";
      // Renaming and deleting still work on a voice whose clip has gone -
      // deleting it is the likeliest thing the user wants. The two that read
      // the audio do not.
      //
      // Re-transcribing is left out entirely in xvec_only mode. It does not
      // just write text nothing reads: it also shortens the clip to end on a
      // phrase boundary, which is a real edit to the audio in aid of a mode
      // that is not running.
      const buttons = [["btn_play", () => this._play(pack), true]];
      if (this.cloneMode !== "xvec_only") {
        buttons.push(["btn_retranscribe", (button) => this._retranscribe(pack, button), true]);
      }
      buttons.push(["btn_rename", () => this._rename(pack), false]);
      buttons.push(["btn_delete", () => this._delete(pack), false]);
      for (const [key, handler, needsClip] of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost small";
        button.textContent = this.t(key);
        button.disabled = needsClip && pack.missing;
        button.addEventListener("click", () => handler(button));
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

  // Re-read the clip and store what it actually says. Slow - Whisper loads
  // from cold each time - so the button says so and stops taking clicks.
  //
  // It can also shorten the clip: a phrase the original cut left unfinished is
  // dropped from the audio as well as from the text, because a transcript that
  // does not match its audio is what puts a stray syllable in front of every
  // reply. Hence the confirmation - the clip changes, not just the text.
  async _retranscribe(pack, button) {
    if (!window.confirm(format(this.t("voice_retranscribe_confirm"), { name: pack.label }))) {
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = this.t("transcribing");
    try {
      const response = await fetch(
        "/api/voicepacks/retranscribe?id=" + encodeURIComponent(pack.id),
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      this.packs = data.voices || [];
      // The list redraws with the new transcript and length; the editor picks
      // both up when the dialog closes, which is the only time it can see them.
      this._render();
    } catch (err) {
      button.disabled = false;
      button.textContent = label;
      this._fail(this.t("err_transcribe") + err.message);
    }
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
      // The two wordings differ only in what they tell you to do next, and
      // one of those steps is not on screen in xvec_only mode.
      let note = format(
        this.t(this.cloneMode === "xvec_only" ? "vp_clipped_xvec" : "vp_clipped"),
        { duration: data.duration, rate: data.sample_rate }
      );
      // Both of these used to happen in silence. Asking for 21 seconds and
      // getting 15 is the sort of thing you only discover by measuring the
      // file, and a cut through the middle of a sentence is what leaves the
      // transcript claiming words the audio never reaches.
      if (data.clamped_to) {
        note += " " + format(this.t("vp_clamped"), {
          requested: data.requested,
          max: data.clamped_to,
        });
        status.dataset.warn = "true";
      }
      // Only worth saying in ICL mode. A cut through the middle of a word is
      // what makes the cloner speak the missing tail before every reply, and
      // that is an ICL artefact - a speaker embedding is averaged over the
      // whole clip and does not care how the last syllable ends.
      if (data.ends_mid_speech && this.cloneMode !== "xvec_only") {
        note += " " + this.t("vp_mid_speech");
        status.dataset.warn = "true";
      }
      status.textContent = note;
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
      // Saved, but worth saying something about. Neither of these is wrong
      // enough to refuse - a second voice with the same name is occasionally
      // deliberate, and so is a clip that runs to the edge of a phrase - but
      // both are usually a mistake that only shows up much later, as a voice
      // that says half a sentence before every reply.
      for (const warning of data.warnings || []) {
        if (warning === "duplicate_label") {
          this._warn(this.t("vp_warn_duplicate"));
        } else if (warning === "ends_mid_speech" && this.cloneMode !== "xvec_only") {
          this._warn(this.t("vp_warn_mid_speech"));
        }
      }
      return true;
    } catch (err) {
      this._fail(this.t("err_voice_save") + err.message);
      return false;
    }
  }
}
