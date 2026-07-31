import { Stage } from "./stage.js";
import { AudioEngine } from "./audio.js";
import { RealtimeClient } from "./realtime.js";
import { CharacterEditor } from "./editor.js";
import { VoiceLibrary } from "./voices.js";
import { LlmSettings } from "./llm.js";
import { SettingsDialog, loadSettings, setting } from "./settings.js";
import { HeadInset } from "./inset.js";
import { loadMotionRules } from "./motions.js";
import { Subtitles, buildAss } from "./subtitles.js";
import { Recorder, recordingSupported, uploadRecording } from "./record.js";

// Derived from the page's own address rather than hardcoded to loopback: a
// phone on the same network loading this page must connect back to this
// machine, not to its own localhost.
const REALTIME_URL = "ws://" + window.location.hostname + ":8765/v1/realtime";

const PIPELINE_SAMPLE_RATE = 16000;

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
  // What she said, for the subtitle track of a replay or a recording.
  lastReplyText: "",
  replaying: false,
  lastPosition: -1,
  idleTicks: 0,
  releaseTimer: null,
  viewSaveTimer: null,
  motionAssets: [],
  partialUser: "",
  subtitles: null,
  recorder: null,
  recording: false,
  recordingTrack: null,
  // The speaker's sample counter runs for the whole session; subtitles are
  // timed per reply, so the turn's origin has to be captured separately.
  replyBase: null,
  autoRetries: 0,
  retryTimer: null,
  retryAction: null,
  services: { voice: false, lipsync: false },
  // Whether the poll has ever reported. Until it has, "lipsync is up"
  // is a first sighting, not an arrival.
  observed: false,
  polling: false,
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

// The retry button means different things depending on what failed, so the
// action is attached alongside the message rather than wired once at startup.
function showError(messageKey, retryAction) {
  el("error").textContent = t(messageKey);
  state.retryAction = retryAction || null;
  el("error-retry").hidden = !retryAction;
  el("error-box").hidden = false;
}

function clearError() {
  el("error-box").hidden = true;
  el("error-retry").hidden = true;
}

// A dropped renderer usually means the service is still starting, so the first
// few attempts are made without asking. The button stays for when they run out.
const AUTO_RETRIES = 4;
const AUTO_RETRY_MS = 4000;

