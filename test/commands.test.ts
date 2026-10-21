import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commandText, frontmatter, listCommands, localCommandOutput, parseSlash, rememberInit, slashMessage, useBundledFile, validModel } from "../src/server/commands";
import { parseSession } from "../src/server/session";
import { commandNote, inlineSlashQuery, insertInlineCommand, matchCommands, messageCommand, slashQuery, splitCommandMentions, type SlashCommand } from "../web/src/slashText";
import { tempDir } from "./helpers";

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const skill = (description: string, name?: string) => `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\nBody`;

test("frontmatter: description (quoted, folded) or the first text line", () => {
  expect(frontmatter(skill("Echo it")).description).toBe("Echo it");
  expect(frontmatter(`---\nname: x\ndescription: "Quoted: yes"\n---\n`)).toEqual({ name: "x", description: "Quoted: yes" });
  expect(frontmatter(`---\ndescription: >\n  Folded\n  over lines\nother: 1\n---\n`).description).toBe("Folded over lines");
  expect(frontmatter("# Release the app\n\nSteps…").description).toBe("Release the app");
  expect(frontmatter(`---\ndescription: x\nuser-invocable: false\n---\n`).userInvocable).toBe(false);
  expect(frontmatter(`---\nuser-invocable: "true"\n---\n`).userInvocable).toBe(true);
});

test("listCommands: built-ins, project over user, folders and plugins namespaced", () => {
  const config = tempDir("ck-cfg-");
  const project = tempDir("ck-proj-");
  // Named after its folder, like Claude Code does, not after the frontmatter name.
  write(join(config, "skills", "retro", "SKILL.md"), skill("User retro", "sprint-retrospective"));
  write(join(config, "skills", "shared", "SKILL.md"), skill("User version"));
  write(join(config, "commands", "git", "sync.md"), "Sync the branch");
  write(join(project, ".claude", "skills", "shared", "SKILL.md"), skill("Project version"));
  write(join(project, ".claude", "commands", "x.md"), skill("Project command"));
  // Only Claude may use this one: not offered, and its name isn't taken for a bundled skill either.
  write(join(config, "skills", "internal", "SKILL.md"), `---\ndescription: Background helper\nuser-invocable: false\n---\n`);
  // An enabled user-wide plugin, a disabled one, and one installed for another project.
  const plugin = (name: string) => {
    const dir = join(config, "plugins", "cache", "m", name, "1.0.0");
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    write(join(dir, "skills", "brainstorming", "SKILL.md"), skill(`${name} brainstorming`));
    write(join(dir, "commands", "go.md"), skill(`${name} go`));
    return dir;
  };
  write(join(config, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "superpowers@m": [{ scope: "user", installPath: plugin("superpowers") }],
      "off@m": [{ scope: "user", installPath: plugin("off") }],
      "elsewhere@m": [{ scope: "project", projectPath: "/somewhere/else", installPath: plugin("elsewhere") }],
    },
  }));
  write(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "superpowers@m": true, "off@m": false, "elsewhere@m": true } }));

  const list = listCommands(project, { configDir: config, fresh: true });
  const by = (n: string) => list.find((c) => c.name === n);
  expect(by("compact")).toMatchObject({ kind: "builtin", source: "claude", local: true });
  expect(by("model")).toMatchObject({ kind: "builtin", source: "board" });
  expect(by("effort")).toMatchObject({ kind: "builtin", source: "board" });
  expect(by("clear")).toBeUndefined();
  expect(by("internal")).toBeUndefined();
  expect(by("retro")).toMatchObject({ kind: "skill", source: "user", description: "User retro" });
  expect(by("shared")).toMatchObject({ source: "project", description: "Project version" });
  expect(list.filter((c) => c.name === "shared").length).toBe(1);
  expect(by("x")).toMatchObject({ kind: "command", source: "project" });
  expect(by("git:sync")).toMatchObject({ kind: "command", source: "user", description: "Sync the branch" });
  expect(by("superpowers:brainstorming")).toMatchObject({ kind: "skill", source: "plugin" });
  expect(by("superpowers:go")).toMatchObject({ kind: "command", source: "plugin" });
  expect(by("off:brainstorming")).toBeUndefined();
  expect(by("elsewhere:go")).toBeUndefined();

  // Skills only a run's init event knew (bundled with Claude Code) join the list, for every folder, and are saved.
  const file = join(tempDir("ck-store-"), "claude-commands.json");
  useBundledFile(file);
  const init = (skills: string[], offered: string[]) =>
    rememberInit(project, { type: "system", subtype: "init", skills, slash_commands: offered }, { configDir: config });
  init(["simplify", "retro", "internal", "superpowers:brainstorming", "auto-only", "doctor"], ["simplify", "retro", "internal", "superpowers:brainstorming", "doctor"]);
  const after = listCommands(project, { configDir: config });
  expect(after.find((c) => c.name === "simplify")).toMatchObject({ kind: "skill", source: "claude" });
  expect(after.filter((c) => c.name === "retro")).toHaveLength(1);
  // Not offered as a slash command, hidden on disk, or a plugin's: not bundled.
  expect(after.find((c) => c.name === "auto-only")).toBeUndefined();
  expect(after.find((c) => c.name === "internal")).toBeUndefined();
  expect(after.find((c) => c.name === "doctor")).toBeUndefined();
  expect(JSON.parse(readFileSync(file, "utf8")).bundledSkills).toEqual(["simplify"]);
  // Another folder (and a fresh start reading the file) has them too.
  useBundledFile(file);
  expect(listCommands(tempDir("ck-other-"), { configDir: config }).find((c) => c.name === "simplify")).toBeTruthy();
  useBundledFile(null);
});

