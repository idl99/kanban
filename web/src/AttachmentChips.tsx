import { useEffect, useState } from "react";
import { api } from "./api";
import { draftFiles, fileKind, formatSize, type DraftFile } from "./attachText";
import type { useImagePaste } from "./imagePaste";

/** "PDF · 2.4 MB" once the size is known, else just the type. */
function useSizeLine(stored: string | null, type: string): string {
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (!stored) return;
    let live = true;
    void api.attachmentSize(stored).then((n) => { if (live) setSize(n); });
    return () => { live = false; };
  }, [stored]);
  return size === null ? type : `${type} · ${formatSize(size)}`;
}

function Chip({ file, onRemove }: { file: DraftFile; onRemove: () => void }) {
  const kind = fileKind(file.name);
  const sizeLine = useSizeLine(file.state === "done" ? file.stored : null, kind.type);
  return (
    <div className={`file-card${file.state === "uploading" ? " uploading" : ""}`}>
      <span className={`file-tile ${kind.cls}`}>{kind.tile}</span>
      <span className="file-meta">
        <span className="file-name" title={file.name}>{file.name}</span>
        {file.state === "uploading" ? <span className="file-bar"><i /></span> : <span className="file-size">{sizeLine}</span>}
      </span>
      <button type="button" className="file-btn" title={file.state === "uploading" ? "Cancel upload" : "Remove"}
        aria-label={file.state === "uploading" ? `Cancel uploading ${file.name}` : `Remove ${file.name}`}
        onMouseDown={(e) => e.preventDefault()} onClick={onRemove}>✕</button>
    </div>
  );
}

/** One chip per attached file (not images) under a message box; ✕ removes its line from the text or cancels the upload. */
export function AttachmentChips({ text, images }: { text: string; images: ReturnType<typeof useImagePaste> }) {
  const files = draftFiles(text);
  if (!files.length) return null;
  return (
    <div className="file-cards draft-files">
      {files.map((f, i) => <Chip key={`${f.token}-${i}`} file={f} onRemove={() => images.remove(f.token)} />)}
    </div>
  );
}
