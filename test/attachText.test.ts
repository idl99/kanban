import { expect, test } from "bun:test";
import { cleanFileName as serverClean, FILE_EXTS as SERVER_EXTS, MAX_ATTACHMENT_BYTES as SERVER_MAX } from "../src/server/attachments";
import {
  ACCEPT, ATTACHMENT_SRC, cleanFileName, draftFiles, FILE_EXTS, fileHolder, fileHref, fileKind, formatSize, MAX_ATTACHMENT_BYTES, refusal,
} from "../web/src/attachText";

const PDF = "0123456789abcdef0123456789abcdef.pdf";

test("the UI allows the same files as the server", () => {
  expect(FILE_EXTS).toEqual(SERVER_EXTS);
  expect(MAX_ATTACHMENT_BYTES).toBe(SERVER_MAX);
  for (const n of ["a[b]\nc.pdf", "<x>`y`\\z.md", "  ", `${"a".repeat(200)}.pdf`, "Q3 (final).docx"]) expect(cleanFileName(n)).toBe(serverClean(n));
  expect(ACCEPT).toContain(".pdf");
  expect(ACCEPT).toContain("image/png");
});

test("refusal explains files that can't be added", () => {
  expect(refusal({ name: "big-video.mov", type: "video/quicktime", size: 30e6 })).toContain("can't be added");
  expect(refusal({ name: "big.pdf", type: "application/pdf", size: 30 * 1024 * 1024 })).toBe("big.pdf: too large (max 25 MB)");
  expect(refusal({ name: "notes.md", type: "", size: 10 })).toBeNull();
  expect(refusal({ name: "image.png", type: "image/png", size: 10 })).toBeNull();
  expect(refusal({ name: "setup.exe", type: "application/x-msdownload", size: 10 })).not.toBeNull();
});

test("draftFiles lists uploaded and uploading files but not images", () => {
  const holder = fileHolder("meeting notes.docx", 3);
  const text = `see\n![image](/api/attachments/${PDF.replace(".pdf", ".png")})\n[Q3 contract.pdf](/api/attachments/${PDF})\n${holder}`;
  expect(draftFiles(text)).toEqual([
    { state: "done", name: "Q3 contract.pdf", stored: PDF, token: `[Q3 contract.pdf](/api/attachments/${PDF})` },
    { state: "uploading", name: "meeting notes.docx", token: holder },
  ]);
});

test("file cards: kinds, sizes and links", () => {
  expect(fileKind("a.pdf")).toEqual({ tile: "PDF", type: "PDF", cls: "pdf" });
  expect(fileKind("a.docx").type).toBe("Word");
  expect(fileKind("a.xlsx").cls).toBe("xls");
  expect(fileKind("a.pptx").type).toBe("PowerPoint");
  expect(fileKind("a.py")).toEqual({ tile: "PY", type: "Code", cls: "txt" });
  expect(formatSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
  expect(formatSize(86 * 1024)).toBe("86 KB");
  expect(fileHref(PDF, "Q3 contract.pdf", true)).toBe(`/api/attachments/${PDF}?download=1&name=Q3%20contract.pdf`);
  expect(`/api/attachments/${PDF}`.match(ATTACHMENT_SRC)?.[1]).toBe(PDF);
  expect(`/Users/me/.claude-kanban/attachments/${PDF}`.match(ATTACHMENT_SRC)?.[1]).toBe(PDF);
  expect("/api/attachments/../x.pdf".match(ATTACHMENT_SRC)).toBeNull();
});
