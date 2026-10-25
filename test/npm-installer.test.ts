import { expect, test } from "bun:test";
import { assetName, assetUrl, expectedSum, installBinary, sha256 } from "../npm/lib/install.js";

test("npm installer picks the release asset for each Mac chip, nothing elsewhere", () => {
  expect(assetName("darwin", "arm64")).toBe("ckanban-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("ckanban-darwin-x64");
  expect(assetName("linux", "x64")).toBeNull();
  expect(assetName("win32", "x64")).toBeNull();
});

test("npm installer builds latest and pinned download URLs", () => {
  expect(assetUrl("ckanban-darwin-arm64")).toBe("https://github.com/leoawesome/ckanban/releases/latest/download/ckanban-darwin-arm64");
  expect(assetUrl("ckanban-darwin-x64", "0.14.0")).toBe("https://github.com/leoawesome/ckanban/releases/download/v0.14.0/ckanban-darwin-x64");
  expect(assetUrl("ckanban-darwin-x64", "v0.14.0")).toBe("https://github.com/leoawesome/ckanban/releases/download/v0.14.0/ckanban-darwin-x64");
});

test("npm installer reads the expected checksum from SHA256SUMS", () => {
  const sums = "AAA111  ckanban-darwin-arm64\nbbb222 *ckanban-darwin-x64\n";
  expect(expectedSum(sums, "ckanban-darwin-arm64")).toBe("aaa111");
  expect(expectedSum(sums, "ckanban-darwin-x64")).toBe("bbb222");
  expect(expectedSum(sums, "ckanban-darwin")).toBeNull();
  expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("npm installer puts nothing in place when the checksum doesn't match", async () => {
  if (!assetName()) return;
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ckanban-npm-test-"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    new Response(String(url).endsWith("SHA256SUMS") ? `${"0".repeat(64)}  ${assetName()}\n` : "tampered")) as unknown as typeof fetch;
  try {
    await expect(installBinary({ version: "0.14.0", dir, log: () => {} })).rejects.toThrow("Checksum mismatch");
    expect(existsSync(join(dir, "ckanban"))).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
