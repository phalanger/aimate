// Character editor.
//
// Edits characters.json through the panel API. Voice cloning needs a matched
// pair - a short reference clip and its exact transcript - so uploading audio
// and filling in the reference text live in the same dialog rather than being
// separate chores.

function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error("missing element: " + id);
  }
  return node;
}

// Grow a text box to the height of its content.
//
// The persona field is the long one, and at a fixed nine rows it scrolled
// inside a dialog that also scrolls - two bars for one piece of text. Height is
// cleared before it is read because scrollHeight cannot shrink below the height
// already set, so without the reset the box would only ever get taller.
//
// CSS caps it with max-height; past that it scrolls again, and this stops
// fighting it because scrollHeight then exceeds the cap and the assignment is
// clamped.
function fitToContent(box) {
  box.style.height = "auto";
  box.style.height = box.scrollHeight + "px";
}

function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined ? match : String(values[key])
  );
}

// Character ids are used as object keys and must stay stable and safe; the
// label is free text, so derive an id instead of reusing it.
function makeId(existing) {
  let n = 1;
  while (existing.indexOf("char" + n) >= 0) {
    n += 1;
  }
  return "char" + n;
}

export class CharacterEditor {
  constructor(options) {
    this.t = options.translate;
    this.onSaved = options.onSaved;
    this.onManageVoices = options.onManageVoices;
    this.selectedVoiceId = "";
    this.legacyVoicePath = "";
    this.config = null;
    this.editingId = null;
    this.voices = [];
    // Learned from the server with the voice list; see _loadVoices.
    this.cloneMode = "icl";
    this.assets = {};

    this._bind();
  }

  _bind() {
    el("editor-close").addEventListener("click", () => this.close());
    el("ed-cancel").addEventListener("click", () => this.close());
    el("editor-backdrop").addEventListener("click", (event) => {
      if (event.target === el("editor-backdrop")) {
        this.close();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el("editor-backdrop").hidden) {
        this.close();
      }
    });

    for (const id of [
      "ed-vrm",
      "ed-motion",
      "ed-live2d",
      "ed-idle-video",
      "ed-talk-video",
      "ed-mt-idle",
      "ed-mt-video",
    ]) {
      el(id).addEventListener("change", () => this._captureAvatar());
    }
    el("ed-avatar-type").addEventListener("change", (event) => {
      this.avatar.type = event.target.value;
      this._renderAvatarTypes();
      this._showLipsyncWarning();
    });
    el("ed-mt-id").addEventListener("input", () => this._captureAvatar());
    el("ed-rescan").addEventListener("click", () => this._loadAssets());

    el("ed-rules").addEventListener("click", () => {
      const box = el("ed-prompt");
      if (box.value.indexOf("markdown") < 0) {
        box.value = box.value.trimEnd() + this.t("rules_template");
      }
      fitToContent(box);
    });
    el("ed-prompt").addEventListener("input", (event) => fitToContent(event.target));

    el("ed-voice").addEventListener("change", () => this._showVoiceInfo());
    for (const id of ["ed-vrm", "ed-live2d"]) {
      el(id).addEventListener("change", () => this._showLipsyncWarning());
    }
    el("ed-play").addEventListener("click", () => this._play());
    el("ed-manage-voices").addEventListener("click", async () => {
      // Making a voice is a four step sequence of its own; it lives in the
      // voice library, and this dialog only picks one that already exists.
      if (this.onManageVoices) {
        await this.onManageVoices();
        await this._loadVoices(this.selectedVoiceId);
      }
    });
    el("ed-mt-prepare").addEventListener("click", () => this._prepareMuseTalk());
    el("ed-save").addEventListener("click", () => this._save());
    el("ed-delete").addEventListener("click", () => this._delete());
  }

  applyStaticText() {
    const t = this.t;
    el("lb-name").textContent = t("lb_name");
    el("lb-subtitle").textContent = t("lb_subtitle");
    el("lb-prompt").textContent = t("lb_prompt");
    el("lb-voice").textContent = t("lb_voice");
    el("lb-avatar").textContent = t("lb_avatar");
    el("lb-vrm").textContent = t("lb_vrm");
    el("lb-motion").textContent = t("lb_motion");
    el("lb-live2d").textContent = t("lb_live2d");
    el("lb-idle-video").textContent = t("lb_idle_video");
    el("lb-talk-video").textContent = t("lb_talk_video");
    el("lb-video-note").textContent = t("lb_video_note");
    el("lb-mt-idle").textContent = t("lb_mt_idle");
    el("lb-mt-video").textContent = t("lb_mt_video");
    el("lb-mt-id").textContent = t("lb_mt_id");
    el("lb-mt-note").textContent = t("lb_mt_note");
    el("ed-mt-prepare").textContent = t("btn_mt_prepare");
    el("ed-rescan").textContent = t("btn_rescan");
    el("ed-rules").textContent = t("btn_rules");
    el("ed-play").textContent = t("btn_play");
    el("ed-manage-voices").textContent = t("btn_manage_voices");
    el("ed-save").textContent = t("btn_save");
    el("ed-cancel").textContent = t("btn_cancel");
    el("ed-delete").textContent = t("btn_delete");
  }

