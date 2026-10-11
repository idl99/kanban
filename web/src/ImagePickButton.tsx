import { useRef, type RefObject } from "react";
import { ImageIcon } from "./icons";
import type { useImagePaste } from "./imagePaste";

/**
 * "Image" button next to a markdown box: opens the system picker (on phones: photo library, camera or
 * files) and adds the chosen images like a paste. The way in where paste and drop don't work.
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
        title="Add images (or paste / drop them into the text)" onClick={() => input.current?.click()}>
        <ImageIcon /> Image
      </button>
      {/* No `capture`: the phone then offers library, camera and files. */}
      <input ref={input} type="file" accept="image/*" multiple hidden tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = ""; // picking the same photo again still fires change
          if (files.length && target.current) images.pick(target.current, files);
        }} />
    </>
  );
}
