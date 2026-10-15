import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Images and files pasted, dropped or picked into descriptions and chat. Stored flat under <data root>/attachments/. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const TYPE_OF_IMAGE_EXT = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t]));

/** Documents: PDF, and Office files (zip containers; Claude converts those itself). */
const DOC_EXTS = ["pdf", "docx", "xlsx", "pptx"];
/** Text and code: stored as-is and always served as plain text (never as HTML, even .html). */
const TEXT_EXTS = [
  "txt", "md", "csv", "tsv", "json", "js", "jsx", "ts", "tsx", "py", "rb", "go", "java", "c", "h", "cpp", "cs", "php",
  "swift", "kt", "rs", "html", "css", "yaml", "yml", "xml", "toml", "ini", "log", "sql", "sh",
];
/** Extensions of non-image files that can be attached (the web UI keeps the same list in attachText.ts). */
export const FILE_EXTS = [...DOC_EXTS, ...TEXT_EXTS];

const EXT_ALT = [...Object.values(IMAGE_TYPES), ...FILE_EXTS].join("|");
/** Only names we generate: 32 hex chars + a known extension. Anything else (../, subdirs) is rejected. */
const NAME_RE = new RegExp(`^[0-9a-f]{32}\\.(?:${EXT_ALT})$`);
/** An attachment file name inside other text (a URL or a path); the name is the first group. */
export const ATTACHMENT_NAME_SRC = `([0-9a-f]{32}\\.(?:${EXT_ALT}))\\b`;
/** An attachment reference in text: the UI URL or an absolute path into an attachments folder. */
const REF_RE = new RegExp(`(?:\\/api\\/attachments\\/|\\/attachments\\/)${ATTACHMENT_NAME_SRC}`, "g");
const URL_RE = new RegExp(`\\/api\\/attachments\\/${ATTACHMENT_NAME_SRC}`, "g");

export const IMAGES_NOTE = "Images in this message are local files; open them with the Read tool to see them.";
export const FILES_NOTE = "Files attached to this message are local files. Open images, PDFs and text files with the Read tool. "
  + "For Word, Excel or PowerPoint files, convert them to text yourself with what this computer already has "
  + "(for example unzip the file and read its XML, textutil on macOS, python or pandoc); don't ask the user to install anything. "
  + "If you can't read a file, tell the user which one.";

export function isAttachmentName(name: string): boolean {
  return NAME_RE.test(name);
}

const extOf = (name: string) => name.split(".").pop()!.toLowerCase();
export const isImageName = (name: string) => extOf(name) in TYPE_OF_IMAGE_EXT;

const SERVED_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The content type a stored attachment is served with: text and code always as plain text. */
export function attachmentType(name: string): string | null {
  if (!isAttachmentName(name)) return null;
  const ext = extOf(name);
  return TYPE_OF_IMAGE_EXT[ext] ?? SERVED_TYPES[ext] ?? "text/plain; charset=utf-8";
}

/** Opens in the browser (images, PDF, text) rather than downloading (Office files). */
export function opensInline(name: string): boolean {
  const ext = extOf(name);
  return !["docx", "xlsx", "pptx"].includes(ext);
}

/** The file's first bytes must match its type (a renamed program or a fake PDF is rejected). */
function looksLike(ext: string, b: Uint8Array): boolean {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  switch (ext) {
    case "png": return at(0, 0x89, 0x50, 0x4e, 0x47);
    case "jpg": return at(0, 0xff, 0xd8, 0xff);
    case "gif": return at(0, 0x47, 0x49, 0x46, 0x38);
    case "webp": return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    case "pdf": return at(0, 0x25, 0x50, 0x44, 0x46); // %PDF
    case "docx": case "xlsx": case "pptx": return at(0, 0x50, 0x4b, 0x03, 0x04); // zip
    default: return TEXT_EXTS.includes(ext) && !b.subarray(0, 8192).includes(0);
  }
}

/**
 * The stored extension for an upload: from the file name when there is one (browsers send empty or odd types
 * for .md, .csv and code), else from an image content type. Null when the file can't be attached.
 */
export function uploadExt(type: string, fileName?: string | null): string | null {
  const ext = fileName?.includes(".") ? extOf(fileName) : "";
  if (ext) {
    if (FILE_EXTS.includes(ext)) return ext;
    if (ext === "jpeg") return "jpg";
    if (ext in TYPE_OF_IMAGE_EXT) return ext;
    // A pasted image can carry a made-up name; its type still says what it is.
  }
  return IMAGE_TYPES[type] ?? null;
}

export const UNSUPPORTED = "this kind of file can't be attached (images, PDF, Word, Excel, PowerPoint, text and code files can)";

/**
 * Attachment names are generated (`<32 hex>.<ext>`); the original name only lives in the markdown link text.
 * Cleaned so it can't break that link: square brackets become round ones; no line breaks, control characters,
 * `<>` backticks or backslashes; at most 120 characters.
 */
export function cleanFileName(name: string): string {
  const out = name.replace(/\[/g, "(").replace(/]/g, ")").replace(/[<>`\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  return out || "file";
}

export class AttachmentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Validates and saves an image or file; returns its stored file name. `ext` comes from uploadExt. */
export function saveAttachment(dir: string, ext: string | null, bytes: Uint8Array): string {
  if (!ext || !NAME_RE.test(`${"0".repeat(32)}.${ext}`)) throw new AttachmentError(415, UNSUPPORTED);
  if (bytes.byteLength === 0) throw new AttachmentError(400, "file is empty");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, "file is larger than 25 MB");
  if (!looksLike(ext, bytes)) throw new AttachmentError(400, `file is not a valid ${ext.toUpperCase()} file`);
  mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
  writeFileSync(join(dir, name), bytes);
  return name;
}

export function attachmentFile(dir: string, name: string): string | null {
  if (!isAttachmentName(name)) return null;
  const file = join(dir, name);
  return existsSync(file) ? file : null;
}

/** Attachment file names referenced anywhere in the given texts. */
export function referencedAttachments(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(REF_RE)) out.add(m[1]);
  return [...out];
}

/** Attachment URLs in `text` replaced with their files' paths, without the note localizeAttachments adds. */
export function localizeUrls(text: string, dir: string): string {
  return text.includes("/api/attachments/") ? text.replace(URL_RE, (_, name) => join(dir, name)) : text;
}

/**
 * Prompts for Claude: swap attachment URLs for absolute file paths (Claude opens them with Read) and add a
 * short note saying so, inside the board's context block when there is one. Images alone keep the short note.
 */
export function localizeAttachments(prompt: string, dir: string): string {
  if (!prompt.includes("/api/attachments/")) return prompt;
  let files = false;
  const out = prompt.replace(URL_RE, (_, name: string) => {
    if (!isImageName(name)) files = true;
    return join(dir, name);
  });
  const note = files ? FILES_NOTE : IMAGES_NOTE;
  const close = out.lastIndexOf("</ckanban-context>");
  return close >= 0 ? `${out.slice(0, close)}\n${note}\n${out.slice(close)}` : `${out}\n\n${note}`;
}

export function deleteAttachments(dir: string, names: string[]): void {
  for (const n of names) if (isAttachmentName(n)) rmSync(join(dir, n), { force: true });
}

/** Copy attachments under new names (old name → new name), skipping ones that are gone. */
export function copyAttachments(dir: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    if (!isAttachmentName(n) || !existsSync(join(dir, n))) continue;
    const copy = `${crypto.randomUUID().replace(/-/g, "")}.${n.split(".").pop()}`;
    copyFileSync(join(dir, n), join(dir, copy));
    out[n] = copy;
  }
  return out;
}
