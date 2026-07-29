// Picks which motion to play for a turn.
//
// Three modes, chosen in settings:
//
//   fixed    always the motion configured on the character
//   random   a different one each turn
//   auto     matched against what she actually said
//
// "auto" reads the reply text rather than asking a model what mood it is in.
// A second round trip would add latency to every turn for a choice between
// eleven animations, and the reply text is already in hand by then.
//
// Only 3D uses this. VRMA is a VRM format; Live2D models carry their own
// motion3.json groups and are handled by that renderer.

let rules = null;

export async function loadMotionRules() {
  try {
    const response = await fetch("./motions.json", { cache: "no-store" });
    rules = await response.json();
  } catch (err) {
    rules = { rules: [], fallback: [] };
  }
  return rules;
}

// The same rules drive subtitle highlighting: a word strong enough to pick an
// animation is a word worth colouring. Reusing them means one list to edit
// rather than two that drift apart.
//
// Single characters are skipped - in Chinese they turn up inside unrelated
// words and would speckle the line - as are rules marked emphasis:false, whose
// keywords are hedges ("maybe", "mm") rather than anything to stress.
export function emphasisKeywords() {
  const out = [];
  for (const rule of (rules && rules.rules) || []) {
    if (rule.emphasis === false) {
      continue;
    }
    for (const keyword of rule.keywords || []) {
      const word = String(keyword);
      if (word.length > 1) {
        out.push(word);
      }
    }
  }
  // Longest first, so a three-character phrase claims the run before a
  // shorter keyword nested inside it can take part of it.
  out.sort((a, b) => b.length - a.length);
  return out;
}

function pick(list) {
  if (!list || !list.length) {
    return null;
  }
  return list[Math.floor(Math.random() * list.length)];
}

// Available motions come from the asset scan, so a rule naming a file that is
// not installed simply does not match instead of failing to load later.
function resolve(name, available) {
  if (!name) {
    return null;
  }
  const wanted = name.toLowerCase();
  const hit = available.find((item) => {
    const base = item.path.split("/").pop().replace(/\.vrma$/i, "").toLowerCase();
    return base === wanted;
  });
  return hit ? hit.path : null;
}

function matchText(text, available) {
  if (!rules || !text) {
    return null;
  }
  const haystack = text.toLowerCase();
  for (const rule of rules.rules || []) {
    for (const keyword of rule.keywords || []) {
      if (haystack.indexOf(String(keyword).toLowerCase()) >= 0) {
        const path = resolve(pick(rule.motions), available);
        if (path) {
          return path;
        }
      }
    }
  }
  return null;
}

function fallback(available) {
  const path = resolve(pick((rules && rules.fallback) || []), available);
  return path || (available.length ? pick(available).path : null);
}

/**
 * @param mode      "fixed" | "random" | "auto"
 * @param configured motion path set on the character
 * @param available  entries from /api/assets motion group
 * @param text       what she just said, for "auto"
 */
export function chooseMotion(mode, configured, available, text) {
  const list = available || [];
  if (mode === "random") {
    return list.length ? pick(list).path : configured || null;
  }
  if (mode === "auto") {
    return matchText(text, list) || fallback(list) || configured || null;
  }
  return configured || null;
}
