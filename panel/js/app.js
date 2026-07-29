import { Stage } from "./stage.js";
import { AudioEngine } from "./audio.js";
import { RealtimeClient } from "./realtime.js";
import { CharacterEditor } from "./editor.js";
import { LlmSettings } from "./llm.js";
import { SettingsDialog, loadSettings } from "./settings.js";
import { HeadInset } from "./inset.js";
import { loadMotionRules } from "./motions.js";

// Derived from the page's own address rather than hardcoded to loopback: a
// phone on the same network loading this page must connect back to this
// machine, not to its own localhost.
const REALTIME_URL = "ws://" + window.location.hostname + ":8765/v1/realtime";

// How long to wait for a generated picture before playing the reply without
// it. Long enough for a normal turn, short enough that a broken service does
// not swallow the answer.
const RELEASE_TIMEOUT_MS = 20000;

// The status key doubles as the stage's visual state, so the two can never
// drift out of sync.
const STAGE_STATE = {
  status_idle: "idle",
  status_ready: "idle",
  status_listening: "listening",
  status_thinking: "thinking",
  status_speaking: "speaking",
  status_error: "error",
  connecting: "thinking",
};

const state = {
  i18n: {},
  config: null,
  characterId: null,
  stage: null,
  inset: null,
  audio: null,
  editor: null,
  llm: null,
  settings: null,
  client: null,
  connected: false,
  muted: false,
  speaking: false,
  turnEnding: false,
  // Audio deltas of the last reply, kept so it can be played again without
  // asking the model for a fresh answer.
  lastReply: [],
  currentReply: [],
  replaying: false,
  lastPosition: -1,
  idleTicks: 0,
  releaseTimer: null,
  viewSaveTimer: null,
  motionAssets: [],
  partialUser: "",
};

function el(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error("missing element: " + id);
  }
  return node;
}

function t(key) {
  return state.i18n[key] || key;
}

function setStatus(key, tone) {
  const node = el("status");
  node.textContent = t(key);
  node.dataset.tone = tone || "idle";
  if (state.stage) {
    state.stage.setState(STAGE_STATE[key] || "idle");
  }
}

function showError(messageKey, withRetry) {
  el("error").textContent = t(messageKey);
  el("error-retry").hidden = !withRetry;
  el("error-box").hidden = false;
}

function clearError() {
  el("error-box").hidden = true;
  el("error-retry").hidden = true;
}

// Re-mounts the current character's renderer. The service usually just needs
// starting, and reconnecting is cheaper and less disruptive than reloading the
// page and losing the conversation.
async function retryRenderer() {
  const button = el("error-retry");
  const character = currentCharacter();
  button.disabled = true;
  el("error").textContent = t("retrying");

  try {
    // Only the lip-sync renderer depends on that service; checking it for the
    // others would report a failure that has nothing to do with them.
    const needsService = !!(character && character.avatar && character.avatar.type === "musetalk");
    if (needsService) {
      const response = await fetch("/api/musetalk/status", { cache: "no-store" });
      const data = await response.json();
      if (!data.up) {
        showError("retry_failed", true);
        return;
      }
    }
    clearError();
    if (character) {
      await state.stage.setCharacter(character);
    }
  } catch (err) {
    showError("retry_failed", true);
  } finally {
    button.disabled = false;
  }
}

async function saveView(zoom, offsetY) {
  const character = currentCharacter();
  if (!character || !state.config) {
    return;
  }
  character.avatar = character.avatar || {};
  character.avatar.view = { zoom: Number(zoom.toFixed(3)), offsetY: Number(offsetY.toFixed(3)) };

  try {
    await fetch("/api/characters", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.config),
    });
  } catch (err) {
    // The view still applies for this session; only persistence failed.
  }
}

function showNotice(key) {
  const node = el("notice");
  node.textContent = t(key);
  node.hidden = false;
}

