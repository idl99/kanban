// Huddle role presets ("teammates" in the UI): built-ins shipped here, the user's global ones in <home>/huddle-presets.json
// (every board) and a board's own in profiles/<slug>/huddle-presets.json. Merge order: built-in -> global -> board (see
// layers.ts); a preset with a lower level's name overrides it there, and deleting it falls back to the level below.
// Plain helpers shared by the daemon and the MCP server (no file access here; see Store.listHuddlePresets).
import { type Layered, mergeLayers, withItem } from "./layers";
import type { HuddleMode, HuddleWorkspace } from "./types";

export interface HuddlePreset {
  /** Key used in rosters, and the default handle. Lowercase letters, digits and dashes. */
  name: string;
  /** Label shown in the huddle, e.g. "QA lead". */
  role: string;
  prompt: string;
  /** Default model, e.g. sonnet; null: the board's. */
  model: string | null;
  mode: HuddleMode;
  /** May add participants and manage the findings list. A lead defaults to monitor mode and wakes on any tag, even when done. */
  lead: boolean;
  /** May change files: it then works in its own copy of the folder and hands its changes in (workspace is own). */
  canEdit: boolean;
  workspace: HuddleWorkspace;
}

export type HuddlePresetView = Layered<HuddlePreset>;

/** The coordinator's preset: the host ticket's own session. Only its role, mode and prompt apply. */
export const MAIN_PRESET = "main";
/** Preset names that would clash with special handles. */
const RESERVED_NAMES = new Set(["you", "all", "system", "current"]);
const MAX_NAME = 24;
const MAX_PROMPT = 8000;

