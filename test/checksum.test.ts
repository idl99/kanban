import { expect, test } from "bun:test";
import { sha256, sumFor } from "../src/checksum";

const A = "a".repeat(64);
const B = "b".repeat(64);

test("sumFor finds the asset's hash in a shasum listing, text or binary mode", () => {
  const sums = `${A}  ckanban-darwin-arm64\n${B} *ckanban-darwin-x64\n`;
  expect(sumFor(sums, "ckanban-darwin-arm64")).toBe(A);
  expect(sumFor(sums, "ckanban-darwin-x64")).toBe(B);
});

test("sumFor returns null for a missing entry or a name that is only a prefix", () => {
  expect(sumFor(`${A}  ckanban-darwin-arm64-old\n`, "ckanban-darwin-arm64")).toBeNull();
  expect(sumFor("", "ckanban-darwin-arm64")).toBeNull();
});

test("sha256 matches shasum -a 256", () => {
  expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