test("validModel: aliases, [1m], full ids; typos refused", () => {
  for (const ok of ["sonnet", "opus", "haiku", "fable", "opusplan", "opus[1m]", "claude-opus-5-5", "claude-haiku-4-5-20251001"]) expect(validModel(ok)).toBe(true);
  for (const bad of ["sonet", "gpt-4", "claude", "$(rm)", "sonnet sonnet"]) expect(validModel(bad)).toBe(false);
});

test("parseSlash / slashMessage: only known commands at the start of the message", () => {
  const list: any[] = [{ name: "brainstorming", kind: "skill", source: "plugin", description: "" }, { name: "compact", kind: "builtin", source: "claude", local: true, description: "" }];
  expect(parseSlash("  /brainstorming plan the import\nflow ")).toEqual({ name: "brainstorming", args: "plan the import\nflow" });
  expect(parseSlash("/Users/leo/x.ts is wrong")).toBeNull();
  expect(parseSlash("see /brainstorming")).toBeNull();
  expect(slashMessage("/brainstorming  plan it ", list)).toMatchObject({ args: "plan it", text: "/brainstorming plan it" });
  expect(slashMessage("/compact", list)).toMatchObject({ text: "/compact", command: { local: true } });
  expect(slashMessage("/notacommand hi", list)).toBeNull();
});

test("commandText / localCommandOutput read Claude Code's command tags", () => {
  expect(commandText("<command-message>shout</command-message>\n<command-name>/shout</command-name>\n<command-args>hi there</command-args>")).toBe("/shout hi there");
  expect(commandText("<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>")).toBe("/compact");
  expect(commandText("plain text")).toBeNull();
  expect(localCommandOutput("<local-command-stdout>Set model to \u001b[1mSonnet\u001b[22m</local-command-stdout>")).toBe("Set model to Sonnet");
  expect(localCommandOutput("hello")).toBeNull();
});

