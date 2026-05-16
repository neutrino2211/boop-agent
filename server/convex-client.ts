import { ConvexHttpClient } from "convex/browser";

const url = process.env.CONVEX_URL?.trim() || process.env.VITE_CONVEX_URL?.trim();
if (!url) {
  throw new Error(
    "Convex URL is not set. Expected CONVEX_URL (preferred) or VITE_CONVEX_URL.",
  );
}

export const convex = new ConvexHttpClient(url);
