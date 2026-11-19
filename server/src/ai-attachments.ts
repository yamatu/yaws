import { z } from "zod";

export const MAX_CHAT_IMAGES = 4;
/** Base64 characters per image (~2.2 MB decoded); the browser downscales first. */
export const MAX_IMAGE_BASE64 = 3_000_000;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
export type ChatImage = { mime: ImageMime; data: string };

/** Sent to the model when a message is only pictures. */
export const IMAGE_ONLY_PROMPT = "请查看我附上的图片。";

const SIGNATURES: Record<ImageMime, (head: Buffer) => boolean> = {
  "image/png": (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) =>
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** The bytes must really be the declared format; the type is served back as-is. */
export function imageMatches(image: { mime: string; data: string }): boolean {
  const check = SIGNATURES[image.mime as ImageMime];
  return !!check && check(Buffer.from(image.data.slice(0, 32), "base64"));
}

export const ChatImageSchema = z
  .object({
    mime: z.enum(IMAGE_MIMES),
    data: z
      .string()
      .min(16)
      .max(MAX_IMAGE_BASE64)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .refine(imageMatches, { message: "image_invalid" });

export const ChatImages = z.array(ChatImageSchema).max(MAX_CHAT_IMAGES).default([]);

const dataUrl = (image: ChatImage) => `data:${image.mime};base64,${image.data}`;

/** A user message in the Chat Completions shape (also read by `toContext`). */
export function chatContent(text: string, images: ChatImage[]) {
  const body = text || (images.length ? IMAGE_ONLY_PROMPT : "");
  if (!images.length) return body;
  return [
    { type: "text", text: body },
    ...images.map((image) => ({ type: "image_url", image_url: { url: dataUrl(image) } })),
  ];
}

/** A user message in the Responses API shape. */
export function responsesContent(text: string, images: ChatImage[]) {
  const body = text || (images.length ? IMAGE_ONLY_PROMPT : "");
  if (!images.length) return body;
  return [
    { type: "input_text", text: body },
    ...images.map((image) => ({ type: "input_image", image_url: dataUrl(image) })),
  ];
}

export type StoredSteer = {
  text: string;
  /** Ids of the pictures that came with it, see `GET /conversations/:cid/images/:id`. */
  images: string[];
  /** How many steps had run when it reached the model. */
  step: number;
  at: number;
};

/**
 * How an earlier turn is replayed to the model: pictures are not sent again
 * (they would be paid for on every later question), but the model is told they
 * were there, and messages added while the turn ran follow the question.
 */
export function historyPrompt(prompt: string, images: number, steers: StoredSteer[]): string {
  const parts = [prompt || (images ? IMAGE_ONLY_PROMPT : "")];
  if (images) parts.push(`（当时附带了 ${images} 张图片，历史中已省略）`);
  for (const steer of steers) {
    parts.push(`[运行中补充] ${steer.text || IMAGE_ONLY_PROMPT}`);
    if (steer.images.length) parts.push(`（附带 ${steer.images.length} 张图片，历史中已省略）`);
  }
  return parts.join("\n\n");
}

export function parseIds(text: string): string[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
