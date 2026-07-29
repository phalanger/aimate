// Text-model picker.
//
// The pipeline's LLM endpoint is fixed at startup, so it points at the panel's
// proxy and the provider becomes a runtime choice here. Switching takes effect
// on the next turn - nothing restarts, and the resident Whisper and TTS models
// are never touched.
//
// API keys are written to providers.json on disk and are never sent back to
// the browser; the panel only learns whether a key exists.

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

export class LlmSettings {
  constructor(options) {
    this.t = options.translate;
    this.onSaved = options.onSaved;
    this.config = null;
    this.selected = null;
    this.draft = {};
    this._bind();
  }

  _bind() {
    el("llm-fetch").addEventListener("click", () => this._fetchModels());
    el("llm-test").addEventListener("click", () => this._test());
    el("llm-save").addEventListener("click", () => this._save());

    el("llm-model-select").addEventListener("change", () => {
      el("llm-model-manual").value = el("llm-model-select").value;
    });

    // Keep the draft alive while the user flips between providers so a typed
    // key is not lost by clicking around.
    for (const id of ["llm-baseurl", "llm-key", "llm-model-manual"]) {
      el(id).addEventListener("input", () => this._captureDraft());
    }
  }

  applyStaticText() {
    const t = this.t;
    el("lb-provider").textContent = t("lb_provider");
    el("lb-baseurl").textContent = t("lb_baseurl");
    el("lb-key").textContent = t("lb_key");
    el("lb-model").textContent = t("lb_model");
    el("llm-fetch").textContent = t("btn_fetch");
    el("llm-test").textContent = t("btn_test");
    el("llm-cancel").textContent = t("btn_cancel");
    el("llm-save").textContent = t("btn_save");
    el("llm-model-manual").placeholder = t("llm_manual_hint");
  }

  async load() {
    const response = await fetch("/api/llm", { cache: "no-store" });
    this.config = await response.json();
    this._renderButton();
    return this.config;
  }

  _renderButton() {
    const active = this.config.providers[this.config.active];
    el("llm-provider").textContent = active ? active.label : "-";
    el("llm-model").textContent = (active && active.model) || this.t("llm_no_model");
    el("llm-button").dataset.local = String(!!(active && active.local));
  }

  // ---------- dialog ----------

  // The surrounding dialog is opened by SettingsDialog; this only refreshes
  // the section's own contents.
  prepare() {
    this.selected = this.config.active;
    this.draft = {};
    el("llm-error").hidden = true;
    el("llm-model-status").textContent = "";
    this._renderProviders();
    this._loadProviderIntoForm(this.selected);
  }

  _renderProviders() {
    const grid = el("llm-providers");
    grid.innerHTML = "";

    for (const [name, provider] of Object.entries(this.config.providers)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider";
      button.dataset.active = String(name === this.selected);

      const label = document.createElement("span");
      label.className = "provider-label";
      label.textContent = provider.label;

      const state = document.createElement("span");
      state.className = "provider-state";
      if (provider.local) {
        state.textContent = "";
      } else {
        state.textContent = provider.has_key || this.draft[name] ? "key" : "";
        state.dataset.ok = String(!!(provider.has_key || (this.draft[name] || {}).api_key));
      }

      button.appendChild(label);
      button.appendChild(state);
      button.addEventListener("click", () => {
        this._captureDraft();
        this.selected = name;
        this._renderProviders();
        this._loadProviderIntoForm(name);
      });
      grid.appendChild(button);
    }
  }

  _captureDraft() {
    if (!this.selected) {
      return;
    }
    this.draft[this.selected] = {
      base_url: el("llm-baseurl").value.trim(),
      api_key: el("llm-key").value,
      model: el("llm-model-manual").value.trim(),
    };
  }

  _loadProviderIntoForm(name) {
    const provider = this.config.providers[name];
    const draft = this.draft[name] || {};

    el("llm-baseurl").value = draft.base_url !== undefined ? draft.base_url : provider.base_url;
    el("llm-model-manual").value = draft.model !== undefined ? draft.model : provider.model;
    el("llm-key").value = draft.api_key || "";
    el("llm-key").placeholder = provider.has_key
      ? this.t("llm_key_saved")
      : this.t("llm_key_empty");

    el("llm-key-field").hidden = !provider.needs_key;
    el("llm-hint").textContent = provider.hint || "";

    const select = el("llm-model-select");
    select.innerHTML = "";
    const current = el("llm-model-manual").value;
    if (current) {
      const option = document.createElement("option");
      option.value = current;
      option.textContent = current;
      select.appendChild(option);
    }
    el("llm-model-status").textContent = "";
  }

  // ---------- actions ----------

  _fail(key, detail) {
    const node = el("llm-error");
    node.textContent = this.t(key) + (detail || "");
    node.hidden = false;
  }

  // Model lists are fetched from the provider rather than hardcoded: these
  // catalogues change often, and a stale built-in list is worse than none.
  async _fetchModels() {
    const status = el("llm-model-status");
    status.dataset.warn = "false";
    status.textContent = this.t("llm_fetching");
    el("llm-error").hidden = true;

    try {
      // Persist first: the server needs the key and base URL to make the call.
      await this._persist({ activate: false });

      const response = await fetch(
        "/api/llm/models?provider=" + encodeURIComponent(this.selected),
        { cache: "no-store" }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }

      const select = el("llm-model-select");
      const previous = el("llm-model-manual").value;
      select.innerHTML = "";
      for (const model of data.models) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        select.appendChild(option);
      }
      if (data.models.indexOf(previous) >= 0) {
        select.value = previous;
      } else if (data.models.length) {
        select.value = data.models[0];
        el("llm-model-manual").value = data.models[0];
      }
      status.textContent = format(this.t("llm_fetched"), { count: data.models.length });
    } catch (err) {
      status.dataset.warn = "true";
      status.textContent = "";
      this._fail("err_fetch", err.message);
    }
  }

  async _test() {
    const status = el("llm-model-status");
    status.dataset.warn = "false";
    status.textContent = this.t("llm_testing");
    el("llm-error").hidden = true;

    try {
      await this._persist({ activate: true });
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "from-config",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error((data.error || "").toString().slice(0, 200));
      }
      const reply = ((data.choices || [{}])[0].message || {}).content || "";
      status.textContent = format(this.t("llm_test_ok"), { reply: reply.trim().slice(0, 60) });
      await this.load();
    } catch (err) {
      status.dataset.warn = "true";
      status.textContent = "";
      this._fail("err_test", err.message);
    }
  }

  async _persist(options) {
    const model = el("llm-model-manual").value.trim();
    const payload = {
      provider: this.selected,
      base_url: el("llm-baseurl").value.trim(),
      model: model,
    };
    const key = el("llm-key").value;
    if (key) {
      payload.api_key = key;
    }
    if (options.activate) {
      payload.active = this.selected;
    }

    const response = await fetch("/api/llm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || response.status);
    }
    this.config = data;
    // The key is stored now; clear it from the form so it is not left lying
    // in the DOM.
    el("llm-key").value = "";
    if (this.draft[this.selected]) {
      this.draft[this.selected].api_key = "";
    }
    return data;
  }

  async _save() {
    if (!el("llm-model-manual").value.trim()) {
      return this._fail("err_need_model");
    }
    try {
      await this._persist({ activate: true });
      await this.load();
      if (this.onSaved) {
        this.onSaved();
      }
    } catch (err) {
      this._fail("err_llm_save", err.message);
    }
  }
}
