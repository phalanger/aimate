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
    this.config = null;
    this.editingId = null;
    this.voices = [];
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

    for (const id of ["ed-vrm", "ed-motion", "ed-live2d", "ed-idle-video", "ed-talk-video", "ed-mt-video"]) {
      el(id).addEventListener("change", () => this._captureAvatar());
    }
    el("ed-mt-id").addEventListener("input", () => this._captureAvatar());
    el("ed-rescan").addEventListener("click", () => this._loadAssets());

    el("ed-rules").addEventListener("click", () => {
      const box = el("ed-prompt");
      if (box.value.indexOf("markdown") < 0) {
        box.value = box.value.trimEnd() + this.t("rules_template");
      }
    });

    el("ed-voice").addEventListener("change", () => this._showVoiceInfo());
    for (const id of ["ed-vrm", "ed-live2d"]) {
      el(id).addEventListener("change", () => this._showLipsyncWarning());
    }
    el("ed-play").addEventListener("click", () => this._play());
    el("ed-upload").addEventListener("click", () => this._upload());
    el("ed-transcribe").addEventListener("click", () => this._transcribe());
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
    el("lb-upload").textContent = t("lb_upload");
    el("lb-start").textContent = t("lb_start");
    el("lb-duration").textContent = t("lb_duration");
    el("lb-reftext").textContent = t("lb_reftext");
    el("lb-avatar").textContent = t("lb_avatar");
    el("lb-vrm").textContent = t("lb_vrm");
    el("lb-motion").textContent = t("lb_motion");
    el("lb-live2d").textContent = t("lb_live2d");
    el("lb-idle-video").textContent = t("lb_idle_video");
    el("lb-talk-video").textContent = t("lb_talk_video");
    el("lb-video-note").textContent = t("lb_video_note");
    el("lb-mt-video").textContent = t("lb_mt_video");
    el("lb-mt-id").textContent = t("lb_mt_id");
    el("lb-mt-note").textContent = t("lb_mt_note");
    el("ed-mt-prepare").textContent = t("btn_mt_prepare");
    el("ed-rescan").textContent = t("btn_rescan");
    el("ed-rules").textContent = t("btn_rules");
    el("ed-play").textContent = t("btn_play");
    el("ed-upload").textContent = t("btn_upload");
    el("ed-transcribe").textContent = t("btn_transcribe");
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
    el("ed-reftext").value = character.ref_text || "";
    el("ed-start").value = "0";
    el("ed-duration").value = "10";
    el("ed-file").value = "";

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

    await this._loadVoices(character.voice);

    el("editor-backdrop").hidden = false;
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
    this._fillSelect("ed-mt-video", "video", this.avatar.idle_video);
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

  _renderAvatarTypes() {
    const grid = el("ed-avatar-types");
    grid.innerHTML = "";

    const types = [
      ["orb", this.t("avatar_orb")],
      ["vrm", this.t("avatar_vrm")],
      ["live2d", this.t("avatar_live2d")],
      ["video", this.t("avatar_video")],
      ["musetalk", this.t("avatar_musetalk")],
    ];

    for (const [value, label] of types) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider";
      button.dataset.active = String(value === this.avatar.type);
      button.textContent = label;
      button.addEventListener("click", () => {
        this.avatar.type = value;
        this._renderAvatarTypes();
        this._showLipsyncWarning();
      });
      grid.appendChild(button);
    }

    // Only show the fields the chosen renderer actually reads.
    el("ed-vrm-field").hidden = this.avatar.type !== "vrm";
    el("ed-motion-field").hidden = this.avatar.type !== "vrm";
    el("ed-live2d-field").hidden = this.avatar.type !== "live2d";
    el("ed-video-field").hidden = this.avatar.type !== "video";
    el("ed-musetalk-field").hidden = this.avatar.type !== "musetalk";
  }

  _captureAvatar() {
    this.avatar.vrm = el("ed-vrm").value;
    this.avatar.motion = el("ed-motion").value;
    this.avatar.live2d = el("ed-live2d").value;
    this.avatar.talk_video = el("ed-talk-video").value;
    this.avatar.avatar_id = el("ed-mt-id").value.trim();
    // Both renderers read idle_video; whichever field is visible wins.
    this.avatar.idle_video =
      this.avatar.type === "musetalk" ? el("ed-mt-video").value : el("ed-idle-video").value;
  }

  // ---------- voices ----------

  async _loadVoices(selectedPath) {
    const response = await fetch("/api/voices", { cache: "no-store" });
    const data = await response.json();
    this.voices = data.voices || [];

    const select = el("ed-voice");
    select.innerHTML = "";

    const none = document.createElement("option");
    none.value = "";
    none.textContent = this.t("voice_none");
    select.appendChild(none);

    for (const voice of this.voices) {
      const option = document.createElement("option");
      option.value = voice.path;
      option.textContent = voice.name;
      select.appendChild(option);
    }

    if (selectedPath) {
      // Config may carry a path from another machine; match on the file name
      // so an imported characters.json still resolves.
      const wanted = String(selectedPath).replace(/\\/g, "/").split("/").pop();
      const match = this.voices.find((v) => v.path.split("/").pop() === wanted);
      select.value = match ? match.path : "";
    }

    this._showVoiceInfo();
  }

  _selectedVoice() {
    const path = el("ed-voice").value;
    return this.voices.find((v) => v.path === path) || null;
  }

  _showVoiceInfo() {
    const note = el("ed-voice-info");
    const voice = this._selectedVoice();
    if (!voice) {
      note.textContent = "";
      note.dataset.warn = "false";
      return;
    }
    if (voice.normalised) {
      note.dataset.warn = "false";
      note.textContent = format(this.t("voice_ok"), {
        duration: voice.duration,
        rate: voice.sample_rate,
        channels: voice.channels,
      });
    } else {
      note.dataset.warn = "true";
      note.textContent =
        format(this.t("voice_ok"), {
          duration: voice.duration,
          rate: voice.sample_rate,
          channels: voice.channels,
        }) +
        " - " +
        this.t("voice_warn");
    }
  }

  _play() {
    const voice = this._selectedVoice();
    if (!voice) {
      return;
    }
    // Served through the API: the voices folder lives outside the panel
    // directory, so it is not reachable as a static path.
    const audio = el("preview");
    audio.src = "/api/voice-file?name=" + encodeURIComponent(voice.name) + "&ts=" + Date.now();
    audio.play().catch(() => {});
  }

  async _upload() {
    const file = el("ed-file").files[0];
    if (!file) {
      return;
    }
    const status = el("ed-upload-status");
    status.dataset.warn = "false";
    status.textContent = this.t("uploading");

    // Name the clip after the character being edited so files stay traceable.
    const base = (el("ed-label").value.trim() || "voice").replace(/[^A-Za-z0-9_-]/g, "");
    const name = (base || "voice") + "-" + Date.now().toString(36);

    const query = new URLSearchParams({
      name: name,
      start: el("ed-start").value || "0",
      duration: el("ed-duration").value || "10",
    });

    try {
      const response = await fetch("/api/voices?" + query.toString(), {
        method: "POST",
        body: file,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      await this._loadVoices(data.path);
      status.textContent = format(this.t("upload_done"), {
        name: data.name,
        duration: data.duration,
        rate: data.sample_rate,
      });
    } catch (err) {
      status.dataset.warn = "true";
      status.textContent = this.t("err_upload") + err.message;
    }
  }

  async _transcribe() {
    const voice = this._selectedVoice();
    if (!voice) {
      return;
    }
    const status = el("ed-transcribe-status");
    status.dataset.warn = "false";
    status.textContent = this.t("transcribing");

    try {
      const response = await fetch(
        "/api/transcribe?file=" + encodeURIComponent(voice.name) + "&language=zh",
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      el("ed-reftext").value = data.text || "";
      status.textContent = this.t("transcribe_done");
    } catch (err) {
      status.dataset.warn = "true";
      status.textContent = this.t("err_transcribe") + err.message;
    }
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
    status.textContent = this.t("mt_preparing");

    try {
      const response = await fetch("/api/musetalk/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar_id: avatarId, video_path: video }),
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
    el("ed-upload-status").textContent = "";
    el("ed-transcribe-status").textContent = "";
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
      voice: voice ? voice.path : "",
      ref_text: el("ed-reftext").value.trim(),
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