test("parseSession shows commands as typed, their output and compaction", () => {
  const line = (o: object) => JSON.stringify({ timestamp: "2026-10-08T00:00:00Z", ...o });
  const raw = [
    line({ type: "user", uuid: "1", message: { role: "user", content: "<command-message>echoargs</command-message>\n<command-name>/echoargs</command-name>\n<command-args>hello</command-args>" } }),
    line({ type: "user", uuid: "2", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x" }] } }),
    line({ type: "system", uuid: "3", subtype: "compact_boundary", content: "Conversation compacted" }),
    line({ type: "user", uuid: "4", isCompactSummary: true, message: { role: "user", content: "This session is being continued…" } }),
    line({ type: "user", uuid: "5", message: { role: "user", content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>" } }),
    line({ type: "system", uuid: "6", subtype: "local_command", content: "<local-command-stdout>## Context Usage</local-command-stdout>" }),
    // Typed in a terminal: hidden, with what it printed.
    line({ type: "user", uuid: "7", message: { role: "user", content: "<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>" } }),
    line({ type: "user", uuid: "8", message: { role: "user", content: "<local-command-stdout>Goodbye!</local-command-stdout>" } }),
    line({ type: "user", uuid: "9", message: { role: "user", content: "<command-name>/resume</command-name>\n<command-args></command-args>" } }),
    line({ type: "user", uuid: "10", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args>opus</command-args>" } }),
    line({ type: "system", uuid: "11", subtype: "local_command", content: "<local-command-stdout>Set model to Opus</local-command-stdout>" }),
  ].join("\n");
  expect(parseSession(raw).entries.map((e) => [e.role, e.kind, e.text, e.command ?? e.commandOutput ?? null])).toEqual([
    ["user", "text", "/echoargs hello", "echoargs"],
    ["user", "board", "Conversation compacted", null],
    ["user", "text", "/context", "context"],
    ["assistant", "text", "## Context Usage", true],
    ["user", "text", "/model opus", "model"],
    ["assistant", "text", "Set model to Opus", true],
  ]);
});

const cmds: SlashCommand[] = [
  { name: "compact", kind: "builtin", source: "claude", description: "" },
  { name: "superpowers:brainstorming", kind: "skill", source: "plugin", description: "" },
  { name: "release", kind: "command", source: "project", description: "" },
  { name: "retro", kind: "skill", source: "user", description: "" },
  { name: "requesting-code-review", kind: "skill", source: "plugin", description: "" },
];

test("slashQuery: only the message's first word, caret inside it", () => {
  expect(slashQuery("/", 1)).toBe("");
  expect(slashQuery("/bra", 4)).toBe("bra");
  expect(slashQuery("/brainstorming plan", 19)).toBeNull();
  expect(slashQuery("hi /bra", 7)).toBeNull();
  expect(slashQuery("/Users/x", 8)).toBeNull();
});

test("matchCommands: grouped skills, commands, built-ins; prefix before fuzzy", () => {
  expect(matchCommands(cmds, "").map((c) => c.name)).toEqual(["requesting-code-review", "retro", "superpowers:brainstorming", "release", "compact"]);
  // Prefix matches only, when there are any: "/co" is compact, not a fuzzy skill above it.
  expect(matchCommands(cmds, "re").map((c) => c.name)).toEqual(["requesting-code-review", "retro", "release"]);
  expect(matchCommands(cmds, "co").map((c) => c.name)).toEqual(["compact"]);
  // Plugin skills match on their own name too.
  expect(matchCommands(cmds, "brain").map((c) => c.name)).toEqual(["superpowers:brainstorming"]);
  // The tightest fuzzy match first.
  expect(matchCommands(cmds, "rtr")[0].name).toBe("retro");
});

test("messageCommand / commandNote: the chip under a sent command", () => {
  expect(messageCommand("/retro last sprint", cmds)?.name).toBe("retro");
  expect(messageCommand("/nope", cmds)).toBeNull();
  expect(commandNote(cmds[3])).toBe("Runs skill · user");
  expect(commandNote(cmds[2])).toBe("Runs command · project");
  expect(commandNote({ name: "clear", kind: "builtin", source: "board", description: "" })).toBe("Board command");
});

test("inlineSlashQuery: `/` at any word start in a description, not inside paths or words", () => {
  expect(inlineSlashQuery("/gri", 4)).toEqual({ start: 0, query: "gri" });
  expect(inlineSlashQuery("Use /grill", 10)).toEqual({ start: 4, query: "grill" });
  expect(inlineSlashQuery("line\n(/sup", 11)).toEqual({ start: 6, query: "sup" });
  expect(inlineSlashQuery("Use /", 5)).toEqual({ start: 4, query: "" });
  expect(inlineSlashQuery("a/b", 3)).toBeNull();
  expect(inlineSlashQuery("see /Users/leo", 14)).toBeNull();
  expect(inlineSlashQuery("Use /grill me", 13)).toBeNull();
});

test("insertInlineCommand: replaces the whole word, adds a space only when needed", () => {
  expect(insertInlineCommand("Use /gr then", 4, "grill-me")).toEqual({ value: "Use /grill-me then", caret: 14 });
  expect(insertInlineCommand("Use /grXY", 4, "grill-me")).toEqual({ value: "Use /grill-me ", caret: 14 });
  expect(insertInlineCommand("/", 0, "a:b")).toEqual({ value: "/a:b ", caret: 5 });
});

test("splitCommandMentions: known names only, trailing dots stay text, paths skipped", () => {
  const known = (n: string) => n === "grill-me" || n === "superpowers:brainstorming";
  expect(splitCommandMentions("Use /grill-me.", known)).toEqual(["Use ", { name: "grill-me" }, "."]);
  expect(splitCommandMentions("(/superpowers:brainstorming) then /other", known)).toEqual(["(", { name: "superpowers:brainstorming" }, ") then /other"]);
  expect(splitCommandMentions("a/grill-me and /grill-me/x", known)).toEqual(["a/grill-me and /grill-me/x"]);
});
