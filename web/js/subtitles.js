// Subtitles for the reply she is speaking.
//
// There are no word timings anywhere in the pipeline - the TTS returns audio,
// not alignment - so the line is split at punctuation and each piece is given
// a share of the reply proportional to its length. For replies of a sentence
// or two, which is what the persona rules ask for, that lands close enough
// that the text changes on the beat.
//
// The reply's real duration is not known while it is still being generated, so
// display starts on an estimated speaking rate and is re-timed the moment the
// true length is known. A replay knows the length up front and is exact from
// the first frame.
//
// The same cue list is handed to the recorder, which turns it into an ASS
// track. Styling therefore has to be expressible in both CSS and ASS, which is
// why it stays at font, size, colour and outline rather than anything CSS
// could do that a subtitle format cannot.

import { setting } from "./settings.js";
import { emphasisKeywords } from "./motions.js";

// Only used before the real duration is known. Qwen3-TTS reads Chinese at
// roughly this pace; being a little slow is the safer error, since a cue that
// lingers is less jarring than one that has already gone.
const CHARS_PER_SECOND = 4.6;

// Escaped rather than written literally so this file stays ASCII, per the
// project rule for source. In order: ideographic full stop, fullwidth
// exclamation, fullwidth question, ASCII exclamation, ASCII question,
// ellipsis, fullwidth semicolon, ASCII semicolon.
const HARD_BREAKS = "\u3002\uff01\uff1f!?\u2026\uff1b;";
// Fullwidth comma, ASCII comma, ideographic comma. Break here only once the
// line has enough on it to be worth breaking.
const SOFT_BREAKS = "\uff0c,\u3001";
const SOFT_MIN_CHARS = 12;
// Beyond this a line wraps on screen anyway, so it may as well be split where
// the timing can follow it.
const MAX_CHARS = 26;

function splitCues(text) {
  const cues = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) {
      cues.push(trimmed);
    }
    current = "";
  };

  for (const char of String(text)) {
    current += char;
    if (HARD_BREAKS.indexOf(char) >= 0) {
      flush();
    } else if (SOFT_BREAKS.indexOf(char) >= 0 && current.length >= SOFT_MIN_CHARS) {
      flush();
    } else if (current.length >= MAX_CHARS) {
      flush();
    }
  }
  flush();
  return cues;
}

// Time is handed out by character count rather than evenly: a two-character
// interjection and a full clause do not take the same time to say, and an
// even split makes the short one hang while the long one races.
function schedule(texts, totalSeconds) {
  const weights = texts.map((text) => Math.max(1, text.length));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const cues = [];
  let at = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const span = (weights[i] / total) * totalSeconds;
    cues.push({ text: texts[i], start: at, end: at + span });
    at += span;
  }
  return cues;
}

function estimateSeconds(texts) {
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.max(0.8, chars / CHARS_PER_SECOND);
}

/**
 * Split a reply into timed cues.
 *
 * @param text          the whole reply
 * @param totalSeconds  its length, or 0 to estimate from a speaking rate
 */
export function planCues(text, totalSeconds) {
  const texts = splitCues(text);
  if (!texts.length) {
    return [];
  }
  return schedule(texts, totalSeconds > 0 ? totalSeconds : estimateSeconds(texts));
}

// Marks which characters belong to an emphasis keyword. A mask rather than
// string replacement because keywords overlap, and replacing one would corrupt
// the offsets of the next.
function emphasisMask(text, keywords) {
  const mask = new Array(text.length).fill(false);
  const haystack = text.toLowerCase();
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      for (let i = at; i < at + needle.length; i += 1) {
        mask[i] = true;
      }
      from = at + needle.length;
    }
  }
  return mask;
}