export const BUILTIN_PRESETS: HuddlePreset[] = [
  {
    name: MAIN_PRESET, role: "Coordinator", model: null, mode: "tagged", lead: true, canEdit: true, workspace: "shared",
    prompt: "Coordinate the huddle: split the work, decide what gets fixed, make the fixes in the ticket's folder, and tell the user (@you) when the huddle's work is done.",
  },
  {
    name: "reviewer", role: "Code reviewer", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Review the host ticket's changes (git diff against its base branch) for correctness bugs, risky edge cases, security problems and missing tests. " +
      "Report concrete findings with file:line and why each one matters; skip style nits.",
  },
  {
    name: "qa", role: "QA tester", model: null, mode: "monitor", lead: false, canEdit: false, workspace: "shared",
    prompt: "Test the work like a careful QA engineer: run the app and the tests, try edge cases and unhappy paths, and reproduce every bug with exact steps. " +
      "Put test scripts and reports in your outputs folder. Post each confirmed bug with steps to reproduce, expected and actual.",
  },
  {
    name: "qa-lead", role: "QA lead", model: null, mode: "monitor", lead: true, canEdit: false, workspace: "shared",
    prompt: "Lead the QA testers: split the areas to test between them, check and de-duplicate what they find, and keep the pinned findings list current " +
      "with huddle_findings. When testing is done, send @main one consolidated list of what needs fixing, most severe first. " +
      "Only mark done after you have sent your final consolidated list to @main.",
  },
  {
    name: "engineer", role: "Engineer", model: null, mode: "tagged", lead: false, canEdit: true, workspace: "own",
    prompt: "Build the part of the work you are given in your own copy of the project, with tests, and run them. " +
      "When it works, hand it in with huddle_hand_in and a one-line summary; @main or a lead accepts it into the ticket's work.",
  },
  {
    name: "designer", role: "Designer", model: null, mode: "tagged", lead: false, canEdit: true, workspace: "own",
    prompt: "Make the design changes you are given yourself, in your own copy of the project: layout, styles, wording on screen, icons and images " +
      "(edit or create them with the tools you have, e.g. SVG by hand or an image tool installed on this computer). Check the result in the browser " +
      "(Claude in Chrome) when there is something to look at. Then hand it in with huddle_hand_in and a one-line summary of what changed and why.",
  },
  {
    name: "security", role: "Security reviewer", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Review the host ticket's changes for security problems: injection, auth and permission gaps, secrets, unsafe file or shell use. Report each with file:line and impact.",
  },
  {
    name: "blast-radius", role: "What could this break", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Find what the host ticket's changes break outside the diff, where grep for callers won't show it: data formats and saved files read by older or newer versions, " +
      "settings, timing and ordering, other code or languages reading the same data, flags and defaults. Don't edit tracked files; you may run scripts and tests " +
      "(put scripts in your outputs folder). Name the one fact the change is safe because of and prove it by running real code (a small script or a test). " +
      "For each claim, say how far you got: claimed, pointed at a line, walked through, ran it, or reproduced in the app. " +
      "Report each risk with file:line, likelihood, cost if it happens and the cheapest check; list what you cleared separately.",
  },
  {
    name: "breaker", role: "Tries to break it", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Try to break the host ticket's changes from angles a normal review misses: edge and malformed inputs, empty and huge values, error paths, " +
      "concurrent calls, restarts and half-finished state. Then read it with a strict quality lens: needless code, duplicated logic, unclear names that will cause bugs. " +
      "Every finding needs a concrete failing scenario (input or steps, what goes wrong) and file:line; no style nits, and drop anything you can't make fail.",
  },
  {
    name: "researcher", role: "Researcher", model: "sonnet", mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Research the topic on the web and in linked repos (README, docs, source). Post facts with URLs or file:line refs, and one line on what problem each one solves. " +
      "No opinions on our product unless asked. Write long reports to your outputs folder and post the path.",
  },
  {
    name: "ux-critic", role: "Solo-dev UX critic", model: null, mode: "tagged", lead: false, canEdit: false, workspace: "shared",
    prompt: "Critique the user experience as a friction filter for one developer who uses the tool every day: can they tell at a glance who is doing what, " +
      "what needs them, what it costs and when it is done? Flag extra clicks, settings, jargon and anything built for teams that a solo user doesn't need. " +
      "Propose concrete changes (what, where, why), ranked by user impact; prefer removing over adding.",
  },
  {
    name: "facilitator", role: "Facilitator", model: null, mode: "monitor", lead: true, canEdit: false, workspace: "shared",
    prompt: "Drive a study with several critics: make sure every participant posts, challenge weak or duplicate findings, ask follow-ups and settle disagreements. " +
      "Keep the pinned findings list with huddle_findings: de-duplicate, tag each MUST / SHOULD / COULD with effort S/M/L. Don't add participants unless a clear gap appears. " +
      "When the work is done, write one ranked list that covers every finding: the top N first (N from the brief, else about 12), " +
      "then an \"Appendix\" section in the same file with every other finding, each with a one-line reason it ranks lower (duplicate of #3, low impact, out of scope...). " +
      "Never drop a finding silently. Tag @main once with that list. " +
      "Only mark done after you have sent your final consolidated list to @main.",
  },
];

const BUILTIN = new Map(BUILTIN_PRESETS.map((p) => [p.name, p]));

export const isBuiltinPreset = (name: string) => BUILTIN.has(name);

/** "QA Lead" -> "qa-lead". */
export function presetName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_NAME);
}

/** Built-ins (or their overrides) first in their usual order, then the user's own by name; each at its highest level. */
export function mergePresets(global: HuddlePreset[], board: HuddlePreset[] = []): HuddlePresetView[] {
  return mergeLayers(BUILTIN_PRESETS, global, board);
}

