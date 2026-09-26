import type { Request } from "express";

// Reads one cookie from the Cookie header; enough for our single cookie, without a dependency.
export const readCookie = (req: Request, name: string): string | undefined => {
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return value ? decodeURIComponent(value) : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};