// Plays the previous reply again from its cached audio. Nothing is asked of
// the model or the lip-sync service - the same samples and, where the picture
// was generated, the same frames.
function replayLastReply() {
  if (!state.lastReply.length || state.replaying || state.speaking) {
    return;
  }
  state.replaying = true;
  clearTimeout(state.releaseTimer);

  // Start from a clean speaker. Anything still draining from the previous
  // reply would overlap this one and, worse, keep the sample counter moving,
  // so the picture would be indexed against the wrong origin.
  state.audio.clearPlayback();

  const gated = state.stage.gatesAudio();
  if (gated) {
    state.audio.holdPlayback();
  }

  const usedCache = state.stage.beginReplay();
  if (gated && !usedCache) {
    // No cached picture to replay against, so play the sound alone rather
    // than regenerating - that is the point of replay.
    state.stage.silence();
    state.audio.releasePlayback();
  } else if (gated) {
    state.releaseTimer = setTimeout(() => {
      state.audio.releasePlayback();
    }, RELEASE_TIMEOUT_MS);
  }

  setStatus("status_speaking", "speaking");
  for (const chunk of state.lastReply) {
    state.audio.enqueueAudio(chunk);
  }
}

function sendTypedMessage() {
  const input = el("compose-input");
  const text = input.value.trim();
  if (!text || !state.client || !state.connected) {
    return;
  }

  // Typed turns produce no transcription event, so echo it locally to keep the
  // transcript complete.
  addTranscript("user", text);
  state.client.sendText(text);
  input.value = "";
  setStatus("status_thinking", "thinking");
}

function addTranscript(speaker, text) {
  if (!text) {
    return;
  }
  const list = el("transcript");
  const empty = list.querySelector(".transcript-empty");
  if (empty) {
    empty.remove();
  }

  const row = document.createElement("div");
  row.className = "line line-" + speaker;

  const who = document.createElement("span");
  who.className = "who";
  const character = currentCharacter();
  who.textContent = speaker === "user" ? t("you") : character ? character.label : "";

  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;

  row.appendChild(who);
  row.appendChild(body);
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function currentCharacter() {
  if (!state.config || !state.characterId) {
    return null;
  }
  return state.config.characters[state.characterId];
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("fetch failed: " + path);
  }
  return response.json();
}

function renderCharacterList() {
  const list = el("characters");
  list.innerHTML = "";

  for (const [id, character] of Object.entries(state.config.characters)) {
    const row = document.createElement("div");
    row.className = "character-row";
    row.dataset.active = String(id === state.characterId);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "character";

    const name = document.createElement("span");
    name.className = "character-name";
    name.textContent = character.label;

    const subtitle = document.createElement("span");
    subtitle.className = "character-subtitle";
    subtitle.textContent = character.subtitle || "";

    button.appendChild(name);
    button.appendChild(subtitle);
    button.addEventListener("click", () => selectCharacter(id));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn edit-btn";
    edit.textContent = t("icon_edit");
    edit.title = t("btn_edit");
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      state.editor.open(state.config, id);
    });

    row.appendChild(button);
    row.appendChild(edit);
    list.appendChild(row);
  }
}

// Called after the editor writes characters.json. Re-reads from the server
// rather than trusting the in-memory copy, so what is shown is what was saved.
async function reloadCharacters(activeId) {
  state.config = await loadJson("/api/characters");
  if (activeId && state.config.characters[activeId]) {
    state.characterId = activeId;
  } else if (!state.config.characters[state.characterId]) {
    state.characterId = state.config.default || Object.keys(state.config.characters)[0];
  }
  // Re-applies persona and voice through session.update, so an edit takes
  // effect mid-conversation without reconnecting.
  selectCharacter(state.characterId);
}

function selectCharacter(id) {
  const character = state.config.characters[id];
  if (!character) {
    return;
  }
  state.characterId = id;
  renderCharacterList();
  el("character-name").textContent = character.label;

  // Any error belonged to the renderer being replaced. Carrying it over would
  // leave a message about a service the new one may not even use.
  clearError();

  // Swapping the renderer may load modules or media, so it runs async and is
  // deliberately not awaited: the persona switch below should take effect on
  // the next turn regardless of how long the visuals take.
  if (state.stage) {
    state.stage.setCharacter(character);
  }

  // Persona and voice both live in the session config, so a switch is one
  // message - no restart, and the TTS model stays resident in VRAM.
  if (state.client && state.connected) {
    state.client.updateSession({
      instructions: character.system_prompt,
      voice: character.voice,
    });
  }
}

