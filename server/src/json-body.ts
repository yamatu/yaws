import express, { type RequestHandler } from "express";

/** Questions to the assistant may carry pictures; they get a larger body limit. */
const IMAGE_ROUTES =
  /^\/api\/ai\/(machines\/\d+\/chat|conversations\/[^/]+\/runs\/[^/]+\/steer)$/;

export function jsonBody(): RequestHandler {
  const small = express.json({ limit: "1mb" });
  const images = express.json({ limit: "16mb" });
  return (req, res, next) => (IMAGE_ROUTES.test(req.path) ? images : small)(req, res, next);
}