/** A preset to save, filled in from `input` over `base` (the preset it overrides or edits, if any); throws a readable message when invalid. */
export function presetFromInput(input: any, base?: HuddlePreset): HuddlePreset {
  if (!input || typeof input !== "object") throw new Error("preset must be an object");
  const name = presetName(typeof input.name === "string" ? input.name : "");
  if (!name) throw new Error("name is required (letters, digits and dashes)");
  if (RESERVED_NAMES.has(name)) throw new Error(`"${name}" is reserved; pick another name`);
  const text = (k: string) => {
    const v = input[k];
    if (v !== undefined && v !== null && typeof v !== "string") throw new Error(`${k} must be text`);
    return typeof v === "string" ? v.trim() : undefined;
  };
  const flag = (k: string) => {
    const v = input[k];
    if (v !== undefined && typeof v !== "boolean") throw new Error(`${k} must be true or false`);
    return v as boolean | undefined;
  };
  const prompt = text("prompt") || base?.prompt;
  if (!prompt) throw new Error("prompt is required: what this role does in the huddle");
  if (prompt.length > MAX_PROMPT) throw new Error(`prompt is too long (max ${MAX_PROMPT} characters)`);
  const lead = flag("lead") ?? base?.lead ?? false;
  // A lead watches every message unless a mode is given: a new lead, or one just made a lead, starts in monitor mode.
  const mode = input.mode ?? (lead && !base?.lead ? "monitor" : base?.mode ?? "tagged");
  if (mode !== "tagged" && mode !== "monitor") throw new Error("mode must be tagged or monitor");
  const asked = input.workspace ?? base?.workspace ?? "shared";
  if (asked !== "shared" && asked !== "own") throw new Error("workspace must be shared or own");
  const canEdit = flag("canEdit") ?? (input.workspace === undefined ? base?.canEdit : undefined) ?? asked === "own";
  // One that changes files always works in its own copy of the folder.
  const workspace = canEdit && name !== MAIN_PRESET ? "own" : asked;
  // Omitted: keep the base's model; null or "": the board's.
  const model = input.model === undefined ? base?.model ?? null : text("model") || null;
  const role = text("role") || base?.role || name.split("-").map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
  return {
    name, role, prompt, model, mode, workspace,
    lead,
    canEdit,
  };
}

/**
 * One level's presets after saving `input`: replaces its preset of that name, or adds an override or a new one.
 * `lower`: the presets under this level (built-ins for global; built-ins and global for a board), which an edit starts from.
 */
export function savePreset(list: HuddlePreset[], input: any, lower: HuddlePreset[] = BUILTIN_PRESETS): { list: HuddlePreset[]; preset: HuddlePreset } {
  const name = presetName(typeof input?.name === "string" ? input.name : "");
  const base = list.find((p) => p.name === name) ?? lower.find((p) => p.name === name);
  const preset = presetFromInput(input, base);
  return { list: withItem(list, preset), preset };
}

/** One level's presets after deleting `name`; `reset`: a lower level has it, so it falls back to that version. */
export function deletePreset(list: HuddlePreset[], name: string, lower: HuddlePreset[] = BUILTIN_PRESETS): { list: HuddlePreset[]; reset: boolean } {
  const n = presetName(name);
  if (!list.some((p) => p.name === n)) {
    if (BUILTIN.has(n)) throw new Error(`"${n}" is a built-in teammate; it can only be changed (save_huddle_preset), not deleted`);
    throw new Error(`no teammate "${name}" at this level`);
  }
  return { list: list.filter((p) => p.name !== n), reset: lower.some((p) => p.name === n) };
}

/** Keeps only well-formed entries from a hand-edited or old huddle-presets.json. */
export function cleanPresets(v: unknown): HuddlePreset[] {
  if (!Array.isArray(v)) return [];
  const out: HuddlePreset[] = [];
  for (const x of v) {
    try {
      const p = presetFromInput(x);
      if (!out.some((o) => o.name === p.name)) out.push(p);
    } catch {}
  }
  return out;
}

/** One line per preset, for list_huddle_presets and tool descriptions. */
export function presetLine(p: HuddlePresetView): string {
  const access = p.name === MAIN_PRESET ? "changes files in the ticket's folder"
    : p.canEdit ? "changes files in its own copy, hands them in" : p.workspace === "own" ? "own copy, reads only" : "reads only";
  const tags = [p.mode, access, p.lead && "lead", p.model && `model ${p.model}`];
  const src = presetSourceText(p);
  return `- ${p.name}: ${p.role} (${tags.filter(Boolean).join(", ")}; ${src})${p.name === MAIN_PRESET ? " [the coordinator, @main; not for rosters]" : ""}\n  ${p.prompt}`;
}

/** Where a preset comes from, in words: "built-in", "built-in, changed on this board", "all boards", "this board only"… */
export function presetSourceText(p: Pick<HuddlePresetView, "source" | "base" | "builtin">): string {
  const kind = p.builtin ? "built-in" : p.base === "global" || p.source === "global" ? "all boards" : "this board only";
  if (p.source === "board" && p.base) return `${kind}, changed on this board`;
  if (p.source === "global" && p.base) return `${kind}, changed for all boards`;
  return kind;
}
