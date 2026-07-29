// Settings dialog.
//
// Everything except the text-model section is generated from settings.json.
// That file carries labels, ranges, help text and dependencies next to the
// values, so adding a new switch is one JSON entry - no markup, no code here.
// The alternative, a hand-written control per option, is what turns a settings
// screen into the place changes go to rot.
//
// Values are read once at startup into a shared store the rest of the app
// reads synchronously, and written back on change.

const STORE = {
  values: {},
  raw: null,
};

export function setting(key, fallback) {
  return STORE.values[key] !== undefined ? STORE.values[key] : fallback;
}

export async function loadSettings() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  STORE.raw = await response.json();
  STORE.values = {};
  for (const group of STORE.raw.groups || []) {
    for (const item of group.items || []) {
      if (item.value !== undefined) {
        STORE.values[item.key] = item.value;
      }
    }
  }
  return STORE.raw;
}

function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error("missing element: " + id);
  }
  return node;
}

// "wait_for_complete_turn" or "!wait_for_complete_turn"
function dependencyMet(expression) {
  if (!expression) {
    return true;
  }
  const negated = expression.startsWith("!");
  const key = negated ? expression.slice(1) : expression;
  const value = !!STORE.values[key];
  return negated ? !value : value;
}

export class SettingsDialog {
  constructor(options) {
    this.t = options.translate;
    this.llm = options.llm;
    this.onChange = options.onChange;
    this.section = "llm";
    this._bind();
  }

  _bind() {
    el("settings-close").addEventListener("click", () => this.close());
    el("llm-cancel").addEventListener("click", () => this.close());
    el("settings-backdrop").addEventListener("click", (event) => {
      if (event.target === el("settings-backdrop")) {
        this.close();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el("settings-backdrop").hidden) {
        this.close();
      }
    });
  }

  applyStaticText() {
    el("settings-title").textContent = this.t("settings_title");
  }

  open(section) {
    this.section = section || "llm";
    this._renderNav();
    this._renderGeneric();
    this._showSection(this.section);
    el("settings-backdrop").hidden = false;
  }

  close() {
    el("settings-backdrop").hidden = true;
  }

  _sections() {
    const list = [{ id: "llm", label: this.t("settings_llm") }];
    for (const group of (STORE.raw && STORE.raw.groups) || []) {
      list.push({ id: group.id, label: group.label });
    }
    return list;
  }

  _renderNav() {
    const nav = el("settings-nav");
    nav.innerHTML = "";
    for (const section of this._sections()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-tab";
      button.dataset.active = String(section.id === this.section);
      button.textContent = section.label;
      button.addEventListener("click", () => {
        this.section = section.id;
        this._renderNav();
        this._showSection(section.id);
      });
      nav.appendChild(button);
    }
  }

  _showSection(id) {
    el("section-llm").hidden = id !== "llm";
    for (const node of el("settings-generic").children) {
      node.hidden = node.dataset.group !== id;
    }
    // Saving is per-control for generic settings; only the model section has
    // a save button, so the footer follows it.
    el("llm-save").hidden = id !== "llm";
    el("llm-test").hidden = id !== "llm";
  }

  _renderGeneric() {
    const host = el("settings-generic");
    host.innerHTML = "";

    for (const group of (STORE.raw && STORE.raw.groups) || []) {
      const section = document.createElement("section");
      section.className = "settings-section";
      section.dataset.group = group.id;
      section.hidden = true;

      if (group.help) {
        const help = document.createElement("p");
        help.className = "field-note";
        help.textContent = group.help;
        section.appendChild(help);
      }

      for (const item of group.items || []) {
        section.appendChild(this._control(item));
      }
      host.appendChild(section);
    }
  }