  async open(config, id) {
    this.config = JSON.parse(JSON.stringify(config));
    this.editingId = id;

    const isNew = !id;
    el("editor-title").textContent = this.t(isNew ? "editor_new" : "editor_edit");
    el("ed-delete").hidden = isNew;
    this._clearStatus();

    const character = isNew ? {} : this.config.characters[id] || {};
    el("ed-label").value = character.label || "";
    el("ed-subtitle").value = character.subtitle || "";
    el("ed-prompt").value = character.system_prompt || this.t("rules_template").trimStart();
    // voice_id is the current form. A config written before the library
    // existed only has the clip path, so fall back to matching on that - the
    // migration keys voices by file, so the same clip is the same voice.
    this.selectedVoiceId = character.voice_id || "";
    this.legacyVoicePath = character.voice || "";

    const avatar = character.avatar || {};
    this.avatar = {
      type: avatar.type || "orb",
      vrm: avatar.vrm || "",
      motion: avatar.motion || "",
      live2d: avatar.live2d || "",
      avatar_id: avatar.avatar_id || "",
      idle_video: avatar.idle_video || "",
      talk_video: avatar.talk_video || "",
    };
    el("ed-mt-id").value = this.avatar.avatar_id;
    // Options come from the folder scan; selecting a value before the options
    // exist would silently reset it to empty.
    await this._loadAssets();
    this._renderAvatarTypes();

    await this._loadVoices(this.selectedVoiceId, this.legacyVoicePath);

    el("editor-backdrop").hidden = false;
    // Only once the dialog is on screen: a hidden element reports a
    // scrollHeight of zero, which would size the persona box to nothing.
    fitToContent(el("ed-prompt"));
    el("ed-label").focus();
  }

  close() {
    el("editor-backdrop").hidden = true;
    el("preview").pause();
  }

  // ---------- avatar ----------

  // Populated by scanning the asset folders rather than typed. A path typed by
  // hand is a path that can be wrong, and a wrong one shows up much later as a
  // blank stage with nothing pointing at the cause.
  async _loadAssets() {
    try {
      const response = await fetch("/api/assets", { cache: "no-store" });
      this.assets = await response.json();
    } catch (err) {
      this.assets = {};
    }

    this._fillSelect("ed-vrm", "vrm", this.avatar.vrm, "dir-vrm");
    this._fillSelect("ed-motion", "motion", this.avatar.motion, "dir-motion");
    this._fillSelect("ed-live2d", "live2d", this.avatar.live2d, "dir-live2d");
    this._fillSelect("ed-idle-video", "video", this.avatar.idle_video);
    this._fillSelect("ed-talk-video", "video", this.avatar.talk_video);
    // Lip sync needs both, and they are different kinds of thing: the clip
    // loops between turns, the still is what frames are generated from.
    this._fillSelect("ed-mt-idle", "video", this.avatar.idle_video);
    this._fillSelect("ed-mt-video", "image", this.avatar.talk_video);
    this._showLipsyncWarning();
  }

  _showLipsyncWarning() {
    const kind = this.avatar.type === "live2d" ? "live2d" : "vrm";
    const selected = this.avatar.type === "live2d" ? el("ed-live2d").value : el("ed-vrm").value;
    const group = this.assets && this.assets[kind];
    const item = ((group && group.items) || []).find((entry) => entry.path === selected);

    const note = el(kind === "live2d" ? "dir-live2d" : "dir-vrm");
    if (item && item.lipsync === false) {
      note.dataset.warn = "true";
      note.textContent = this.t("warn_no_lipsync");
    } else if (group) {
      note.dataset.warn = "false";
      note.textContent = format(this.t("dir_hint"), { dir: group.dir });
    }
  }

  _fillSelect(selectId, kind, current, hintId) {
    const group = this.assets && this.assets[kind];
    const select = el(selectId);
    select.innerHTML = "";

    const none = document.createElement("option");
    none.value = "";
    none.textContent = this.t("asset_none");
    select.appendChild(none);

    const items = (group && group.items) || [];
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.path;
      // Flagged in the list rather than discovered later: a model with no
      // mouth parameters looks exactly like a broken pipeline once it is
      // running.
      option.textContent =
        item.lipsync === false
          ? format(this.t("asset_no_lipsync"), { name: item.name })
          : item.name;
      select.appendChild(option);
    }