function wireClientEvents(client) {
  client.on("session.created", () => {
    setStatus("status_ready", "ready");
  });

  client.on("input_audio_buffer.speech_started", () => {
    // Barge-in: drop everything still queued so she stops immediately rather
    // than talking over the user for the length of the buffer.
    clearTimeout(state.releaseTimer);
    state.audio.clearPlayback();
    state.speaking = false;
    state.turnEnding = false;
    setStatus("status_listening", "listening");
  });

  client.on("input_audio_buffer.speech_stopped", () => {
    setStatus("status_thinking", "thinking");
  });

  client.on("conversation.item.input_audio_transcription.delta", (event) => {
    state.partialUser += event.delta || "";
    el("partial").textContent = state.partialUser;
  });

  client.on("conversation.item.input_audio_transcription.completed", (event) => {
    const text = event.transcript || state.partialUser;
    state.partialUser = "";
    el("partial").textContent = "";
    addTranscript("user", text);
  });

  client.on("response.output_audio.delta", (event) => {
    if (!event.delta) {
      return;
    }
    if (!state.speaking) {
      state.speaking = true;
      state.currentReply = [];
      // Order matters: the renderer needs to know the turn has begun before
      // audio reaches it, so it can hand over the current pose first.
      setStatus("status_speaking", "speaking");
      // With a generated picture the speaker waits; otherwise it plays at once.
      if (state.stage.gatesAudio()) {
        state.audio.holdPlayback();
      }
    }
    state.currentReply.push(event.delta);
    state.audio.enqueueAudio(event.delta);
  });

  client.on("response.output_audio_transcript.done", (event) => {
    const text = event.transcript || "";
    addTranscript("assistant", text);
    // The transcript is what "by context" matches against, and it arrives
    // while she is still speaking, so the motion lands during the reply.
    state.stage.playMotionFor(text);
  });

  client.on("response.done", () => {
    state.speaking = false;
    // No more audio is coming; the next drain is a real end of turn.
    state.turnEnding = true;
    if (state.currentReply.length) {
      state.lastReply = state.currentReply;
      state.currentReply = [];
      el("replay").disabled = false;
    }
    // Tells the lip-sync service the turn is over so it flushes whatever
    // audio is still buffered instead of holding it until the next turn.
    state.stage.endTurn();

    if (state.stage.gatesAudio()) {
      // The picture is still being generated. Releasing here would defeat the
      // wait entirely - the renderer signals when it is ready. The timer is
      // only a guard against a service that never answers, so a failure costs
      // a late reply rather than a silent one.
      clearTimeout(state.releaseTimer);
      state.releaseTimer = setTimeout(() => {
        state.audio.releasePlayback();
      }, RELEASE_TIMEOUT_MS);
    } else {
      state.audio.releasePlayback();
    }
    // The "drained" edge fires once. If the buffer emptied before the reply
    // was declared finished, that edge is already in the past and waiting for
    // it would strand the picture on its final frame.
    if (!state.audio.isActive()) {
      state.turnEnding = false;
      state.stage.silence();
    }
    setStatus("status_ready", "ready");
  });

  client.on("error", (event) => {
    const detail = event && event.error ? event.error.message || event.error.type : "";
    el("error").textContent = detail || t("status_error");
    el("error-retry").hidden = true;
    el("error-box").hidden = false;
  });

  client.on("close", () => {
    state.connected = false;
    state.speaking = false;
    setStatus("status_idle", "idle");
    el("connect").textContent = t("connect");
  });
}

