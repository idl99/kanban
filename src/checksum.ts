/** The sha256 that a `shasum -a 256` listing (SHA256SUMS) gives for `name`, or null when it has no entry. */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

export function sha256(data: ArrayBuffer | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}