    // A configured file that is no longer on disk stays selectable and is
    // labelled as missing, rather than silently reverting to none and losing
    // the setting.
    if (current && !items.some((item) => item.path === current)) {
      const stale = document.createElement("option");
      stale.value = current;
      stale.textContent = format(this.t("asset_missing"), { path: current });
      select.appendChild(stale);
    }
    select.value = current || "";

    if (hintId && group) {
      el(hintId).textContent = format(this.t("dir_hint"), { dir: group.dir });
    }
  }

  // A single-choice list of five, so a select rather than a row of buttons:
  // the buttons took a whole row and pushed the fields that actually need
  // filling in below the fold.
  _renderAvatarTypes() {
    const types = ["orb", "vrm", "live2d", "video", "musetalk"];
    const select = el("ed-avatar-type");
    if (!select.options.length) {
      for (const value of types) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = this.t("avatar_" + value);
        select.appendChild(option);
      }
    }
    if (types.indexOf(this.avatar.type) < 0) {
      this.avatar.type = "orb";
    }
    select.value = this.avatar.type;
    el("ed-avatar-note").textContent = this.t("avatar_note_" + this.avatar.type);

    // Only show the fields the chosen renderer actually reads.
    el("ed-vrm-field").hidden = this.avatar.type !== "vrm";
    el("ed-motion-field").hidden = this.avatar.type !== "vrm";
    el("ed-live2d-field").hidden = this.avatar.type !== "live2d";
    el("ed-video-field").hidden = this.avatar.type !== "video";
    el("ed-musetalk-field").hidden = this.avatar.type !== "musetalk";
  }

  _captureAvatar() {
    this.avatar.vrm = el("ed-vrm").value;
    this.avatar.live2d = el("ed-live2d").value;
    this.avatar.motion = el("ed-motion").value;
    this.avatar.avatar_id = el("ed-mt-id").value.trim();

    // Read only the fields the visible group owns. Lip sync needs both a clip
    // and a still and they are not interchangeable - reading them from the
    // wrong pair is how the reference image ended up saved as idle_video,
    // which silently replaced the looping clip with a single frame.
    if (this.avatar.type === "musetalk") {
      this.avatar.idle_video = el("ed-mt-idle").value;
      this.avatar.talk_video = el("ed-mt-video").value;
    } else {
      this.avatar.idle_video = el("ed-idle-video").value;
      this.avatar.talk_video = el("ed-talk-video").value;
    }
  }

  // ---------- voices ----------

  // Voices are picked here, never built here. The clip and its transcript are
  // one record in the library, so this only has to remember which one.
  async _loadVoices(selectedId, legacyPath) {
    try {
      const response = await fetch("/api/voicepacks", { cache: "no-store" });
      const data = await response.json();
      this.voices = data.voices || [];
      // Same endpoint, same reason as in the voice library: whether a missing
      // transcript is worth flagging depends on the pipeline's cloning mode.
      // Default to the mode that needs one, so a failed fetch over-warns
      // rather than staying quiet about a real problem.
      this.cloneMode = data.clone_mode || "icl";
    } catch (err) {
      this.voices = [];
    }
    // Resolved after the list is in hand, not before: matching a legacy clip
    // path needs the list to match against.
    if (!selectedId) {
      selectedId = this._idForPath(legacyPath);
    }

    const select = el("ed-voice");
    select.innerHTML = "";

    const none = document.createElement("option");
    none.value = "";
    none.textContent = this.t("voice_none");
    select.appendChild(none);

    for (const voice of this.voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.label;
      select.appendChild(option);
    }

    select.value = this.voices.some((v) => v.id === selectedId) ? selectedId : "";
    this.selectedVoiceId = select.value;
    this._showVoiceInfo();
  }

  _selectedVoice() {
    return this.voices.find((v) => v.id === el("ed-voice").value) || null;
  }

  _idForPath(path) {
    if (!path) {
      return "";
    }
    const wanted = String(path).replace(/\\/g, "/").split("/").pop();
    const match = this.voices.find((v) => String(v.file).split("/").pop() === wanted);
    return match ? match.id : "";
  }

  _showVoiceInfo() {
    const note = el("ed-voice-info");
    const voice = this._selectedVoice();
    this.selectedVoiceId = voice ? voice.id : "";
    if (!voice) {
      note.textContent = "";
      note.dataset.warn = "false";
      return;
    }
    if (voice.missing) {
      note.dataset.warn = "true";
      note.textContent = this.t("voice_missing");
      return;
    }
    // Flagged rather than blocked: it still speaks without a transcript, just
    // less like the sample. In xvec_only mode not even that - the transcript
    // never reaches the model - so there is nothing to flag.
    const wantsText = this.cloneMode !== "xvec_only" && !voice.ref_text;
    note.dataset.warn = String(wantsText);
    note.textContent = wantsText
      ? format(this.t("voice_meta_notext"), { duration: voice.duration })
      : format(this.t("voice_meta"), { duration: voice.duration });
  }

  _play() {
    const voice = this._selectedVoice();
    if (!voice || voice.missing) {
      return;
    }
    // Served through the API: the voices folder lives outside the panel
    // directory, so it is not reachable as a static path.
    const name = String(voice.file).split("/").pop().replace(/\.wav$/i, "");
    const audio = el("preview");
    audio.src = "/api/voice-file?name=" + encodeURIComponent(name) + "&ts=" + Date.now();
    audio.play().catch(() => {});
  }

  // Preparation walks every frame doing face detection and VAE encoding, so
  // it takes a minute or two. It only happens once per avatar - after that the
  // cache on disk is reused.
  async _prepareMuseTalk() {
    const status = el("ed-mt-status");
    const video = el("ed-mt-video").value.trim();
    const avatarId = el("ed-mt-id").value.trim();
    if (!video || !avatarId) {
      return;
    }
    status.dataset.warn = "false";

    // Checked first because the service takes about a minute to put its models
    // on the GPU, and the panel is usable long before that. Going straight to
    // prepare during that window fails with a raw "connection refused", which
    // reads as a broken install rather than as "not up yet".
    try {
      const health = await fetch("/api/musetalk/status", { cache: "no-store" });
      const state = await health.json();
      if (!state.up) {
        status.dataset.warn = "true";
        status.textContent = this.t("mt_not_ready");
        return;
      }
    } catch (err) {
      // The panel itself is unreachable; let the attempt below report it.
    }

    status.textContent = this.t("mt_preparing");

    try {
      const response = await fetch("/api/musetalk/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // idle_video goes along because the FlashHead backend frames the
        // reference still to match it - without it every reply would start
        // with the face jumping to a different size.
        body: JSON.stringify({
          avatar_id: avatarId,
          video_path: video,
          idle_video: el("ed-mt-idle").value,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      status.textContent = format(this.t("mt_prepared"), {
        frames: (data.avatar || {}).frames || 0,
      });
    } catch (err) {
      status.dataset.warn = "true";
      status.textContent = this.t("err_mt_prepare") + err.message;
    }
  }

  // ---------- persistence ----------

  _clearStatus() {
    el("editor-error").hidden = true;
    el("ed-voice-info").textContent = "";
  }

  _fail(key, detail) {
    const node = el("editor-error");
    node.textContent = this.t(key) + (detail || "");
    node.hidden = false;
  }

  async _save() {
    const label = el("ed-label").value.trim();
    const prompt = el("ed-prompt").value.trim();
    if (!label) {
      return this._fail("err_need_name");
    }
    if (!prompt) {
      return this._fail("err_need_prompt");
    }

    const id = this.editingId || makeId(Object.keys(this.config.characters));
    const voice = this._selectedVoice();

    // Merge rather than replace: characters carry fields this dialog does not
    // expose (avatar model, idle emotion), and overwriting the object would
    // silently drop them on every edit.
    this._captureAvatar();
    const existing = this.config.characters[id] || {};
    this.config.characters[id] = Object.assign({}, existing, {
      label: label,
      subtitle: el("ed-subtitle").value.trim(),
      voice_id: voice ? voice.id : "",
      // voice and ref_text are written from the chosen voice rather than
      // edited here. They stay because the pipeline is handed a clip path at
      // session.update time and reads it from this field; voice_id is what the
      // UI works in, and this keeps the two from disagreeing.
      voice: voice ? voice.file : "",
      ref_text: voice ? voice.ref_text || "" : "",
      system_prompt: prompt,
      avatar: Object.assign({}, existing.avatar, this.avatar),
    });

    await this._persist(id);
  }

  async _delete() {
    const ids = Object.keys(this.config.characters);
    if (ids.length <= 1) {
      return this._fail("err_last_character");
    }
    if (!window.confirm(this.t("confirm_delete"))) {
      return;
    }
    delete this.config.characters[this.editingId];
    if (this.config.default === this.editingId) {
      this.config.default = Object.keys(this.config.characters)[0];
    }
    await this._persist(null);
  }

  async _persist(activeId) {
    try {
      const response = await fetch("/api/characters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.config),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      this.close();
      if (this.onSaved) {
        await this.onSaved(this.config, activeId);
      }
    } catch (err) {
      this._fail("err_save", err.message);
    }
  }
}