function scheduleRendererRetry() {
  // While a needed service is still starting, watchServices is already on
  // it. Retrying here as well is what made the message flicker.
  if (neededServices().lipsync && !state.services.lipsync) {
    return;
  }
  if (state.autoRetries >= AUTO_RETRIES) {
    return;
  }
  state.autoRetries += 1;
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => retryRenderer(), AUTO_RETRY_MS);
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
        showError("retry_failed", retryRenderer);
        scheduleRendererRetry();
        return;
      }
    }
    clearError();
    if (character) {
      await state.stage.setCharacter(character);
    }
  } catch (err) {
    showError("retry_failed", retryRenderer);
    scheduleRendererRetry();
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

// Whether the text box is on screen answers to two things at once: there is
// nowhere to send a typed line unless connected, and the user may have folded
// it away for good. Both are decided here, because setting .hidden at either
// site alone means connecting quietly unfolds a box that was put away.
function applyCompose() {
  const folded = el("act-compose").dataset.on === "true";
  el("compose").hidden = folded || !state.connected;
  applyControls();
}

// The two controls under the picture, in words or as single glyphs.
//
// Folding the text box away is a statement that this is a voice conversation,
// and two wide labelled buttons are then the largest thing left covering the
// picture for no reason - the only one of them ever pressed is the first and
// last. Shrunk to glyphs they stay reachable without being furniture. The
// words come back with the text box, where reading matters more than room.
//
// All the label setting lives here rather than at each of the places that
// change the state, because it depends on three things at once - connected,
// muted, and folded - and splitting it across them is how one of the
// combinations ends up showing the wrong word.
function applyControls() {
  const compact = el("act-compose").dataset.on === "true";
  document.querySelector(".controls").dataset.compact = String(compact);

  const connect = el("connect");
  const starting = !state.connected && state.observed && !state.services.voice;
  let key = "connect";
  if (state.connected) {
    key = "disconnect";
  } else if (starting) {
    key = "voice_starting";
  }
  // The glyph alone says too little to act on, so the words move to the
  // tooltip rather than being dropped.
  connect.textContent = compact ? t("icon_" + key) : t(key);
  connect.title = compact ? t(key) : "";

  const mute = el("mute");
  const needsMic = state.audio && state.audio.running && !state.audio.micAvailable;
  const action = needsMic ? "enable_mic" : (state.muted ? "unmute" : "mute");
  // One glyph for the microphone either way: which state it is in is already
  // said by the accent colouring that data-active turns on.
  mute.textContent = compact ? t("icon_mic") : t(action);
  mute.title = compact ? t(action) : "";
  mute.dataset.active = String(state.muted);
}

function showNotice(key) {
  const node = el("notice");
  node.textContent = t(key);
  node.hidden = false;
}

// Which back ends the character on screen actually needs. Only the lip-sync
// display mode uses that service, so a 3D or 2D character should never be told
// anything about it.
function neededServices() {
  const character = currentCharacter();
  const avatar = (character && character.avatar) || {};
  return { voice: true, lipsync: avatar.type === "musetalk" };
}

// Tracks which back ends are up, and treats "not up yet" as a state of its own
// rather than as a failure.
//
// The panel is serving within seconds of launch; the voice pipeline needs a
// minute or two to put Whisper and the TTS on the GPU, and the lip-sync
// service about forty. Reporting either as an error during that window is both
// wrong and useless - there is nothing to fix and nothing to retry, only
// something to wait for. Worse, retrying on a timer made the message appear
// and vanish every few seconds.
//
// So while a needed service is still coming up, the page says so plainly, the
// buttons that depend on it are disabled, and the renderer's own complaints
// are swallowed. The moment it appears, the renderer is mounted - no click.
function ensurePolling() {
  if (!state.polling) {
    watchServices();
  }
}

function watchServices() {
  if (state.polling) {
    return;
  }
  state.polling = true;
  const poll = async () => {
    let services = { voice: false, lipsync: false };
    try {
      const response = await fetch("/api/services", { cache: "no-store" });
      services = await response.json();
    } catch (err) {
      // The panel itself is unreachable; leave everything marked down.
    }

    const seenBefore = state.observed;
    const wasLipsyncUp = state.services.lipsync;
    state.services = services;
    state.observed = true;
    const needed = neededServices();

    if (!state.connected) {
      el("connect").disabled = !services.voice;
    }
    applyControls();

    // Name the ones actually being waited on, so two services starting at
    // different speeds do not look like one vague delay.
    const waiting = [];
    if (needed.voice && !services.voice) {
      waiting.push(t("svc_voice"));
    }
    if (needed.lipsync && !services.lipsync) {
      waiting.push(t("svc_lipsync"));
    }

    const startup = el("startup");
    startup.hidden = waiting.length === 0;
    if (waiting.length) {
      startup.textContent = t("startup_waiting") + waiting.join(t("list_join"));
      // Nothing has failed, so nothing should be showing as failed.
      clearError();
    }

    // It just arrived: mount against it rather than waiting to be asked.
    // Only on a real transition. On the first report everything looks like
    // it just appeared, and remounting then fights the mount that
    // selecting the character already started - two sockets, and a
    // "reconnecting" message on a page that was fine.
    if (seenBefore && needed.lipsync && services.lipsync && !wasLipsyncUp) {
      state.autoRetries = 0;
      retryRenderer();
    }

    const settled = (!needed.voice || services.voice) && (!needed.lipsync || services.lipsync);
    if (settled) {
      state.polling = false;
    } else {
      setTimeout(poll, 2000);
    }
  };

  poll();
}

// Length of a cached reply, from the size of its audio rather than by timing
// the playback: the chunks are base64 of 16-bit mono PCM, so the count follows
// from the string lengths without decoding any of it.
function replySeconds(chunks) {
  let bytes = 0;
  for (const chunk of chunks) {
    let padding = 0;
    if (chunk.endsWith("==")) {
      padding = 2;
    } else if (chunk.endsWith("=")) {
      padding = 1;
    }
    bytes += (chunk.length / 4) * 3 - padding;
  }
  return bytes / 2 / PIPELINE_SAMPLE_RATE;
}

// Plays the previous reply again from its cached audio. Nothing is asked of
// the model or the lip-sync service - the same samples and, where the picture
// was generated, the same frames.
function replayLastReply() {
  if (!state.lastReply.length || state.replaying || state.speaking) {
    return false;
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

  // A replay knows exactly how long it will last, so the cues can be timed
  // against the real duration instead of an estimated speaking rate.
  state.replyBase = null;
  state.subtitles.begin(state.lastReplyText);
  state.subtitles.setTotal(replySeconds(state.lastReply));

  setStatus("status_speaking", "speaking");
  for (const chunk of state.lastReply) {
    state.audio.enqueueAudio(chunk);
  }
  return true;
}

// One place for "she has stopped talking", reached both from the drain edge
// and from the playhead sitting still. Either can be the one that arrives.
function endOfSpeech() {
  state.subtitles.clear();
  if (state.recording) {
    finishRecording();
  }
}

// ---------- saving ----------

// The character as a person rather than a config key, for filenames.
function characterLabel() {
  const character = currentCharacter();
  return (character && character.label) || state.characterId || "";
}

// Ask the browser to save a file it can already reach.
//
// A same-origin href with a download attribute, rather than fetching the bytes
// and handing over a blob URL: the file has just been written by the server on
// this machine, and pulling it through JavaScript memory first would double a
// video that can run to tens of megabytes for no gain.
function downloadRecording(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function setRecordStatus(key, values, tone) {
  const node = el("rec-status");
  let text = t(key);
  for (const [name, value] of Object.entries(values || {})) {
    text = text.replace("{" + name + "}", value);
  }
  node.textContent = text;
  node.dataset.tone = tone || "";
  node.hidden = false;
}

// Records the last reply by playing it again and capturing the stage. There is
// no faster path: the picture only exists while it is being drawn, and for two
// of the renderers it is decoded video that was never in our hands as frames.
function saveLastReply() {
  if (state.recording) {
    cancelRecording();
    return;
  }
  if (!state.lastReply.length) {
    setRecordStatus("err_record_nothing", null, "error");
    return;
  }
  if (!recordingSupported()) {
    setRecordStatus("err_record_unsupported", null, "error");
    return;
  }
  if (state.replaying || state.speaking) {
    return;
  }

  const audioStream = state.audio.captureStream();
  const tracks = audioStream ? audioStream.getAudioTracks() : [];
  const started = state.recorder.start(
    // Read per frame rather than captured once: the real-footage renderers
    // switch element when she starts and stops speaking.
    () => state.stage.captureElement(),
    tracks[0] || null
  );
  if (!started) {
    setRecordStatus("err_record", null, "error");
    return;
  }

  if (!replayLastReply()) {
    state.recorder.cancel();
    return;
  }

  // Taken now, while the replay is being set up. The end of the turn clears
  // the cues so the text does not linger on screen, and the upload happens
  // after that - reading them there would find nothing.
  //
  // Subtitles switched off means no track, whatever the save mode says: the
  // switch that hides them on screen should not leave them in the file.
  const track = state.subtitles.export();
  state.recordingTrack = state.subtitles.enabled() ? track : { cues: [], keywords: [] };

  state.recording = true;
  el("act-save").dataset.active = "true";
  el("act-save").textContent = t("icon_stop");
  el("act-save").title = t("btn_stop");
  setRecordStatus("rec_running");
}

function cancelRecording() {
  state.recorder.cancel();
  state.recording = false;
  resetSaveButton();
  setRecordStatus("rec_cancelled");
}

function resetSaveButton() {
  const button = el("act-save");
  button.dataset.active = "false";
  button.textContent = t("icon_save");
  button.title = t("btn_save_video");
}

async function finishRecording() {
  state.recording = false;
  resetSaveButton();
  setRecordStatus("rec_encoding");
  // Held down through the encode: the button is back to meaning "save" but
  // the previous save has not landed yet, and starting a second replay over
  // the top of it helps nobody.
  el("act-save").disabled = true;

  try {
    const blob = await state.recorder.stop();
    if (!blob) {
      setRecordStatus("err_record", null, "error");
      return;
    }
    const track = state.recordingTrack || { cues: [], keywords: [] };
    const wanted = track.cues.length ? setting("save_subtitle_mode", "soft") : "none";
    const result = await uploadRecording(blob, {
      mode: wanted,
      subtitle: track.cues.length ? buildAss(track.cues, track.keywords) : "",
      crf: setting("save_crf", 20),
      // The character's name as it reads on screen, not its config key: the
      // key is an internal identifier and made every file look alike.
      name: characterLabel(),
    });
    // Handed to the browser rather than announced. The panel used to print
    // "saved to <path>" and leave it there for good - the only way to learn
    // where the file went, and permanently in the way. A download puts the
    // file where the user keeps things, under a name they can change if
    // "ask where to save each file" is on, and the browser's own download
    // shelf is the receipt. The server's copy is a fallback that expires.
    downloadRecording(result.url, result.name);
    el("rec-status").hidden = true;
  } catch (err) {
    el("rec-status").textContent = t("err_record") + (err.message || err);
    el("rec-status").dataset.tone = "error";
    el("rec-status").hidden = false;
  } finally {
    el("act-save").disabled = !state.lastReply.length;
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

// Published as a custom property rather than set on each video element: both
// real-person renderers stack two of them, and they are created and destroyed
// on every character switch.
function applyVideoFit() {
  document.documentElement.style.setProperty("--video-fit", setting("video_fit", "contain"));
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

// Remembered server-side rather than in the browser: "default" is already the
// field that says which character to open with, and keeping it there means the
// choice survives a cleared cache and holds for a phone on the same network
// too. Debounced, since clicking through the list would otherwise be one write
// per click.
function rememberCharacter(id) {
  if (!state.config || state.config.default === id) {
    return;
  }
  state.config.default = id;
  clearTimeout(state.defaultSaveTimer);
  state.defaultSaveTimer = setTimeout(async () => {
    try {
      await fetch("/api/characters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config),
      });
    } catch (err) {
      // The selection still applies for this session; only persistence failed.
    }
  }, 800);
}

function selectCharacter(id) {
  const character = state.config.characters[id];
  if (!character) {
    return;
  }
  state.characterId = id;
  // Fresh budget: this is a new attempt at a different thing.
  state.autoRetries = 0;
  clearTimeout(state.retryTimer);
  // A different character may need a different service.
  ensurePolling();
  rememberCharacter(id);
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
    state.subtitles.clear();
    // A recording interrupted halfway is not the reply the user asked to
    // save, so it is dropped rather than written out truncated.
    if (state.recording) {
      cancelRecording();
    }
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

  // Dropped rather than carried over: if this turn produces no transcript, no
  // subtitle is better than the previous reply's.
  //
  // This has to happen here and not on the first audio chunk, which is where it
  // used to be. That assumed the voice starts before the words are known - true
  // of OpenAI's realtime API, which streams transcript deltas alongside the
  // audio, and false of this pipeline, which has the whole reply as text before
  // TTS has produced a sample. Measured order on our own server:
  //
  //     response.created
  //     response.output_audio_transcript.done      <- sets lastReplyText
  //     response.output_audio.delta (first)        <- used to clear it again
  //
  // So the text was wiped on every single turn. On-screen subtitles survived,
  // because their cues are already planned inside the Subtitles object by then,
  // and that is what hid this: the only things that read lastReplyText
  // afterwards are replay and save. Replay showed no subtitles, and save fell
  // back to "no subtitle track", which also silently downgraded the container
  // from MKV to MP4 - the setting looked ignored.
  client.on("response.created", () => {
    state.lastReplyText = "";
  });

  client.on("response.output_audio.delta", (event) => {
    if (!event.delta) {
      return;
    }
    if (!state.speaking) {
      state.speaking = true;
      state.currentReply = [];
      // The turn's origin on the speaker's running sample counter, captured on
      // the first position report after this.
      state.replyBase = null;
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
    state.lastReplyText = text;
    addTranscript("assistant", text);
    // The transcript is what "by context" matches against, and it arrives
    // while she is still speaking, so the motion lands during the reply.
    state.stage.playMotionFor(text);
    // Subtitles start on an estimated speaking rate here: the reply is still
    // being generated, so its real length is not known yet. response.done
    // corrects it.
    state.subtitles.begin(text);
  });

  client.on("response.done", () => {
    state.speaking = false;
    // No more audio is coming; the next drain is a real end of turn.
    state.turnEnding = true;
    if (state.currentReply.length) {
      state.lastReply = state.currentReply;
      state.currentReply = [];
      // The whole reply is in hand, so the cue timing can stop guessing.
      state.subtitles.setTotal(replySeconds(state.lastReply));
      el("act-replay").disabled = false;
      el("act-save").disabled = false;
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
      endOfSpeech();
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
    applyControls();
  });
}

async function connect() {
  clearError();
  setStatus("connecting", "thinking");

  try {
    await state.audio.start({ microphone: false });
  } catch (err) {
    showError("err_mic");
    setStatus("status_error", "error");
    return;
  }

  // Start without prompting for microphone permission. Playback and typed
  // input work immediately; the microphone button asks for capture when it is
  // actually wanted.
  el("mute").hidden = false;

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
      endOfSpeech();
      setStatus("status_ready", "ready");
    }
  };
  state.audio.onPosition = (played, active) => {
    state.stage.setAudioPosition(played, active);

    // Subtitles follow the voice, not the transcript event. The text arrives
    // while the speaker may still be held waiting for the picture, and a line
    // sitting on screen in silence belongs to a reply that has not started.
    // Gating on "audio is actually leaving the speaker" also makes this the
    // same clock the generated picture runs on, so the two cannot drift.
    if (active) {
      if (state.replyBase === null) {
        state.replyBase = played;
      }
      state.subtitles.setElapsed((played - state.replyBase) / PIPELINE_SAMPLE_RATE);
    }

    // Clearing this from the periodic report rather than an edge event means
    // a missed "drained" cannot leave replay permanently disabled.
    if (!active && state.replaying && played === state.lastPosition) {
      state.idleTicks += 1;
      if (state.idleTicks > 20) {
        state.replaying = false;
        state.idleTicks = 0;
        endOfSpeech();
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
    showError("err_connect", connect);
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

  applyCompose();
  if (!el("compose").hidden) {
    el("compose-input").focus();
  }
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
  applyCompose();
  el("notice").hidden = true;
  el("mute").hidden = false;
  setStatus("status_idle", "idle");
}

function applyStaticText() {
  document.title = t("app_title");
  el("app-title").textContent = t("app_title");
  el("characters-title").textContent = t("characters_title");
  el("transcript-title").textContent = t("transcript_title");
  // connect and mute are not set here: their labels depend on whether the
  // text box is folded, so applyControls owns them exclusively.
  el("compose-send").textContent = t("send");
  el("act-replay").textContent = t("icon_replay");
  el("act-replay").title = t("btn_replay");
  el("act-save").textContent = t("icon_save");
  el("act-save").title = t("btn_save_video");
  el("act-settings").textContent = t("icon_settings");
  el("act-settings").title = t("btn_settings");
  el("act-sidebar").textContent = t("icon_sidebar");
  el("act-sidebar").title = t("btn_sidebar");
  el("act-compose").textContent = t("icon_compose");
  el("act-compose").title = t("btn_compose");
  applyControls();
  el("inset-frame").title = t("inset_title");
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
      if (unreachable && neededServices().lipsync && !state.services.lipsync) {
        // Still coming up. The startup line is already saying so, and
        // watchServices will mount as soon as it answers.
        ensurePolling();
        return;
      }
      showError(unreachable ? "err_mt_service" : reason, unreachable ? retryRenderer : null);
      if (unreachable) {
        scheduleRendererRetry();
      }
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

  state.inset = new HeadInset(el("inset-frame"), el("stage-inset"));
  state.inset.attach(state.stage);
  state.inset.start();

  state.voices = new VoiceLibrary({ translate: t });
  state.voices.applyStaticText();

  state.editor = new CharacterEditor({
    translate: t,
    onSaved: (_config, activeId) => reloadCharacters(activeId),
    // Resolves when the library is closed again, so the editor can refresh its
    // list and keep whatever was just made selectable without a reopen.
    onManageVoices: () =>
      new Promise((resolve) => {
        state.voices.onChanged = resolve;
        state.voices.open();
      }),
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

  applyVideoFit();

  // After the settings load: the subtitle styling is read straight out of
  // them at construction.
  state.subtitles = new Subtitles(el("subtitle"), el("stage"));
  state.recorder = new Recorder();
  if (!recordingSupported()) {
    // Firefox has MediaRecorder but not canvas.captureStream on every path;
    // a button that can only ever report a failure should not be offered.
    el("act-save").hidden = true;
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
    // renderer itself. Subtitles are the exception: their styling is being
    // judged against what is on screen, so it has to follow the control.
    onChange: (key) => {
      if (key.indexOf("subtitle_") === 0) {
        state.subtitles.applyStyle();
      }
      if (key === "video_fit") {
        applyVideoFit();
      }
    },
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

  el("act-replay").addEventListener("click", () => replayLastReply());
  el("act-save").addEventListener("click", () => saveLastReply());
  el("act-settings").addEventListener("click", () => {
    state.llm.prepare();
    state.settings.open("llm");
  });
  el("error-retry").addEventListener("click", () => {
    if (state.retryAction) {
      state.retryAction();
    }
  });

  el("compose").addEventListener("submit", (event) => {
    event.preventDefault();
    sendTypedMessage();
  });

  el("mute").addEventListener("click", () => {
    if (state.audio.running && !state.audio.micAvailable) {
      state.audio.enableMicrophone().then((available) => {
        if (!available) {
          showNotice("notice_no_mic");
          return;
        }
        el("notice").hidden = true;
        state.muted = false;
        state.audio.setMuted(false);
        applyControls();
      });
      return;
    }
    state.muted = !state.muted;
    state.audio.setMuted(state.muted);
    applyControls();
  });

  setupCollapse();
  // Opened in a browser the services may still be coming up; the desktop
  // shell has already waited for them, in which case this settles at once.
  watchServices();
  setStatus("status_idle", "idle");
}

// Collapsed state is remembered: whether the character list is wanted is a
// standing preference, not something to re-express on every page load. The
// same goes for the sidebar as a whole, which is why replay, save and settings
// live on the stage - with the sidebar hidden there would be nowhere else for
// them to be.
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

  const shell = document.querySelector(".shell");
  const hidden = window.localStorage.getItem("mate.sidebar.hidden") === "1";

  const applySidebar = (value) => {
    shell.dataset.sidebar = value ? "hidden" : "shown";
    // Marked when hidden rather than when shown: the highlight says "this is
    // not the default state", which is the thing worth noticing.
    el("act-sidebar").dataset.on = String(value);
  };

  applySidebar(hidden);
  el("act-sidebar").addEventListener("click", () => {
    const next = shell.dataset.sidebar !== "hidden";
    applySidebar(next);
    window.localStorage.setItem("mate.sidebar.hidden", next ? "1" : "0");
  });

  // Talking to her by voice is the point; the text box is the fallback. Anyone
  // who never types wants the bottom of the picture back, and wants it to stay
  // back across restarts.
  const applyFold = (folded) => {
    el("act-compose").dataset.on = String(folded);
    applyCompose();
  };

  applyFold(window.localStorage.getItem("mate.compose.folded") === "1");
  el("act-compose").addEventListener("click", () => {
    const next = el("act-compose").dataset.on !== "true";
    applyFold(next);
    window.localStorage.setItem("mate.compose.folded", next ? "1" : "0");
    if (!next && state.connected) {
      el("compose-input").focus();
    }
  });
}

main().catch(() => {
  setStatus("status_error", "error");
});
