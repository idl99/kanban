import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";
import { cleanFileName, fileHolder, isImageFile, refusal } from "./attachText";
import { insertBlock, mapIndex, pickRange, swapHolder, type Edit } from "./imageText";

let seq = 0;

/**
 * Paste, drop or pick (ImagePickButton) images and files into a markdown textarea: each one is uploaded and
 * inserted at the cursor, on its own line, as `![image](/api/attachments/…)` or, for other files,
 * `[<file name>](/api/attachments/…)`. Text paste is left alone. Files that can't be attached are refused with an error.
 */
export function useImagePaste(setValue: Dispatch<SetStateAction<string>>) {
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploads = useRef(0);
  const [uploading, setUploading] = useState(false);

  // Where the caret should go once the edited value is rendered (a controlled textarea loses it otherwise).
  // Picked images also move the caret of a box that isn't focused, so the next pick lands after them.
  const caret = useRef<{ el: HTMLTextAreaElement; value: string; start: number; end: number; picked?: boolean } | null>(null);
  useLayoutEffect(() => {
    const c = caret.current;
    caret.current = null;
    if (c && c.el.value === c.value && (c.picked || document.activeElement === c.el)) c.el.setSelectionRange(c.start, c.end);
  });
  // Boxes the user has been in: only their caret says where picked images should go.
  const touched = useRef(new WeakSet<HTMLTextAreaElement>());

  // Apply an edit to the latest state. The textarea's selection refers to what it shows, which can lag
  // behind state by a not-yet-rendered update, so it is mapped onto the state first.
  const edit = (el: HTMLTextAreaElement, f: (v: string, start: number, end: number) => Edit, picked = false) =>
    setValue((v) => {
      const shown = el.value;
      const r = f(v, mapIndex(shown, v, el.selectionStart ?? shown.length), mapIndex(shown, v, el.selectionEnd ?? shown.length));
      caret.current = { el, ...r, picked };
      return r.value;
    });

  // Uploads in flight by placeholder, so a chip's ✕ can cancel one.
  const inFlight = useRef(new Map<string, AbortController>());

  const insert = (el: HTMLTextAreaElement, all: File[], picked = false) => {
    const refused = all.map(refusal).filter((r): r is string => !!r);
    setError(refused.length ? `Not added: ${refused.join("; ")}` : null);
    const files = all.filter((f) => !refusal(f));
    if (!files.length) return;
    const holders = files.map((f) => (isImageFile(f) ? `![uploading image ${++seq}…]()` : fileHolder(f.name, ++seq)));
    const inBox = !picked || touched.current.has(el);
    edit(el, (v, start, end) => insertBlock(v, ...pickRange(v.length, start, end, inBox), holders), picked);
    if (picked) touched.current.add(el);
    files.forEach(async (file, i) => {
      const abort = new AbortController();
      inFlight.current.set(holders[i], abort);
      uploads.current++;
      setUploading(true);
      try {
        const { url } = await api.uploadAttachment(file, abort.signal);
        const md = isImageFile(file) ? `![image](${url})` : `[${cleanFileName(file.name)}](${url})`;
        edit(el, (v, start, end) => swapHolder(v, holders[i], md, start, end));
      } catch (e: any) {
        edit(el, (v, start, end) => swapHolder(v, holders[i], "", start, end));
        if (!abort.signal.aborted) setError(`Not added: ${file.name || "image"}: ${e.message}`);
      } finally {
        inFlight.current.delete(holders[i]);
        if (--uploads.current === 0) setUploading(false);
      }
    });
  };

  /** A chip's ✕: cancel the upload behind a placeholder, or drop an uploaded file's line from the text. */
  const remove = (token: string) => {
    const abort = inFlight.current.get(token);
    if (abort) return abort.abort();
    setValue((v) => swapHolder(v, token, "", 0, 0).value);
  };

  const handlers = {
    onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => { touched.current.add(e.currentTarget); },
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      insert(e.currentTarget, files);
    },
    onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => {
      if (!Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => {
      setDragOver(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      insert(e.currentTarget, Array.from(e.dataTransfer.files));
    },
  };

  /** Add images and files chosen in a file picker. */
  const pick = (el: HTMLTextAreaElement, files: File[]) => insert(el, files, true);

  return { handlers, pick, remove, error, uploading, dragOver, clearError: () => setError(null) };
}
