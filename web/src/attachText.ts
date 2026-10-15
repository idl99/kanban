/** What can be attached and how attachments look in markdown (kept free of React/DOM so they can be unit tested). */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Same lists as src/server/attachments.ts (a test keeps them in sync). */
export const DOC_EXTS = ["pdf", "docx", "xlsx", "pptx"];
export const TEXT_EXTS = [
  "txt", "md", "csv", "tsv", "json", "js", "jsx", "ts", "tsx", "py", "rb", "go", "java", "c", "h", "cpp", "cs", "php",
  "swift", "kt", "rs", "html", "css", "yaml", "yml", "xml", "toml", "ini", "log", "sql", "sh",
];
export const FILE_EXTS = [...DOC_EXTS, ...TEXT_EXTS];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The file picker's `accept`: images plus the file extensions. */
export const ACCEPT = ["image/png", "image/jpeg", "image/gif", "image/webp", ...FILE_EXTS.map((e) => `.${e}`)].join(",");

export const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

export const isImageFile = (f: { name: string; type: string }) => IMAGE_TYPES.includes(f.type);

/** Why a file can't be attached, or null when it can. */
export function refusal(f: { name: string; type: string; size: number }): string | null {
  if (!isImageFile(f) && !FILE_EXTS.includes(extOf(f.name))) {
    return `${f.name || "file"}: this kind of file can't be added (images, PDF, Word, Excel, PowerPoint, text and code files can)`;
  }
  if (f.size > MAX_ATTACHMENT_BYTES) return `${f.name || "file"}: too large (max 25 MB)`;
  if (f.size === 0) return `${f.name || "file"}: the file is empty`;
  return null;
}

/**
 * The original name shown in the markdown link (`[name](/api/attachments/…)`). Cleaned so it can't break the
 * link: square brackets become round ones; no line breaks, control characters, `<>` backticks or backslashes.
 * Same rules as cleanFileName in src/server/attachments.ts.
 */
export function cleanFileName(name: string): string {
  const out = name.replace(/\[/g, "(").replace(/]/g, ")").replace(/[<>`\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  return out || "file";
}

export type FileKind = { tile: string; type: string; cls: string };

/** The card's tile text, the type word under the name, and its colour class. */
export function fileKind(name: string): FileKind {
  const ext = extOf(name);
  if (ext === "pdf") return { tile: "PDF", type: "PDF", cls: "pdf" };
  if (ext === "docx") return { tile: "DOC", type: "Word", cls: "doc" };
  if (ext === "xlsx") return { tile: "XLS", type: "Excel", cls: "xls" };
  if (ext === "pptx") return { tile: "PPT", type: "PowerPoint", cls: "ppt" };
  if (IMAGE_EXTS.includes(ext)) return { tile: "IMG", type: "Image", cls: "img" };
  if (ext === "md" || ext === "txt" || ext === "log") return { tile: ext.toUpperCase(), type: "Text", cls: "txt" };
  return { tile: ext.toUpperCase().slice(0, 4) || "FILE", type: ext === "csv" || ext === "tsv" ? "Table" : "Code", cls: "txt" };
}

/** Opens in a new tab (PDF, images, text) rather than downloading (Office files). */
export const opensInline = (name: string) => !["docx", "xlsx", "pptx"].includes(extOf(name));

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Link to a stored attachment carrying the name it should open or download under. */
export function fileHref(stored: string, name: string, download = false): string {
  return `/api/attachments/${stored}?${download ? "download=1&" : ""}name=${encodeURIComponent(name)}`;
}

const NAME = "[0-9a-f]{32}\\.[a-z0-9]+";
/** A stored attachment in a link or image source: the UI URL, or the absolute path Claude was given. */
export const ATTACHMENT_SRC = new RegExp(`(?:^|/)attachments/(${NAME})(?:[?#].*)?$`);

/** Placeholder for a file while it uploads; `n` keeps two uploads of the same name apart. */
export const fileHolder = (name: string, n: number) => `[Uploading ${cleanFileName(name)}…](#upload-${n})`;

export type DraftFile =
  | { state: "done"; name: string; stored: string; token: string }
  | { state: "uploading"; name: string; token: string };

const DONE_RE = new RegExp(`\\[([^\\]\\n]*)\\]\\(/api/attachments/(${NAME})\\)`, "g");
const UPLOADING_RE = /\[Uploading ([^\]\n]*)…\]\(#upload-\d+\)/g;

/** The non-image files in a draft, in order: uploaded links and ones still uploading. `token` is their markdown. */
export function draftFiles(text: string): DraftFile[] {
  const out: { at: number; f: DraftFile }[] = [];
  for (const m of text.matchAll(DONE_RE)) {
    if (m.index! > 0 && text[m.index! - 1] === "!") continue; // an image
    out.push({ at: m.index!, f: { state: "done", name: m[1] || m[2], stored: m[2], token: m[0] } });
  }
  for (const m of text.matchAll(UPLOADING_RE)) out.push({ at: m.index!, f: { state: "uploading", name: m[1], token: m[0] } });
  return out.sort((a, b) => a.at - b.at).map((x) => x.f);
}
