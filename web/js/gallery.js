// Avatar gallery: a visual picker for the VRM models already on disk.
//
// The character editor's VRM field has a plain dropdown fed by /api/assets;
// this dialog is the nicer version of that - a thumbnail grid of the curated
// CC0 pack (plus anything the user dropped in), so a model can be picked by
// sight instead of by filename.
//
// Nothing here touches the network. The list comes from /api/avatars, which
// reads config/avatars.json off disk; thumbnails are served from
// assets/models/curated/thumbnails/ by the same static mount that serves the
// models. Both are put there by the install step. Picking an avatar only
// hands its file path back to the editor - there is no download and no server
// mutation, so unlike a remote catalog there is nothing here for a hostile
// page to drive.

function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error("missing element: " + id);
  }
  return node;
}

export class AvatarGallery {
  constructor(options) {
    this.t = options.translate;
    this.avatars = [];
    this.filterProject = "";
    this.search = "";
    this.resolveClose = null;
    this.picked = null;

    el("gallery-done").addEventListener("click", () => this.close());
    el("gallery-backdrop").addEventListener("click", (event) => {
      if (event.target === el("gallery-backdrop")) {
        this.close();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el("gallery-backdrop").hidden) {
        this.close();
      }
    });

    el("gal-collection").addEventListener("change", (event) => {
      this.filterProject = event.target.value;
      this._render();
    });
    el("gal-search").addEventListener("input", (event) => {
      this.search = event.target.value;
      this._render();
    });
  }

  applyStaticText() {
    const t = this.t;
    el("gallery-title").textContent = t("gallery_title");
    el("gallery-done").textContent = t("gallery_done");
    el("gal-search").placeholder = t("gallery_search_placeholder");
  }

  // Resolves with the chosen avatar when one is picked, or null when the
  // dialog is closed without a pick. The editor reads .file off the result.
  open() {
    return new Promise((resolve) => {
      this.resolveClose = resolve;
      this.picked = null;
      el("gallery-backdrop").hidden = false;
      this._load();
    });
  }

  close() {
    el("gallery-backdrop").hidden = true;
    if (this.resolveClose) {
      const picked = this.picked;
      this.picked = null;
      this.resolveClose(picked);
      this.resolveClose = null;
    }
  }

  async _load() {
    const status = el("gal-status");
    status.dataset.warn = "false";
    status.textContent = this.t("gallery_loading");
    el("gal-grid").innerHTML = "";

    try {
      const response = await fetch("/api/avatars", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(response.status);
      }
      const data = await response.json();
      // Only models actually on disk are pickable: a curated entry whose
      // binary the install step has not fetched is left out rather than
      // offered as a pick that would resolve to a missing file.
      this.avatars = (data.avatars || []).filter((a) => a.exists);
    } catch (err) {
      this.avatars = [];
    }

    if (this.avatars.length === 0) {
      status.dataset.warn = "true";
      status.textContent = this.t("gallery_empty");
      this._renderCollections();
      return;
    }
    status.textContent = "";
    this._renderCollections();
    this._render();
  }

  _renderCollections() {
    const select = el("gal-collection");
    const current = this.filterProject;
    select.innerHTML = "";

    const all = document.createElement("option");
    all.value = "";
    all.textContent = this.t("gallery_filter_all");
    select.appendChild(all);

    const projects = new Map();
    for (const a of this.avatars) {
      const pid = a.project_id || "?";
      if (!projects.has(pid)) {
        projects.set(pid, { id: pid, name: a.project_name || pid, count: 0 });
      }
      projects.get(pid).count += 1;
    }
    const sorted = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const p of sorted) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name + " (" + p.count + ")";
      select.appendChild(opt);
    }
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
    this.filterProject = select.value;
  }

  _render() {
    const grid = el("gal-grid");
    grid.innerHTML = "";

    const search = this.search.trim().toLowerCase();
    const filtered = this.avatars.filter((a) => {
      if (this.filterProject && a.project_id !== this.filterProject) {
        return false;
      }
      const label = (a.label || a.name || "").toLowerCase();
      if (search && !label.includes(search)) {
        return false;
      }
      return true;
    });

    for (const avatar of filtered) {
      grid.appendChild(this._renderCard(avatar));
    }
  }

  _renderCard(avatar) {
    const t = this.t;
    const card = document.createElement("div");
    card.className = "gallery-card";
    card.addEventListener("click", () => this._pick(avatar));

    const thumb = document.createElement("img");
    thumb.className = "gallery-thumb";
    thumb.loading = "lazy";
    thumb.decoding = "async";
    thumb.alt = avatar.label || avatar.name || "";
    // A project-relative path ("assets/...") the static mount serves. Falls
    // back to the CSS placeholder when the install step has no thumbnail for
    // this entry (or the file is missing).
    if (avatar.thumbnail) {
      thumb.src = avatar.thumbnail;
    } else {
      thumb.dataset.placeholder = "true";
    }
    thumb.addEventListener("error", () => {
      thumb.dataset.placeholder = "true";
      thumb.removeAttribute("src");
    });

    const info = document.createElement("div");
    info.className = "gallery-info";

    const name = document.createElement("span");
    name.className = "gallery-name";
    name.textContent = avatar.label || avatar.name || "";

    const meta = document.createElement("span");
    meta.className = "gallery-meta";
    const parts = [];
    if (avatar.creator) parts.push(avatar.creator);
    parts.push(t("gallery_license_cc0"));
    meta.textContent = parts.join(" · ");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost small gallery-use";
    button.textContent = t("gallery_use");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this._pick(avatar);
    });

    info.appendChild(name);
    info.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(button);
    return card;
  }

  _pick(avatar) {
    this.picked = avatar;
    this.close();
  }
}