async function connect() {
  clearError();
  setStatus("connecting", "thinking");

  try {
    await state.audio.start();
  } catch (err) {
    showError("err_mic");
    setStatus("status_error", "error");
    return;
  }

  // No microphone is not a failure: playback still works, so fall back to
  // typing rather than refusing to connect.
  if (!state.audio.micAvailable) {
    showNotice("notice_no_mic");
    el("mute").hidden = true;
  }

  state.audio.onAudioFrame = (base64) => {
    if (state.client && state.connected) {
      state.client.appendAudio(base64);
    }
  };
  // While she is speaking the playback envelope owns the orb; otherwise the
  // microphone drives it, so the user sees their own voice register.
  state.audio.onMicLevel = (rms) => {
    if (!state.speaking) {
      state.stage.setLevel(rms);
    }
  };
  state.audio.onEnvelope = (rms, zcr, active) => {
    if (active) {
      state.stage.setLevel(rms, zcr, active);
    }
  };
  state.audio.onDrained = () => {
    // TTS audio arrives in bursts, so the buffer running dry does not by
    // itself mean the reply finished - it often just means the next sentence
    // is still being synthesised. Only treat it as the end once the server
    // has said the response is complete, otherwise the picture resets in the
    // middle of a sentence.
    if (state.turnEnding || state.replaying) {
      state.turnEnding = false;
      state.replaying = false;
      state.stage.silence();
      setStatus("status_ready", "ready");
    }
  };
  state.audio.onPosition = (played, active) => {
    state.stage.setAudioPosition(played, active);
    // Clearing this from the periodic report rather than an edge event means
    // a missed "drained" cannot leave replay permanently disabled.
    if (!active && state.replaying && played === state.lastPosition) {
      state.idleTicks += 1;
      if (state.idleTicks > 20) {
        state.replaying = false;
        state.idleTicks = 0;
        setStatus("status_ready", "ready");
      }
    } else {
      state.idleTicks = 0;
    }
    state.lastPosition = played;
  };
  // MuseTalk needs the audio itself to generate mouth shapes; every other
  // renderer ignores this.
  state.audio.onPcm = (bytes) => {
    state.stage.pushAudio(bytes);
  };

  const client = new RealtimeClient(REALTIME_URL);
  wireClientEvents(client);
  state.client = client;

  try {
    await client.connect();
  } catch (err) {
    showError("err_connect");
    setStatus("status_error", "error");
    await state.audio.stop();
    return;
  }

  state.connected = true;
  const character = currentCharacter();
  client.updateSession({
    instructions: character.system_prompt,
    voice: character.voice,
  });

  el("connect").textContent = t("disconnect");
  el("compose").hidden = false;
  el("compose-input").focus();
  setStatus("status_ready", "ready");
}

async function disconnect() {
  if (state.client) {
    state.client.disconnect();
    state.client = null;
  }
  await state.audio.stop();
  state.connected = false;
  state.speaking = false;
  state.stage.silence();
  el("connect").textContent = t("connect");
  el("compose").hidden = true;
  el("notice").hidden = true;
  el("mute").hidden = false;
  setStatus("status_idle", "idle");
}

function applyStaticText() {
  document.title = t("app_title");
  el("app-title").textContent = t("app_title");
  el("characters-title").textContent = t("characters_title");
  el("transcript-title").textContent = t("transcript_title");
  el("connect").textContent = t("connect");
  el("mute").textContent = t("mute");
  el("compose-send").textContent = t("send");
  el("replay").textContent = t("icon_replay");
  el("replay").title = t("btn_replay");
  el("error-retry").textContent = t("btn_retry");
  el("compose-input").placeholder = t("compose_placeholder");
  el("hint-switch").textContent = t("hint_switch");
  el("hint-interrupt").textContent = t("hint_interrupt");

  const empty = document.createElement("p");
  empty.className = "transcript-empty";
  empty.textContent = t("transcript_empty");
  el("transcript").appendChild(empty);
}

