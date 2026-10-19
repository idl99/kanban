// Plain helpers for proposed-teammate cards (propose_teammate), kept apart from the components so tests can import them.
// No import from api.ts: the server's typecheck (no DOM types) reaches this file through its tests.

/** A teammate's own fields (HuddlePreset in api.ts without where it is saved). */
export interface TeammateDraft {
  name: string;
  role: string;
  prompt: string;
  model: string | null;
  mode: "tagged" | "monitor";
  lead: boolean;
  canEdit: boolean;
  workspace: "shared" | "own";
}

type Level = "global" | "board";
/** TeammateProposal in api.ts. */
type Proposal = Pick<TeammateDraft, "name" | "prompt"> & Partial<TeammateDraft> & { why?: string };

/** What "Edit first" opens: the Team tab's editor, prefilled with the proposal; card: the chat card its save answers. */
export interface TeammateEditRequest {
  draft: TeammateDraft;
  isNew: boolean;
  scope: Level;
  card?: { ticketId: string; uuid: string };
}

/** "a11y-tester" -> "A11y tester", as the daemon makes a label from a name. */
const labelOf = (name: string) => name.split("-").map((w, i) => (i ? w : (w[0] ?? "").toUpperCase() + w.slice(1))).join(" ");

/** The teammate the proposal would save: its fields over the existing teammate's (or the daemon's defaults for a new one). */
export function proposedTeammate(p: Proposal, existing?: TeammateDraft | null): TeammateDraft {
  const asked = p.workspace ?? existing?.workspace ?? "shared";
  const canEdit = p.canEdit ?? (p.workspace === undefined ? existing?.canEdit : undefined) ?? asked === "own";
  // As the daemon saves it: one that changes files works in its own copy.
  const workspace = canEdit ? "own" : asked;
  return {
    name: p.name,
    role: p.role ?? existing?.role ?? labelOf(p.name),
    prompt: p.prompt,
    model: p.model !== undefined ? p.model : existing?.model ?? null,
    mode: p.mode ?? existing?.mode ?? "tagged",
    lead: p.lead ?? existing?.lead ?? false,
    canEdit,
    workspace,
  };
}

const wakes = (m: TeammateDraft["mode"]) => (m === "tagged" ? "Wakes when @mentioned" : "Gets every message");
const access = (t: Pick<TeammateDraft, "workspace" | "canEdit">) => (t.canEdit ? "changes files (own copy, hands them in)" : "reads only");

/** "Wakes when @mentioned · reads only · sonnet". */
export function teammateMeta(t: TeammateDraft): string {
  return [wakes(t.mode), access(t), t.lead && "lead", t.model ?? "board's model"].filter(Boolean).join(" · ");
}

export interface DiffLine {
  kind: "-" | "+";
  text: string;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What saving the proposal changes on an existing teammate, one -/+ pair per field (the prompt: only what it adds, when it adds to the end). */
export function teammateDiff(next: TeammateDraft, cur: TeammateDraft): DiffLine[] {
  const out: DiffLine[] = [];
  const pair = (field: string, from: string, to: string) => {
    if (from !== to) out.push({ kind: "-", text: `${field}: ${from}` }, { kind: "+", text: `${field}: ${to}` });
  };
  pair("label", cur.role, next.role);
  pair("mode", wakes(cur.mode), wakes(next.mode));
  pair("access", access(cur), access(next));
  pair("lead", cur.lead ? "yes" : "no", next.lead ? "yes" : "no");
  pair("model", cur.model ?? "board's model", next.model ?? "board's model");
  const [a, b] = [cur.prompt.trim(), next.prompt.trim()];
  if (a !== b) {
    if (b.startsWith(a)) out.push({ kind: "+", text: `prompt: …${clip(b.slice(a.length).trim())}` });
    else out.push({ kind: "-", text: `prompt: ${clip(a)}` }, { kind: "+", text: `prompt: ${clip(b)}` });
  }
  return out;
}

/** "@wa-watcher · all boards". */
export const savedText = (name: string, scope: Level | undefined) => `@${name}${scope ? ` · ${scope === "global" ? "all boards" : "this board"}` : ""}`;
