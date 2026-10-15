import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  AttachmentError, attachmentFile, attachmentType, cleanFileName, FILES_NOTE, IMAGES_NOTE, isAttachmentName, localizeAttachments,
  MAX_ATTACHMENT_BYTES, opensInline, referencedAttachments, saveAttachment, uploadExt,
} from "../src/server/attachments";
import { tempDir } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NAME = "0123456789abcdef0123456789abcdef.png";

test("saveAttachment stores a random name with the right extension", () => {
  const dir = tempDir("ck-att-");
  const name = saveAttachment(dir, "png", PNG);
  expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
  expect(attachmentFile(dir, name)).toBe(join(dir, name));
});

test("saveAttachment rejects wrong types, bad bytes and oversize files", () => {
  const dir = tempDir("ck-att-");
  const status = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as AttachmentError).status;
    }
    return 0;
  };
  expect(status(() => saveAttachment(dir, null, PNG))).toBe(415);
  expect(status(() => saveAttachment(dir, "exe", PNG))).toBe(415);
  expect(status(() => saveAttachment(dir, "jpg", PNG))).toBe(400);
  expect(status(() => saveAttachment(dir, "png", new Uint8Array()))).toBe(400);
  expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PNG);
  expect(status(() => saveAttachment(dir, "png", big))).toBe(413);
});

test("attachmentFile only accepts generated names", () => {
  const dir = tempDir("ck-att-");
  expect(attachmentFile(dir, "../ticket.md")).toBeNull();
  expect(attachmentFile(dir, "x.png")).toBeNull();
  expect(attachmentFile(dir, NAME)).toBeNull(); // valid name, but no file
});

test("localizeAttachments swaps URLs for file paths and adds the note inside the context", () => {
  const dir = "/data/attachments";
  const prompt = `look ![image](/api/attachments/${NAME})\n\n<ckanban-context note="">\nrules\n</ckanban-context>`;
  const out = localizeAttachments(prompt, dir);
  expect(out).toContain(`![image](${dir}/${NAME})`);
  expect(out).not.toContain("/api/attachments/");
  expect(out.indexOf(IMAGES_NOTE)).toBeLessThan(out.indexOf("</ckanban-context>"));
  expect(out).not.toContain(FILES_NOTE);
  expect(localizeAttachments("no images", dir)).toBe("no images");
});

test("localizeAttachments turns file links into paths and explains how to open them", () => {
  const dir = "/data/attachments";
  const pdf = NAME.replace(".png", ".pdf");
  const docx = NAME.replace(".png", ".docx");
  const out = localizeAttachments(`read [Q3 contract.pdf](/api/attachments/${pdf}) and [notes.docx](/api/attachments/${docx}).`, dir);
  expect(out).toContain(`[Q3 contract.pdf](${dir}/${pdf})`);
  expect(out).toContain(`[notes.docx](${dir}/${docx}).`);
  expect(out).toContain(FILES_NOTE);
  expect(FILES_NOTE).toContain("Word, Excel or PowerPoint");
  expect(out).not.toContain(IMAGES_NOTE);
});

test("saveAttachment checks file contents, not just the extension", () => {
  const dir = tempDir("ck-att-");
  const bytes = (s: string) => new TextEncoder().encode(s);
  const status = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as AttachmentError).status;
    }
    return 0;
  };
  expect(saveAttachment(dir, "pdf", bytes("%PDF-1.7\n..."))).toMatch(/^[0-9a-f]{32}\.pdf$/);
  expect(status(() => saveAttachment(dir, "pdf", bytes("MZ not a pdf")))).toBe(400);
  for (const ext of ["docx", "xlsx", "pptx"]) {
    expect(saveAttachment(dir, ext, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toEndWith(`.${ext}`);
    expect(status(() => saveAttachment(dir, ext, bytes("plain text")))).toBe(400);
  }
  expect(saveAttachment(dir, "md", bytes("# Notes\nhello"))).toEndWith(".md");
  expect(saveAttachment(dir, "csv", bytes("a,b\n1,2"))).toEndWith(".csv");
  expect(status(() => saveAttachment(dir, "txt", new Uint8Array([0x68, 0, 0x69])))).toBe(400); // binary
});

test("uploadExt picks the type from the file name, else from an image type", () => {
  expect(uploadExt("application/octet-stream", "Report.PDF")).toBe("pdf");
  expect(uploadExt("application/octet-stream", "notes.md")).toBe("md");
  expect(uploadExt("image/jpeg", "photo.jpeg")).toBe("jpg");
  expect(uploadExt("image/png", null)).toBe("png");
  expect(uploadExt("image/png", "image")).toBe("png");
  expect(uploadExt("application/octet-stream", "setup.exe")).toBeNull();
  expect(uploadExt("application/octet-stream", "archive.zip")).toBeNull();
  expect(uploadExt("application/octet-stream", null)).toBeNull();
});

test("attachment names accept the new extensions and nothing else", () => {
  const n = (ext: string) => `0123456789abcdef0123456789abcdef.${ext}`;
  for (const ext of ["png", "jpg", "pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json", "ts", "tsx", "py", "html", "yaml", "sh"]) {
    expect(isAttachmentName(n(ext))).toBe(true);
  }
  for (const bad of [n("exe"), n("zip"), n("svg"), `../${n("pdf")}`, "x.pdf", `${n("pdf")}.exe`]) expect(isAttachmentName(bad)).toBe(false);
  expect(referencedAttachments(`[a](/api/attachments/${n("tsx")}) /home/x/attachments/${n("ts")}`)).toEqual([n("tsx"), n("ts")]);
});

test("attachments are served safely: text never as HTML, Office files download", () => {
  const n = (ext: string) => `0123456789abcdef0123456789abcdef.${ext}`;
  expect(attachmentType(n("html"))).toBe("text/plain; charset=utf-8");
  expect(attachmentType(n("pdf"))).toBe("application/pdf");
  expect(attachmentType(n("png"))).toBe("image/png");
  expect(opensInline(n("pdf"))).toBe(true);
  expect(opensInline(n("md"))).toBe(true);
  expect(opensInline(n("docx"))).toBe(false);
});

test("cleanFileName keeps the name safe inside a markdown link", () => {
  expect(cleanFileName("Q3 contract (final).pdf")).toBe("Q3 contract (final).pdf");
  expect(cleanFileName("a[b]\nc.pdf")).toBe("a(b) c.pdf");
  expect(cleanFileName("<x>`y`\\z.md")).toBe("xyz.md");
  expect(cleanFileName("   ")).toBe("file");
  expect(cleanFileName(`${"a".repeat(200)}.pdf`).length).toBe(120);
});

test("referencedAttachments finds URLs and local paths", () => {
  expect(referencedAttachments(`![a](/api/attachments/${NAME})`, `/home/x/.claude-kanban/attachments/${NAME.replace(".png", ".jpg")}`, "none"))
    .toEqual([NAME, NAME.replace(".png", ".jpg")]);
});
