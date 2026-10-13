import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { ImagePickButton } from "./ImagePickButton";
import type { useImagePaste } from "./imagePaste";
import { useSlashCommands, useSlashPicker } from "./SlashPicker";
import { useSnippetPicker } from "./SnippetPicker";
import type { SlashCommand } from "./slashText";
import { usePhone } from "./usePhone";

/** What `/` offers in a description: skills and custom commands (built-ins mean nothing outside the chat). */
export function useDescriptionCommands(slug: string, ticketId?: string): SlashCommand[] | null {
  const all = useSlashCommands(slug, ticketId);
  return useMemo(() => all?.filter((c) => c.kind !== "builtin") ?? null, [all]);
}

/**
 * The markdown description box of new tickets, the ticket panel and schedules: `@` inserts a snippet,
 * `/` picks a skill (just text: Claude reads it like the rest), images paste, drop or pick in. One look everywhere.
 */
export function DescriptionEditor({ slug, ticketId, value, setValue, images, inputRef, rows = 8, placeholder, autoFocus, fill, onKeyDown }: {
  slug: string;
  /** The ticket's own skills (its worktree); without one, the board folder's. */
  ticketId?: string;
  value: string;
  setValue: (v: string) => void;
  images?: ReturnType<typeof useImagePaste>;
  inputRef: RefObject<HTMLTextAreaElement>;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
  /** Grow to fill the parent (ticket panel) instead of a fixed number of rows. */
  fill?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const snippets = useSnippetPicker({ slug, ref: inputRef, setValue });
  const commands = useDescriptionCommands(slug, ticketId);
  const slash = useSlashPicker({ commands, ref: inputRef, setValue, inline: true });
  const phone = usePhone();
  // Phone buttons type `@` / `/` at the caret; after that render the caret moves past it and the picker opens.
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (pending.current === null || !el) return;
    el.setSelectionRange(pending.current, pending.current);
    pending.current = null;
    snippets.handlers.onSelect();
    slash.handlers.onSelect();
  });

  const typeTrigger = (ch: "@" | "/") => {
    const el = inputRef.current;
    if (!el) return;
    el.focus(); // inside the tap, so phones open the keyboard
    const start = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, start);
    const lead = before && !/[\s([{"'`]$/.test(before) ? " " : "";
    pending.current = start + lead.length + 1;
    setValue(before + lead + ch + el.value.slice(el.selectionEnd ?? start));
  };
  // Keep the textarea focused (and the caret where it was) while a button is pressed.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
    <div className={`desc-editor${fill ? " fill" : ""}${images?.dragOver ? " drop-target" : ""}`}>
      <textarea ref={inputRef} rows={rows} value={value} onChange={(e) => setValue(e.target.value)} autoFocus={autoFocus}
        placeholder={placeholder ?? "Context, acceptance criteria, links… (markdown)"} {...images?.handlers}
        onSelect={() => { snippets.handlers.onSelect(); slash.handlers.onSelect(); }}
        onBlur={() => { snippets.handlers.onBlur(); slash.handlers.onBlur(); }}
        onKeyDown={(e) => {
          if (snippets.onKeyDown(e) || slash.onKeyDown(e)) return;
          onKeyDown?.(e);
        }} />
      {phone ? (
        // Phones: tap buttons instead of keyboard hints (paste and `@` / `/` are awkward on a phone keyboard).
        <div className="desc-editor-foot phone">
          {images && <ImagePickButton images={images} target={inputRef} className="desc-editor-tool" />}
          <button type="button" className="desc-editor-tool" onMouseDown={keepFocus} onClick={() => typeTrigger("@")}><kbd>@</kbd> Snippet</button>
          {!!commands?.length && (
            <button type="button" className="desc-editor-tool" onMouseDown={keepFocus} onClick={() => typeTrigger("/")}><kbd>/</kbd> Skill</button>
          )}
          {images?.uploading && <span className="desc-editor-status">Uploading image…</span>}
        </div>
      ) : (
        <div className="desc-editor-foot">
          <span><kbd>@</kbd> snippet</span>
          <span><kbd>/</kbd> skill</span>
          {images && <span>{images.uploading ? "Uploading image…" : "Paste images"}</span>}
          {images && <ImagePickButton images={images} target={inputRef} className="desc-editor-pick" />}
        </div>
      )}
      {snippets.popup}
      {slash.popup}
    </div>
    {images?.error && <span className="form-error">{images.error}</span>}
    </>
  );
}