  _control(item) {
    const wrap = document.createElement("div");
    wrap.className = "setting";
    wrap.dataset.key = item.key;
    wrap.hidden = !dependencyMet(item.depends);

    const head = document.createElement("div");
    head.className = "setting-head";

    const label = document.createElement("span");
    label.className = "setting-label";
    label.textContent = item.label;
    head.appendChild(label);
    wrap.appendChild(head);

    // Links are informational, so they get the full width rather than being
    // squeezed into the control column next to a label.
    if (item.type === "links") {
      wrap.classList.add("setting-links");
      if (item.help) {
        const help = document.createElement("p");
        help.className = "field-note";
        help.textContent = item.help;
        wrap.appendChild(help);
      }
      const list = document.createElement("div");
      list.className = "link-list";
      for (const link of item.links || []) {
        const anchor = document.createElement("a");
        anchor.className = "link-item";
        anchor.href = link.url;
        anchor.target = "_blank";
        // noopener: these open on the public internet, and the panel holds
        // API keys in the same origin.
        anchor.rel = "noopener noreferrer";
        anchor.textContent = link.label;
        const host = document.createElement("span");
        host.className = "link-host";
        try {
          host.textContent = new URL(link.url).hostname;
        } catch (err) {
          host.textContent = "";
        }
        anchor.appendChild(host);
        list.appendChild(anchor);
      }
      wrap.appendChild(list);
      return wrap;
    }

    let input;
    if (item.type === "bool") {
      input = document.createElement("button");
      input.type = "button";
      input.className = "switch";
      input.dataset.on = String(!!STORE.values[item.key]);
      input.addEventListener("click", () => {
        const next = input.dataset.on !== "true";
        input.dataset.on = String(next);
        this._save(item.key, next);
      });
    } else if (item.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.className = "setting-number";
      input.value = STORE.values[item.key];
      if (item.min !== undefined) input.min = item.min;
      if (item.max !== undefined) input.max = item.max;
      if (item.step !== undefined) input.step = item.step;
      input.addEventListener("change", () => {
        this._save(item.key, parseFloat(input.value));
      });
    } else if (item.type === "color") {
      input = document.createElement("input");
      input.type = "color";
      input.className = "setting-color";
      input.value = STORE.values[item.key];
      // "input" rather than "change": a colour is judged against the picture
      // behind it, and waiting for the picker to close means judging it blind.
      // The write is debounced so dragging the wheel is not one request a frame.
      input.addEventListener("input", () => {
        STORE.values[item.key] = input.value;
        if (this.onChange) {
          this.onChange(item.key, input.value);
        }
        clearTimeout(this.colorTimer);
        this.colorTimer = setTimeout(() => this._save(item.key, input.value), 400);
      });
    } else if (item.type === "select") {
      input = document.createElement("select");
      input.className = "setting-select";
      for (const option of item.options || []) {
        const node = document.createElement("option");
        node.value = option.value;
        node.textContent = option.label;
        input.appendChild(node);
      }
      input.value = STORE.values[item.key];
      input.addEventListener("change", () => this._save(item.key, input.value));
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.className = "setting-number";
      input.value = STORE.values[item.key];
      input.addEventListener("change", () => this._save(item.key, input.value));
    }

    const control = document.createElement("div");
    control.className = "setting-control";
    control.appendChild(input);
    if (item.unit) {
      const unit = document.createElement("span");
      unit.className = "setting-unit";
      unit.textContent = item.unit;
      control.appendChild(unit);
    }
    head.appendChild(control);

    if (item.help) {
      const help = document.createElement("p");
      help.className = "field-note";
      help.textContent = item.help;
      wrap.appendChild(help);
    }
    return wrap;
  }

  async _save(key, value) {
    STORE.values[key] = value;
    // Re-evaluate visibility: a switch can reveal or hide the options that
    // only make sense under it.
    this._refreshVisibility();

    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: { [key]: value } }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || response.status);
      }
      if (this.onChange) {
        this.onChange(key, STORE.values[key]);
      }
    } catch (err) {
      // Leave the in-memory value as the user set it; a failed write is
      // visible on the next reload rather than silently reverting under them.
    }
  }

  _refreshVisibility() {
    for (const group of (STORE.raw && STORE.raw.groups) || []) {
      for (const item of group.items || []) {
        const node = el("settings-generic").querySelector('[data-key="' + item.key + '"]');
        if (node) {
          node.hidden = !dependencyMet(item.depends);
        }
      }
    }
  }
}
