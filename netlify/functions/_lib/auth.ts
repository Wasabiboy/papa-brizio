import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const COOKIE = "pb_admin";
const MAX_AGE = 60 * 60 * 24 * 7;

function secret() {
  return env("ADMIN_SECRET") || env("ADMIN_PASSWORD");
}

function sign(payload: string) {
  return createHmac("sha256", secret() || "missing").update(payload).digest("base64url");
}

export function passwordOk(input: string) {
  const expected = env("ADMIN_PASSWORD");
  if (!expected || !input) return false;
  const left = createHmac("sha256", "pb-admin").update(input).digest();
  const right = createHmac("sha256", "pb-admin").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function makeToken() {
  const payload = String(Date.now() + MAX_AGE * 1000);
  return `${payload}.${sign(payload)}`;
}

export function tokenOk(token: string) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig || !secret()) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

export function readCookie(req: Request) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === COOKIE) {
      return decodeURIComponent(part.slice(i + 1));
    }
  }
  return "";
}

export function isAuthed(req: Request) {
  return tokenOk(readCookie(req));
}

export function cookieHeader(req: Request, token?: string) {
  const url = new URL(req.url);
  const proto = (req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")).split(",")[0].trim();
  const secure = proto === "https" ? "; Secure" : "";
  if (!token) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}