// [{text, emphasis}] - shared by the DOM renderer and the ASS writer so the
// two cannot disagree about which words are highlighted.
export function splitRuns(text, keywords) {
  if (!keywords || !keywords.length) {
    return [{ text: text, emphasis: false }];
  }
  const mask = emphasisMask(text, keywords);
  const runs = [];
  let start = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || mask[i] !== mask[start]) {
      runs.push({ text: text.slice(start, i), emphasis: mask[start] });
      start = i;
    }
  }
  return runs;
}

export class Subtitles {
  constructor(node, stageElement) {
    this.node = node;
    this.stage = stageElement;
    this.cues = [];
    this.index = -1;
    this.active = false;
    this.keywords = [];

    this._onResize = () => this.applyStyle();
    window.addEventListener("resize", this._onResize);
    this.applyStyle();
  }

  // Pushed into custom properties rather than set per element: the style is
  // re-read on every settings change, and one write on the container beats
  // walking whatever text happens to be on screen.
  applyStyle() {
    const style = this.node.style;
    const height = (this.stage && this.stage.clientHeight) || window.innerHeight;
    const size = Math.round((setting("subtitle_size", 4.2) / 100) * height);

    style.setProperty("--sub-font", setting("subtitle_font", "inherit"));
    style.setProperty("--sub-size", size + "px");
    style.setProperty("--sub-weight", setting("subtitle_bold", true) ? "700" : "400");
    style.setProperty("--sub-color", setting("subtitle_color", "#ffffff"));
    style.setProperty("--sub-highlight", setting("subtitle_highlight_color", "#ffd64a"));
    style.setProperty("--sub-bottom", setting("subtitle_bottom", 9) + "%");
    // Scaled with the type: a fixed stroke looks heavy on small text and
    // disappears on large.
    const stroke = setting("subtitle_outline", true) ? Math.max(1, Math.round(size * 0.055)) : 0;
    style.setProperty("--sub-stroke", stroke + "px");
  }

  enabled() {
    return !!setting("subtitle_show", true);
  }

  // Called when the reply text arrives, which is while she is still speaking.
  // The duration is a guess at this point; setTotal corrects it.
  begin(text) {
    this.clear();
    if (!this.enabled() || !text) {
      return;
    }
    const cues = planCues(text, 0);
    if (!cues.length) {
      return;
    }
    this.keywords = setting("subtitle_highlight", true) ? emphasisKeywords() : [];
    this.cues = cues;
    this.active = true;
    this.applyStyle();
    this.setElapsed(0);
  }

  // The reply turned out to be this long. Re-timing keeps the last cue from
  // ending early on a slow reply or hanging past the end of a fast one.
  setTotal(seconds) {
    if (!this.active || !this.cues.length || !(seconds > 0)) {
      return;
    }
    this.cues = schedule(
      this.cues.map((cue) => cue.text),
      seconds
    );
  }

  setElapsed(seconds) {
    if (!this.active || !this.cues.length) {
      return;
    }
    let index = -1;
    for (let i = 0; i < this.cues.length; i += 1) {
      if (seconds >= this.cues[i].start) {
        index = i;
      }
    }
    // Past the end of the last cue the text stays up rather than blinking off
    // a beat before the voice stops - clear() ends it when the turn does.
    if (index < 0 || index === this.index) {
      return;
    }
    this.index = index;
    this._render(this.cues[index].text);
  }

  _render(text) {
    this.node.textContent = "";
    for (const run of splitRuns(text, this.keywords)) {
      if (run.emphasis) {
        const mark = document.createElement("em");
        mark.textContent = run.text;
        this.node.appendChild(mark);
      } else {
        // textContent throughout: this is model output, and it lands in the
        // DOM on every turn.
        this.node.appendChild(document.createTextNode(run.text));
      }
    }
    this.node.hidden = false;
  }

  clear() {
    this.active = false;
    this.index = -1;
    this.cues = [];
    this.node.hidden = true;
    this.node.textContent = "";
  }

  // What the recorder needs to write a matching subtitle track.
  export() {
    return {
      cues: this.cues.map((cue) => ({ start: cue.start, end: cue.end, text: cue.text })),
      keywords: this.keywords.slice(),
    };
  }
}

