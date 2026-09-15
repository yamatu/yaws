import { useEffect } from "react";

/** The browser tab says where you are, not just the product name. */
const SUFFIX = "YAWS";
const MAX = 60;

/** `Fixture 1` → `Fixture 1 · YAWS`, empty → `YAWS`. */
export function formatTitle(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return SUFFIX;
  const clipped =
    clean.length > MAX ? `${clean.slice(0, MAX - 1).trimEnd()}…` : clean;
  return `${clipped} · ${SUFFIX}`;
}

/** Keeps the document title in sync with the page that is on screen. */
export function useDocumentTitle(name: string | null | undefined) {
  const title = formatTitle(name);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
