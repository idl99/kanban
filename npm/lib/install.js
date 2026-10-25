// Downloads the ckanban Mac app from GitHub releases, checks it against SHA256SUMS
// and puts it in place. Same steps as install.sh, in plain Node (no Bun needed).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = "leoawesome/ckanban";

/** Release asset name for this Mac's chip, or null when ckanban has no build for it. */
export function assetName(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin") return null;
  if (arch === "arm64") return "ckanban-darwin-arm64";
  if (arch === "x64") return "ckanban-darwin-x64";
  return null;
}

/** Download URL of an asset; version "latest" or e.g. "0.14.0" / "v0.14.0". */
export function assetUrl(asset, version = "latest", repo = REPO) {
  if (version === "latest") return `https://github.com/${repo}/releases/latest/download/${asset}`;
  return `https://github.com/${repo}/releases/download/v${String(version).replace(/^v/, "")}/${asset}`;
}

/** The expected sha256 for `asset` from a SHA256SUMS file (`<hash>  <name>` or `<hash> *<name>`), or null. */
export function expectedSum(sums, asset) {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && (name === asset || name === `*${asset}`)) return hash.toLowerCase();
  }
  return null;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function binDir(env = process.env) {
  return env.CKANBAN_BIN_DIR || join(homedir(), ".local", "bin");
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Downloads, verifies and installs the binary to `<binDir>/ckanban`. Nothing is put in place
 * unless the checksum matches. Returns the installed path and the version it reports.
 */
export async function installBinary({ version = "latest", dir = binDir(), log = console.log } = {}) {
  const asset = assetName();
  if (!asset) throw new Error(process.platform === "darwin" ? `ckanban has no build for this Mac's chip (${process.arch}).` : "ckanban currently supports macOS only.");
  const url = assetUrl(asset, version);
  log(`Installing ckanban (${version}, ${asset.replace("ckanban-", "")})`);
  const [bin, sums] = await Promise.all([
    download(url),
    download(url.replace(/[^/]+$/, "SHA256SUMS")).then(
      (b) => b.toString("utf8"),
      () => {
        throw new Error("Couldn't download the checksums, so the app can't be verified. Nothing was installed.");
      },
    ),
  ]);
  const want = expectedSum(sums, asset);
  if (!want) throw new Error(`SHA256SUMS has no entry for ${asset}. Nothing was installed.`);
  const got = sha256(bin);
  if (got !== want) throw new Error(`Checksum mismatch for ${asset}: expected ${want}, got ${got}. The download may be corrupt or tampered with. Nothing was installed.`);
  log("✓ Checksum verified");

  mkdirSync(dir, { recursive: true });
  const tmp = join(tmpdir(), `ckanban-${process.pid}-${Date.now()}`);
  const target = join(dir, "ckanban");
  try {
    writeFileSync(tmp, bin, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    spawnSync("xattr", ["-d", "com.apple.quarantine", tmp], { stdio: "ignore" });
    try {
      renameSync(tmp, target);
    } catch {
      // Temp folder on another disk: copy instead.
      copyFileSync(tmp, target);
      chmodSync(target, 0o755);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  const v = spawnSync(target, ["--version"], { encoding: "utf8" });
  if (v.status !== 0) throw new Error(`Installed ${target}, but it doesn't start: ${(v.stderr || "").trim()}`);
  const installed = v.stdout.trim();
  log(`✓ Installed ${target} (${installed})`);
  return { path: target, version: installed };
}

export function isInstalled(dir = binDir()) {
  return existsSync(join(dir, "ckanban"));
}
