export const REPO: string;
export function assetName(platform?: string, arch?: string): string | null;
export function assetUrl(asset: string, version?: string, repo?: string): string;
export function expectedSum(sums: string, asset: string): string | null;
export function sha256(buf: Uint8Array): string;
export function binDir(env?: Record<string, string | undefined>): string;
export function installBinary(opts?: { version?: string; dir?: string; log?: (msg: string) => void }): Promise<{ path: string; version: string }>;
export function isInstalled(dir?: string): boolean;
