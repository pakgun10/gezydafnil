import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { one, run } from "./db";

// Pola login disalin dari GezyRaport (auth.ts) — username + kata sandi,
// hash argon2id via Bun.password, sesi di tabel `sessions`, cookie
// HttpOnly "sesi" 7 hari. Satu titik otorisasi (getSessionUser) supaya
// SSO mudah ditambahkan nanti sebagai proyek terpisah (v1: tanpa SSO).
// Yang berubah dari versi SQLite hanya penyimpanannya: MariaDB (async).

export interface SessionUser {
  id: number;
  username: string;
  role: string;
}

const SESSION_DAYS = 7;

export async function createSession(userId: number): Promise<string> {
  const id = crypto.randomUUID();
  const expires_at = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  await run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)", [
    id,
    userId,
    expires_at,
  ]);
  return id;
}

export async function destroySession(id: string): Promise<void> {
  await run("DELETE FROM sessions WHERE id = ?", [id]);
}

export async function getSessionUser(c: Context): Promise<SessionUser | null> {
  const sid = getCookie(c, "sesi");
  if (!sid) return null;
  const s = await one(
    `SELECT s.user_id, s.expires_at, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    [sid]
  );
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    await destroySession(sid);
    return null;
  }
  return { id: s.user_id, username: s.username, role: s.role };
}

export function setSessionCookie(c: Context, sid: string): void {
  setCookie(c, "sesi", sid, {
    httpOnly: true,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
    sameSite: "Lax",
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, "sesi", { path: "/" });
}

/** Middleware: user harus login dan role-nya termasuk yang diizinkan. */
export function requireRole(...roles: string[]) {
  return async (c: Context, next: Next) => {
    const u = await getSessionUser(c);
    if (!u) return c.json({ error: "Belum login" }, 401);
    if (!roles.includes(u.role)) return c.json({ error: "Akses ditolak" }, 403);
    c.set("user", u);
    await next();
  };
}