async function main() {
  state.i18n = await loadJson("./i18n.json");
  applyStaticText();

  try {
    state.config = await loadJson("/api/characters");
  } catch (err) {
    showError("err_config");
    return;
  }

  state.characterId = state.config.default || Object.keys(state.config.characters)[0];

  state.stage = new Stage(el("stage"), {
    // Supplied as a callback so a rescan is picked up without rebuilding the
    // renderer.
    motions: () => state.motionAssets,
    // A renderer that cannot reach its backing service must say so; silently
    // showing the idle loop is indistinguishable from working correctly.
    onRendererStatus: (reason) => {
      const unreachable = reason === "service_unreachable" || reason === "service_closed";
      showError(unreachable ? "err_mt_service" : reason, unreachable);
      // A renderer that failed will never signal the picture is ready, so
      // stop waiting for it rather than losing the audio entirely.
      clearTimeout(state.releaseTimer);
      if (state.audio) {
        state.audio.releasePlayback();
      }
    },
    // Framing is adjusted by eye and saved quietly - it is a preference, not
    // an edit worth opening a dialog for. Debounced so a wheel spin is one
    // write rather than dozens.
    onViewChange: (zoom, offsetY) => {
      clearTimeout(state.viewSaveTimer);
      state.viewSaveTimer = setTimeout(() => saveView(zoom, offsetY), 600);
    },
    // The generated picture is ready; sound and mouth start together.
    onPictureReady: () => {
      clearTimeout(state.releaseTimer);
      state.audio.releasePlayback();
    },
  });
  state.audio = new AudioEngine();

  state.inset = new HeadInset(el("stage-inset"));
  state.inset.attach(state.stage);
  state.inset.start();

  state.editor = new CharacterEditor({
    translate: t,
    onSaved: (_config, activeId) => reloadCharacters(activeId),
  });
  state.editor.applyStaticText();

  state.llm = new LlmSettings({
    translate: t,
    onSaved: () => state.settings.close(),
  });
  state.llm.applyStaticText();
  try {
    await state.llm.load();
  } catch (err) {
    // A missing providers.json should not stop the panel from working.
  }

  try {
    await loadSettings();
  } catch (err) {
    // Defaults in the code cover a missing settings.json.
  }

  await loadMotionRules();
  try {
    const assets = await loadJson("/api/assets");
    state.motionAssets = (assets.motion && assets.motion.items) || [];
  } catch (err) {
    state.motionAssets = [];
  }
  state.settings = new SettingsDialog({
    translate: t,
    llm: state.llm,
    // Renderers read settings when a turn starts, so most changes apply on the
    // next reply. Remounting is only needed where the setting shapes the
    // renderer itself.
    onChange: () => {},
  });
  state.settings.applyStaticText();

  el("llm-button").addEventListener("click", () => {
    state.llm.prepare();
    state.settings.open("llm");
  });

  el("character-new").addEventListener("click", () => {
    state.editor.open(state.config, null);
  });

  selectCharacter(state.characterId);

  el("connect").addEventListener("click", async () => {
    if (state.connected) {
      await disconnect();
    } else {
      await connect();
    }
  });

  el("replay").addEventListener("click", () => replayLastReply());
  el("error-retry").addEventListener("click", () => retryRenderer());

  el("compose").addEventListener("submit", (event) => {
    event.preventDefault();
    sendTypedMessage();
  });

  el("mute").addEventListener("click", () => {
    state.muted = !state.muted;
    state.audio.setMuted(state.muted);
    el("mute").textContent = state.muted ? t("unmute") : t("mute");
    el("mute").dataset.active = String(state.muted);
  });

  setupCollapse();
  setStatus("status_idle", "idle");
}

// Collapsed state is remembered: whether the character list is wanted is a
// standing preference, not something to re-express on every page load.
function setupCollapse() {
  const toggle = el("characters-toggle");
  const body = el("characters-body");
  const stored = window.localStorage.getItem("mate.characters.collapsed") === "1";

  const apply = (collapsed) => {
    body.hidden = collapsed;
    toggle.dataset.collapsed = String(collapsed);
    toggle.title = t("btn_collapse");
  };

  apply(stored);
  toggle.addEventListener("click", () => {
    const collapsed = toggle.dataset.collapsed !== "true";
    apply(collapsed);
    window.localStorage.setItem("mate.characters.collapsed", collapsed ? "1" : "0");
  });
}

main().catch(() => {
  setStatus("status_error", "error");
});
