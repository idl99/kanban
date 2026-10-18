import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileError, findInRoots, listDir, MAX_VIEW_BYTES, openWithSystem, readFileForView, resolveInside } from "../src/server/files";
import { makeRepo, tempDir } from "./helpers";

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FileError ? e.status : -1;
  }
  return 0;
};

test("resolveInside rejects .., absolute escapes and symlinks out of root", () => {
  const root = tempDir();
  const outside = tempDir();
  writeFileSync(join(outside, "secret"), "x");
  mkdirSync(join(root, "a"));
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(root, "a"), join(root, "inner"));
  expect(resolveInside(root, "")).toBe(root);
  expect(resolveInside(root, "a")).toBe(join(root, "a"));
  expect(resolveInside(root, "inner")).toBe(join(root, "a"));
  expect(status(() => resolveInside(root, "../x"))).toBe(400);
  expect(status(() => resolveInside(root, "a/../../x"))).toBe(400);
  expect(status(() => resolveInside(root, "link/secret"))).toBe(403);
  expect(status(() => resolveInside(root, "missing"))).toBe(404);
});

test("listDir sorts folders first and hides .git and gitignored entries", async () => {
  const root = await makeRepo();
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n");
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "Zdir"));
  writeFileSync(join(root, "src", "b.ts"), "");
  writeFileSync(join(root, "debug.log"), "");
  writeFileSync(join(root, "a.txt"), "");
  const top = await listDir(root, "");
  expect(top.map((e) => e.name)).toEqual(["src", "Zdir", ".gitignore", "a.txt", "README.md"]);
  expect(top[0]).toEqual({ name: "src", path: "src", type: "dir" });
  expect(await listDir(root, "src")).toEqual([{ name: "b.ts", path: "src/b.ts", type: "file" }]);
});

test("listDir outside a git repo shows everything but .git", async () => {
  const root = tempDir();
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "x.log"), "");
  expect((await listDir(root, "")).map((e) => e.name)).toEqual(["node_modules", "x.log"]);
});

test("readFileForView returns text, flags binary and large files", () => {
  const root = tempDir();
  writeFileSync(join(root, "a.ts"), "const a = 1;\n");
  writeFileSync(join(root, "img.bin"), new Uint8Array([0x89, 0x50, 0, 1]));
  writeFileSync(join(root, "big.txt"), "x".repeat(MAX_VIEW_BYTES + 1));
  expect(readFileForView(root, "a.ts")).toMatchObject({ content: "const a = 1;\n", binary: false, tooLarge: false });
  expect(readFileForView(root, "img.bin")).toMatchObject({ content: null, binary: true });
  expect(readFileForView(root, "big.txt")).toMatchObject({ content: null, tooLarge: true });
  expect(status(() => readFileForView(root, ""))).toBe(400);
});

test("openWithSystem passes the real path as one argument and refuses paths outside the folder", async () => {
  const root = tempDir();
  const log = join(tempDir(), "argv.txt");
  const opener = join(tempDir(), "opener.sh");
  writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
  writeFileSync(join(root, "a b.md"), "x");
  const file = openWithSystem(root, "a b.md", opener);
  for (let i = 0; i < 100 && !readFileSync(log, { flag: "a+" }).toString(); i++) await Bun.sleep(20);
  expect(readFileSync(log, "utf8")).toBe(`${file}\n`);
  expect(status(() => openWithSystem(root, "../x", opener))).toBe(400);
  expect(status(() => openWithSystem(root, "missing", opener))).toBe(404);
});

test("findInRoots looks in the ticket's copy first, then the project, and never outside", () => {
  const ticket = tempDir();
  const project = tempDir();
  const outside = tempDir();
  const home = tempDir();
  mkdirSync(join(ticket, "docs"));
  writeFileSync(join(ticket, "docs", "review.md"), "# new");
  mkdirSync(join(project, "docs"));
  writeFileSync(join(project, "docs", "review.md"), "# old");
  writeFileSync(join(project, "only.md"), "x");
  writeFileSync(join(outside, "secret.md"), "x");
  symlinkSync(outside, join(project, "link"));
  mkdirSync(join(home, "notes"));
  writeFileSync(join(home, "notes", "a.md"), "x");
  const roots = [{ name: "ticket" as const, dir: ticket }, { name: "project" as const, dir: project }];
  const real = (p: string) => readFileSync(p, "utf8");

  const f = findInRoots(roots, "docs/review.md")!;
  expect(f).toMatchObject({ root: "ticket", rel: "docs/review.md" });
  expect(real(f.file)).toBe("# new");
  expect(findInRoots(roots, "./only.md")).toMatchObject({ root: "project", rel: "only.md" });
  expect(findInRoots(roots, join(project, "docs", "review.md"))).toMatchObject({ root: "project", rel: "docs/review.md" });
  // Missing, folders, .., absolute paths and symlinks out of every root.
  expect(findInRoots(roots, "docs/missing.md")).toBeNull();
  expect(findInRoots(roots, "docs")).toBeNull();
  expect(findInRoots(roots, "../../etc/passwd")).toBeNull();
  expect(findInRoots(roots, "docs/../only.md")).toBeNull();
  expect(findInRoots(roots, join(outside, "secret.md"))).toBeNull();
  expect(findInRoots(roots, "link/secret.md")).toBeNull();
  expect(findInRoots(roots, "/etc/hosts")).toBeNull();
  // ~/ is the home folder, still only inside a root.
  expect(findInRoots(roots, "~/notes/a.md", home)).toBeNull();
  expect(findInRoots([...roots, { name: "outputs", dir: home }], "~/notes/a.md", home)).toMatchObject({ root: "outputs", rel: "notes/a.md" });
});