// ---------- ASS ----------

const ASS_PLAY_HEIGHT = 1080;
const ASS_PLAY_WIDTH = 1920;

// ASS orders its channels blue-green-red, the reverse of CSS.
function toBgr(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  const value = match ? match[1] : "ffffff";
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);
  return (b + g + r).toUpperCase();
}

// Style fields carry an alpha byte in front: &HAABBGGRR, alpha 00 being opaque.
function styleColour(hex) {
  return "&H00" + toBgr(hex);
}

// Inline overrides do not. \c takes six digits and closes with an ampersand;
// handing it the eight-digit style form makes libass read the alpha byte as
// part of the colour, which comes out as the wrong colour rather than as an
// error anyone would notice in the file.
function inlineColour(hex) {
  return "&H" + toBgr(hex) + "&";
}

// ASS names one font; CSS names a fallback chain. Take the head of the chain,
// which is the one the user actually chose.
function primaryFont(stack) {
  const first = String(stack || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (!first || first === "inherit") {
    return "Microsoft YaHei";
  }
  return first;
}

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centis = Math.floor((total - Math.floor(total)) * 100);
  const pad = (value, width) => String(value).padStart(width, "0");
  return hours + ":" + pad(minutes, 2) + ":" + pad(secs, 2) + "." + pad(centis, 2);
}

/**
 * Render cues as an ASS subtitle file matching the on-screen styling.
 *
 * ASS rather than SRT because SRT carries no styling at all: the font, the
 * size and above all the keyword colour would be lost, and matching the look
 * on screen is the whole point of saving with subtitles.
 */
export function buildAss(cues, keywords) {
  const font = primaryFont(setting("subtitle_font", "inherit"));
  const size = Math.round((setting("subtitle_size", 4.2) / 100) * ASS_PLAY_HEIGHT);
  const primary = styleColour(setting("subtitle_color", "#ffffff"));
  const inlinePrimary = inlineColour(setting("subtitle_color", "#ffffff"));
  const inlineHighlight = inlineColour(setting("subtitle_highlight_color", "#ffd64a"));
  const bold = setting("subtitle_bold", true) ? -1 : 0;
  const outline = setting("subtitle_outline", true) ? Math.max(1, Math.round(size * 0.055)) : 0;
  const marginV = Math.round((setting("subtitle_bottom", 9) / 100) * ASS_PLAY_HEIGHT);

  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: " + ASS_PLAY_WIDTH,
    "PlayResY: " + ASS_PLAY_HEIGHT,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour," +
      " OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut," +
      " ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow," +
      " Alignment, MarginL, MarginR, MarginV, Encoding",
    // Alignment 2 is bottom-centre. Encoding 1 is the default character set,
    // which is what a UTF-8 script wants.
    [
      "Style: Default",
      font,
      size,
      primary,
      primary,
      "&H00000000",
      "&H80000000",
      bold,
      0,
      0,
      0,
      100,
      100,
      0,
      0,
      1,
      outline,
      1,
      2,
      60,
      60,
      marginV,
      1,
    ].join(","),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text",
  ];

  const lines = cues.map((cue) => {
    const body = splitRuns(cue.text, keywords || [])
      .map((run) => {
        // Braces and newlines are ASS markup; neither should survive from the
        // model's own text into the file as an override tag.
        const safe = run.text.replace(/[{}]/g, "").replace(/\r?\n/g, " ");
        if (!run.emphasis) {
          return safe;
        }
        return "{\\c" + inlineHighlight + "}" + safe + "{\\c" + inlinePrimary + "}";
      })
      .join("");
    return (
      "Dialogue: 0," +
      assTime(cue.start) +
      "," +
      assTime(cue.end) +
      ",Default,,0,0,0,," +
      body
    );
  });

  return head.concat(lines).join("\n") + "\n";
}
