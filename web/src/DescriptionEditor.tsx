import { useMemo, type KeyboardEvent, type RefObject } from "react";
import { ImagePickButton } from "./ImagePickButton";
import type { useImagePaste } from "./imagePaste";
import { useSlashCommands, useSlashPicker } from "./SlashPicker";
import { useSnippetPicker } from "./SnippetPicker";
import type { SlashCommand } from "./slashText";

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
      <div className="desc-editor-foot">
        <span><kbd>@</kbd> snippet</span>
        <span><kbd>/</kbd> skill</span>
        {images && <span>{images.uploading ? "Uploading image…" : "Paste images"}</span>}
        {images && <ImagePickButton images={images} target={inputRef} className="desc-editor-pick" />}
      </div>
      {snippets.popup}
      {slash.popup}
    </div>
    {images?.error && <span className="form-error">{images.error}</span>}
    </>
  );
}
