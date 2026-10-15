import { useRef, type RefObject } from "react";
import { ACCEPT } from "./attachText";
import { PaperclipIcon } from "./icons";
import type { useImagePaste } from "./imagePaste";

/**
 * "Attach" button next to a markdown box: opens the system picker (on phones: photo library, camera or
 * files) and adds the chosen images and files like a paste. The way in where paste and drop don't work.
 */
export function ImagePickButton({ images, target, disabled, className = "" }: {
  images: ReturnType<typeof useImagePaste>;
  target: RefObject<HTMLTextAreaElement>;
  disabled?: boolean;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={`btn small image-pick ${className}`} disabled={disabled}
        title="Attach images or files: PDF, Word, Excel, PowerPoint, text or code (or paste / drop them into the text)"
        onClick={() => input.current?.click()}>
        <PaperclipIcon /> <span className="image-pick-label">Attach</span>
      </button>
      {/* No `capture`: the phone then offers library, camera and files. */}
      <input ref={input} type="file" accept={ACCEPT} multiple hidden tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = ""; // picking the same file again still fires change
          if (files.length && target.current) images.pick(target.current, files);
        }} />
    </>
  );
}
