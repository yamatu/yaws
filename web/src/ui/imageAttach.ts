/** Same limits the server enforces. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BASE64 = 3_000_000;
/** Longest edge sent to the model; enough to read a screenshot of a log. */
export const MAX_EDGE = 1600;
const KEEP_BYTES = 1_200_000;
const KEEP_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export type Attachment = { id: string; mime: string; data: string };

export const attachmentUrl = (image: { mime: string; data: string }) =>
  `data:${image.mime};base64,${image.data}`;

/** Scales `w×h` down so the longest edge is at most `max`. */
export function fitSize(w: number, h: number, max = MAX_EDGE) {
  const scale = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Small files in a format the server takes are sent untouched (sharp screenshots). */
export function keepOriginal(type: string, bytes: number, w: number, h: number) {
  return KEEP_TYPES.includes(type) && bytes <= KEEP_BYTES && Math.max(w, h) <= MAX_EDGE;
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image_unreadable"));
    };
    img.src = url;
  });
}

/** Reads a picked, pasted or dropped picture and makes it fit the upload limit. */
export async function prepareImage(file: File, id: string): Promise<Attachment> {
  if (!file.type.startsWith("image/")) throw new Error("image_type");
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (keepOriginal(file.type, file.size, w, h))
    return { id, mime: file.type, data: toBase64(await file.arrayBuffer()) };
  let edge = MAX_EDGE;
  for (let attempt = 0; attempt < 4; attempt++) {
    const size = fitSize(w, h, edge);
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("image_unreadable");
    // JPEG has no alpha: give transparent screenshots a white page, not black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.drawImage(img, 0, 0, size.w, size.h);
    const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
    if (data && data.length <= MAX_IMAGE_BASE64) return { id, mime: "image/jpeg", data };
    edge = Math.round(edge * 0.7);
  }
  throw new Error("image_too_large");
}

/** Pictures from a paste or drop, ignoring everything that is not an image. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] as File | DataTransferItem;
    const file = "getAsFile" in item ? (item.kind === "file" ? item.getAsFile() : null) : item;
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}
