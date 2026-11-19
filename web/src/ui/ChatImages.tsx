import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ImageOff, X } from "lucide-react";
import { getToken } from "./auth";

/** A picture in the transcript: a local data URL, or a stored image id. */
export type ImageRef = { src?: string; id?: string };

// Stored pictures need the auth header, so they are fetched once and shown
// through object URLs that live as long as the page.
const cache = new Map<string, Promise<string>>();

function serverImage(conversationId: string, id: string): Promise<string> {
  const key = `${conversationId}/${id}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const token = getToken();
      const response = await fetch(`/api/ai/conversations/${conversationId}/images/${id}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return URL.createObjectURL(await response.blob());
    })();
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

function useImageSrc(image: ImageRef, conversationId: string) {
  const [src, setSrc] = useState(image.src ?? "");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (image.src) {
      setSrc(image.src);
      return;
    }
    if (!image.id || !conversationId) return;
    let live = true;
    serverImage(conversationId, image.id).then(
      (url) => live && setSrc(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [image.src, image.id, conversationId]);
  return { src, failed };
}

function Thumb({
  image,
  conversationId,
  onOpen,
}: {
  image: ImageRef;
  conversationId: string;
  onOpen: (src: string) => void;
}) {
  const { src, failed } = useImageSrc(image, conversationId);
  return (
    <button
      type="button"
      className="ai-image-thumb"
      title="查看大图"
      aria-label="查看图片"
      disabled={!src}
      onClick={() => src && onOpen(src)}
    >
      {src ? <img src={src} alt="" loading="lazy" /> : failed ? <ImageOff size={16} /> : null}
    </button>
  );
}

export function ImageStrip({
  images,
  conversationId,
  onOpen,
}: {
  images: ImageRef[];
  conversationId: string;
  onOpen: (src: string) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="ai-image-strip">
      {images.map((image, index) => (
        <Thumb
          key={image.id ?? `${index}-${image.src?.length}`}
          image={image}
          conversationId={conversationId}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/** Full-screen picture; tap anywhere or press Esc to close. */
export function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="ai-image-viewer" role="dialog" aria-label="图片" onClick={onClose}>
      <img src={src} alt="" onClick={(event) => event.stopPropagation()} />
      <button type="button" className="icon-btn" aria-label="关闭图片" onClick={onClose}>
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}
