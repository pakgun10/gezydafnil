import { one, run } from "./db";

/** Catat satu baris log aktivitas. Tidak pernah menggagalkan aksi utama. */
export async function catatLog(
  c: any,
  aksi: string,
  detail?: string,
  who?: { id?: number | null; username?: string | null; role?: string | null }
) {
  try {
    const u = who ?? (c.get("user") as any);
    const fwd = c.req.header("x-forwarded-for");
    const ip =
      (fwd ? fwd.split(",")[0].trim() : null) ||
      c.req.header("x-real-ip") ||
      null;
    await run(
      `INSERT INTO activity_log (waktu, user_id, username, peran, aksi, detail, ip)
       VALUES (NOW(), ?, ?, ?, ?, ?, ?)`,
      [
        u?.id ?? null,
        u?.username ?? null,
        u?.role ?? u?.peran ?? null,
        aksi,
        detail ?? null,
        ip,
      ]
    );
  } catch {
    /* abaikan */
  }
}

/** Parser CSV sederhana (mendukung field ber-quote). */
export function parseCSV(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  text = text.replace(/^sep=.?\r?\n/i, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (ch === "\r") {
        /* abaikan */
      } else field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Bungkus baris-baris CSV untuk diunduh (BOM + sep=, agar Excel Windows langsung memecah kolom). */
export function bungkusCSV(lines: string[]): string {
  return "\uFEFFsep=,\n" + lines.join("\n");
}

/** Escape satu field untuk output CSV. */
export function csvField(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Tulis NISN ke CSV agar aman dibuka di Excel (nol di depan tidak hilang). */
export function nisExcel(nis: unknown): string {
  return `="${String(nis ?? "")}"`;
}

/** Kupas pembungkus formula Excel pada NISN dari file CSV. */
export function normalisasiNISN(v: unknown): string {
  let s = String(v ?? "").trim();
  const m = s.match(/^="([\s\S]*)"$/);
  if (m) s = m[1].trim();
  return s;
}

/** Username dari nama guru, pola GezyRaport: tanpa spasi, huruf kecil. */
export function usernameDariNama(nama: string): string {
  return nama
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}
