import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie } from "hono/cookie";
import { one, all, run, getConnection } from "./db";
import {
  createSession,
  destroySession,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  requireRole,
} from "./auth";
import { catatLog, parseCSV, bungkusCSV, csvField, nisExcel, normalisasiNISN, usernameDariNama } from "./util";
import {
  hitungLingkup,
  lengkapiPengaturan,
  type NilaiMentah,
  type PengaturanHitung,
} from "./lib/hitung";

const app = new Hono();
const SEMESTER_DEFAULT = "Ganjil";
const TAHUN_DEFAULT = "2026/2027";

async function bacaBody(c: any): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validNilai(v: number | null): boolean {
  return v === null || (v >= 0 && v <= 100);
}

/** Pengaturan mapel+semester; bila belum ada, pakai default. */
async function ambilPengaturan(mapelId: number, semester: string, tahun: string) {
  const row = await one(
    "SELECT * FROM pengaturan WHERE mapel_id = ? AND semester = ? AND tahun_ajaran = ?",
    [mapelId, semester, tahun]
  );
  const cfg: PengaturanHitung = {
    rendah: Number(row?.rendah ?? 70),
    tinggi: Number(row?.tinggi ?? 95),
    bobotS: Number(row?.bobot_s ?? 0.7),
    bobotAsts: Number(row?.bobot_asts ?? 0.15),
    bobotAsat: Number(row?.bobot_asat ?? 0.15),
    ambang: Number(row?.ambang ?? 85),
    batasTh: Number(row?.batas_th ?? 10),
    patokTh: Number(row?.patok_th ?? 70),
    bonusKarakter: Number(row?.bonus_karakter ?? 10),
    hariEfektif: Number((row as any)?.hari_efektif ?? 110),
    modeSkala: row?.mode_skala ?? "murni",
  } as any;
  return { row, cfg: lengkapiPengaturan(cfg), hariEfektif: Number((row as any)?.hari_efektif ?? 110) };
}

/**
 * Hitung nilai+deskripsi untuk satu lingkup.
 * kelasIds: kelas-kelas dalam SATU tingkat (dipaksa di pemanggil).
 * NA TIDAK disimpan permanen — selalu dihitung ulang dari nilai mentah,
 * jadi berubahnya lingkup langsung mengubah hasil.
 */
async function hitungUntukLingkup(
  mapelId: number,
  kelasIds: number[],
  semester: string,
  tahun: string
) {
  const { cfg, hariEfektif } = await ambilPengaturan(mapelId, semester, tahun);
  const kelasRows = kelasIds.length
    ? await all(`SELECT * FROM kelas WHERE id IN (${kelasIds.map(() => "?").join(",")}) ORDER BY nama`, kelasIds)
    : [];
  const tingkat = (kelasRows[0] as any)?.tingkat ?? "7";
  const tpRows = await all(
    `SELECT kode, teks FROM tp WHERE mapel_id = ? AND tingkat = ? AND semester = ? AND tahun_ajaran = ? ORDER BY urutan, kode`,
    [mapelId, tingkat, semester, tahun]
  ) as { kode: string; teks: string }[];
  const siswaRows =
    kelasIds.length === 0
      ? []
      : (await all(
          `SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id = s.kelas_id
           WHERE s.kelas_id IN (${kelasIds.map(() => "?").join(",")})
           ORDER BY k.nama, s.nama`,
          kelasIds
        )) as any[];
  const nilaiMap = new Map<number, any>();
  if (siswaRows.length) {
    const ids = siswaRows.map((s: any) => s.id);
    for (const n of (await all(
      `SELECT * FROM nilai WHERE mapel_id = ? AND semester = ? AND tahun_ajaran = ?
       AND siswa_id IN (${ids.map(() => "?").join(",")})`,
      [mapelId, semester, tahun, ...ids]
    )) as any[])
      nilaiMap.set(n.siswa_id, n);
  }
  const baris = siswaRows.map((s: any) => {
    const n = nilaiMap.get(s.id);
    const nilai: NilaiMentah = {
      s: [n?.s1 ?? null, n?.s2 ?? null, n?.s3 ?? null, n?.s4 ?? null, n?.s5 ?? null].map((v) =>
        v === null || v === undefined ? null : Number(v)
      ),
      asts: n?.asts ?? null,
      asat: n?.asat ?? null,
      th: n?.th ?? 0,
      karakter: n?.karakter ?? "",
      catatan: n?.catatan ?? "",
    };
    return { siswa: s, nilai, mentah: nilai };
  });
  const { batas, hasil } = hitungLingkup(
    baris.map((b: any) => ({ nilai: b.mentah })),
    tpRows,
    cfg
  );
  const rows = baris.map((b: any, i: number) => ({
    siswa: b.siswa,
    nilai: b.nilai,
    hasil: hasil[i],
  }));
  const terisi = rows.filter((r: any) => r.hasil.nr !== null).length;
  return {
    mapel_id: mapelId,
    semester,
    tahun_ajaran: tahun,
    kelas: kelasRows,
    tingkat,
    tp: tpRows,
    pengaturan: cfg,
    hari_efektif: hariEfektif,
    batas,
    terisi,
    total: rows.length,
    rows,
  };
}

function parseLingkup(c: any) {
  const mapelId = Number(c.req.query("mapel_id") || 0);
  const semester = c.req.query("semester") || SEMESTER_DEFAULT;
  const tahun = c.req.query("tahun_ajaran") || TAHUN_DEFAULT;
  const kelasIds = (c.req.query("kelas_ids") || c.req.query("kelas_id") || "")
    .split(",")
    .map((x: string) => Number(x.trim()))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  return { mapelId, semester, tahun, kelasIds };
}

/**
 * Batas guru: guru hanya boleh mengakses mapel+kelas yang diampunya
 * (tabel guru_mapel). Admin bebas. Mengembalikan null bila boleh,
 * atau pesan penolakan bila tidak.
 */
async function cekAksesGuru(
  user: any,
  mapelId: number,
  kelasIds: number[]
): Promise<string | null> {
  if (user.role === "admin") return null;
  const g = await one("SELECT id FROM guru WHERE user_id = ?", [user.id]);
  if (!g) return "Akun guru ini belum punya profil guru — minta admin melengkapinya.";
  if (!kelasIds.length) return null;
  for (const kid of kelasIds) {
    const ok = await one(
      "SELECT 1 AS ada FROM guru_mapel WHERE guru_id = ? AND mapel_id = ? AND kelas_id = ?",
      [g.id, mapelId, kid]
    );
    if (!ok) {
      const k = await one("SELECT nama FROM kelas WHERE id = ?", [kid]);
      const m = await one("SELECT nama FROM mapel WHERE id = ?", [mapelId]);
      return `Kelas ${k?.nama ?? kid} untuk mapel ${m?.nama ?? mapelId} bukan kelas yang Anda ampu.`;
    }
  }
  return null;
}

/** Daftar id kelas yang diampu seorang guru (kosong bila bukan guru). */
async function kelasDiampu(user: any): Promise<number[]> {
  if (user.role === "admin") return [];
  const g = await one("SELECT id FROM guru WHERE user_id = ?", [user.id]);
  if (!g) return [];
  return (await all("SELECT DISTINCT kelas_id FROM guru_mapel WHERE guru_id = ?", [g.id])).map(
    (r: any) => r.kelas_id
  );
}

// ---------- Auth (pola GezyRaport) ----------
app.post("/api/login", async (c) => {
  const { username, password } = await bacaBody(c);
  if (!username || !password)
    return c.json({ error: "Username dan password wajib diisi" }, 400);
  const u = await one("SELECT * FROM users WHERE username = ?", [username]);
  if (!u || !(await Bun.password.verify(password, u.password_hash))) {
    void catatLog(c, "login_gagal", "username atau password salah", {
      username: String(username).slice(0, 64),
    });
    return c.json({ error: "Username atau password salah" }, 401);
  }
  const sid = await createSession(u.id);
  setSessionCookie(c, sid);
  void catatLog(c, "login", undefined, { id: u.id, username: u.username, role: u.role });
  return c.json({ ok: true, user: { id: u.id, username: u.username, role: u.role } });
});

app.post("/api/logout", async (c) => {
  const sid = getCookie(c, "sesi");
  const u = await getSessionUser(c);
  if (u) void catatLog(c, "logout", undefined, { id: u.id, username: u.username, role: u.role });
  if (sid) await destroySession(sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const u = await getSessionUser(c);
  if (!u) return c.json({ error: "Belum login" }, 401);
  const guru = await one("SELECT id, nama, nip FROM guru WHERE user_id = ?", [u.id]);
  return c.json({ user: { ...u, guru_id: guru?.id ?? null, guru_nama: guru?.nama ?? null, guru_nip: guru?.nip ?? null } });
});

app.post("/api/me/password", requireRole("admin", "guru"), async (c) => {
  const u = c.get("user") as any;
  const { lama, baru } = await bacaBody(c);
  if (!baru || String(baru).length < 6)
    return c.json({ error: "Kata sandi baru minimal 6 karakter" }, 400);
  const row = await one("SELECT * FROM users WHERE id = ?", [u.id]);
  if (!(await Bun.password.verify(String(lama ?? ""), row.password_hash)))
    return c.json({ error: "Kata sandi lama salah" }, 401);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [
    await Bun.password.hash(String(baru)),
    u.id,
  ]);
  void catatLog(c, "ubah_password_sendiri", undefined, u);
  return c.json({ ok: true });
});

// ---------- Dashboard ----------
app.get("/api/dashboard", requireRole("admin", "guru"), async (c) => {
  const murid = (await one("SELECT COUNT(*) c FROM siswa"))?.c ?? 0;
  const kelas = (await one("SELECT COUNT(*) c FROM kelas"))?.c ?? 0;
  const mapel = (await one("SELECT COUNT(*) c FROM mapel WHERE aktif = 1"))?.c ?? 0;
  const guru = (await one("SELECT COUNT(*) c FROM users WHERE role = 'guru'"))?.c ?? 0;
  const mapelAktif = (await all("SELECT * FROM mapel WHERE aktif = 1 ORDER BY nama")) as any[];
  const kelasRows = (await all("SELECT * FROM kelas ORDER BY nama")) as any[];
  const progres: any[] = [];
  if (mapelAktif.length) {
    const m = mapelAktif[0];
    for (const k of kelasRows) {
      const h = await hitungUntukLingkup(m.id, [k.id], SEMESTER_DEFAULT, TAHUN_DEFAULT);
      progres.push({ kelas: k.nama, terisi: h.terisi, total: h.total });
    }
  }
  return c.json({ murid, kelas, mapel, guru, mapel: mapelAktif, kelas: kelasRows, progres });
});

// ---------- Konteks: mapel & kelas ----------
app.get("/api/mapel", requireRole("admin", "guru"), async (c) =>
  c.json(await all("SELECT * FROM mapel ORDER BY nama"))
);
app.post("/api/mapel", requireRole("admin"), async (c) => {
  const { nama, kode } = await bacaBody(c);
  if (!nama || !kode) return c.json({ error: "Nama dan kode mapel wajib diisi" }, 400);
  try {
    await run("INSERT INTO mapel (nama, kode, aktif) VALUES (?,?,1)", [nama, kode.toUpperCase()]);
  } catch {
    return c.json({ error: "Kode mapel sudah ada" }, 400);
  }
  void catatLog(c, "tambah_mapel", String(nama));
  return c.json({ ok: true });
});

app.get("/api/kelas", requireRole("admin", "guru"), async (c) =>
  c.json(await all("SELECT * FROM kelas ORDER BY nama"))
);
app.post("/api/kelas", requireRole("admin"), async (c) => {
  const { nama } = await bacaBody(c);
  if (!nama) return c.json({ error: "Nama kelas wajib diisi" }, 400);
  const tingkat = String(nama).split(".")[0];
  try {
    await run("INSERT INTO kelas (nama, tingkat) VALUES (?,?)", [nama, tingkat]);
  } catch {
    return c.json({ error: "Kelas sudah ada" }, 400);
  }
  void catatLog(c, "tambah_kelas", String(nama));
  return c.json({ ok: true });
});

// ---------- Profil guru (wizard langkah 1) ----------
app.get("/api/guru-saya", requireRole("admin", "guru"), async (c) => {
  const u = c.get("user") as any;
  const g = await one("SELECT * FROM guru WHERE user_id = ?", [u.id]);
  return c.json(g ?? { nama: "", nip: "" });
});
app.put("/api/guru-saya", requireRole("admin", "guru"), async (c) => {
  const u = c.get("user") as any;
  const { nama, nip } = await bacaBody(c);
  if (!nama) return c.json({ error: "Nama guru wajib diisi" }, 400);
  await run(
    `INSERT INTO guru (user_id, nama, nip) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE nama = VALUES(nama), nip = VALUES(nip)`,
    [u.id, nama, nip ?? ""]
  );
  void catatLog(c, "simpan_profil_guru", String(nama));
  return c.json({ ok: true });
});

// ---------- TP (wizard langkah 3) ----------
app.get("/api/tp", requireRole("admin", "guru"), async (c) => {
  const mapelId = Number(c.req.query("mapel_id") || 0);
  const tingkat = c.req.query("tingkat") || "7";
  const semester = c.req.query("semester") || SEMESTER_DEFAULT;
  const tahun = c.req.query("tahun_ajaran") || TAHUN_DEFAULT;
  return c.json(
    await all(
      `SELECT * FROM tp WHERE mapel_id = ? AND tingkat = ? AND semester = ? AND tahun_ajaran = ? ORDER BY urutan, kode`,
      [mapelId, tingkat, semester, tahun]
    )
  );
});
app.post("/api/tp", requireRole("admin"), async (c) => {
  const { mapel_id, tingkat, semester, tahun_ajaran, kode, teks } = await bacaBody(c);
  if (!mapel_id || !tingkat || !kode || !teks)
    return c.json({ error: "Mapel, tingkat, kode, dan teks TP wajib diisi" }, 400);
  const urutan = Number(String(kode).replace(/\D/g, "")) || 0;
  await run(
    `INSERT INTO tp (mapel_id, tingkat, semester, tahun_ajaran, kode, teks, urutan)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE teks = VALUES(teks), urutan = VALUES(urutan)`,
    [mapel_id, tingkat, semester || SEMESTER_DEFAULT, tahun_ajaran || TAHUN_DEFAULT, kode, teks, urutan]
  );
  void catatLog(c, "simpan_tp", `${kode} (${tingkat})`);
  return c.json({ ok: true });
});
app.delete("/api/tp/:id", requireRole("admin"), async (c) => {
  await run("DELETE FROM tp WHERE id = ?", [c.req.param("id")]);
  void catatLog(c, "hapus_tp", `tp#${c.req.param("id")}`);
  return c.json({ ok: true });
});

// ---------- Pengaturan rumus (wizard langkah 2) ----------
app.get("/api/pengaturan", requireRole("admin", "guru"), async (c) => {
  const mapelId = Number(c.req.query("mapel_id") || 0);
  const semester = c.req.query("semester") || SEMESTER_DEFAULT;
  const tahun = c.req.query("tahun_ajaran") || TAHUN_DEFAULT;
  const { row, cfg, hariEfektif } = await ambilPengaturan(mapelId, semester, tahun);
  return c.json({ ...cfg, hari_efektif: hariEfektif, tersimpan: !!row });
});
app.put("/api/pengaturan", requireRole("admin"), async (c) => {
  const b = await bacaBody(c);
  const mapelId = Number(b.mapel_id || 0);
  if (!mapelId) return c.json({ error: "mapel_id wajib diisi" }, 400);
  const semester = b.semester || SEMESTER_DEFAULT;
  const tahun = b.tahun_ajaran || TAHUN_DEFAULT;
  const cfg = lengkapiPengaturan(b as PengaturanHitung);
  await run(
    `INSERT INTO pengaturan
     (mapel_id, semester, tahun_ajaran, rendah, tinggi, bobot_s, bobot_asts, bobot_asat,
      ambang, batas_th, patok_th, bonus_karakter, hari_efektif, mode_skala)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
      rendah=VALUES(rendah), tinggi=VALUES(tinggi), bobot_s=VALUES(bobot_s),
      bobot_asts=VALUES(bobot_asts), bobot_asat=VALUES(bobot_asat),
      ambang=VALUES(ambang), batas_th=VALUES(batas_th), patok_th=VALUES(patok_th),
      bonus_karakter=VALUES(bonus_karakter), hari_efektif=VALUES(hari_efektif),
      mode_skala=VALUES(mode_skala)`,
    [
      mapelId, semester, tahun, cfg.rendah, cfg.tinggi, cfg.bobotS, cfg.bobotAsts,
      cfg.bobotAsat, cfg.ambang, cfg.batasTh, cfg.patokTh, cfg.bonusKarakter,
      Number(b.hari_efektif ?? 110), cfg.modeSkala,
    ]
  );
  void catatLog(c, "simpan_pengaturan", `mapel#${mapelId} ${semester} ${tahun} mode=${cfg.modeSkala}`);
  return c.json({ ok: true });
});

// ---------- Murid ----------
app.get("/api/siswa", requireRole("admin", "guru"), async (c) => {
  const user = c.get("user") as any;
  const kelasId = Number(c.req.query("kelas_id") || 0);
  const q = (c.req.query("q") || "").trim();
  // Guru hanya melihat murid kelas yang diampunya.
  if (user.role === "guru") {
    const diampu = await kelasDiampu(user);
    if (kelasId && !diampu.includes(kelasId))
      return c.json({ error: "Kelas ini bukan kelas yang Anda ampu." }, 403);
    if (!kelasId && !q) {
      if (!diampu.length) return c.json([]);
      return c.json(
        await all(
          `SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id
           WHERE s.kelas_id IN (${diampu.map(() => "?").join(",")}) ORDER BY k.nama, s.nama`,
          diampu
        )
      );
    }
    if (!kelasId && q) {
      if (!diampu.length) return c.json([]);
      return c.json(
        await all(
          `SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id
           WHERE s.kelas_id IN (${diampu.map(() => "?").join(",")}) AND (s.nama LIKE ? OR s.nisn LIKE ?)
           ORDER BY s.nama LIMIT 50`,
          [...diampu, `%${q}%`, `%${q}%`]
        )
      );
    }
  }
  let rows: any[];
  if (kelasId) {
    rows = await all("SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id WHERE s.kelas_id=? ORDER BY s.nama", [kelasId]);
  } else if (q) {
    rows = await all("SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id WHERE s.nama LIKE ? OR s.nisn LIKE ? ORDER BY s.nama LIMIT 50", [`%${q}%`, `%${q}%`]);
  } else {
    rows = await all("SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id ORDER BY k.nama, s.nama LIMIT 200");
  }
  return c.json(rows);
});
app.post("/api/siswa", requireRole("admin"), async (c) => {
  const { nisn, nama, lp, kelas_id } = await bacaBody(c);
  if (!nisn || !nama || !kelas_id) return c.json({ error: "NISN, nama, dan kelas wajib diisi" }, 400);
  try {
    await run("INSERT INTO siswa (nisn, nama, lp, kelas_id) VALUES (?,?,?,?)", [
      normalisasiNISN(nisn), nama, lp || null, kelas_id,
    ]);
  } catch {
    return c.json({ error: "NISN sudah ada" }, 400);
  }
  void catatLog(c, "tambah_siswa", `${nama} (${nisn})`);
  return c.json({ ok: true });
});
app.post("/api/siswa/import", requireRole("admin"), async (c) => {
  const { kelas_id, csv } = await bacaBody(c);
  if (!kelas_id || !csv) return c.json({ error: "kelas_id dan isi CSV wajib diisi" }, 400);
  const rows = parseCSV(String(csv));
  let masuk = 0, lewati = 0;
  for (const r of rows) {
    const nisn = normalisasiNISN(r[0] ?? "");
    const nama = (r[1] ?? "").trim();
    const lp = (r[2] ?? "").trim().toUpperCase();
    if (!nisn || !nama) { lewati++; continue; }
    try {
      const res = await run("INSERT IGNORE INTO siswa (nisn, nama, lp, kelas_id) VALUES (?,?,?,?)", [nisn, nama, lp === "L" || lp === "P" ? lp : null, kelas_id]);
      if (res.affectedRows) masuk++; else lewati++;
    } catch { lewati++; }
  }
  void catatLog(c, "impor_siswa_csv", `kelas#${kelas_id}: masuk ${masuk}, lewati ${lewati}`);
  return c.json({ ok: true, masuk, lewati });
});

// ---------- Nilai & deskripsi (dihitung ulang tiap permintaan) ----------
app.get("/api/nilai", requireRole("admin", "guru"), async (c) => {
  const { mapelId, semester, tahun, kelasIds } = parseLingkup(c);
  if (!mapelId) return c.json({ error: "mapel_id wajib diisi" }, 400);
  if (!kelasIds.length) return c.json({ error: "Pilih minimal satu kelas" }, 400);
  const tolak = await cekAksesGuru(c.get("user"), mapelId, kelasIds);
  if (tolak) return c.json({ error: tolak }, 403);
  const kelasRows = (await all(`SELECT * FROM kelas WHERE id IN (${kelasIds.map(() => "?").join(",")})`, kelasIds)) as any[];
  const tingkat = new Set(kelasRows.map((k: any) => k.tingkat));
  if (tingkat.size > 1)
    return c.json({ error: "Gabungan kelas hanya dalam satu tingkat yang sama" }, 400);
  return c.json(await hitungUntukLingkup(mapelId, kelasIds, semester, tahun));
});

app.post("/api/nilai", requireRole("admin", "guru"), async (c) => {
  const u = c.get("user") as any;
  const b = await bacaBody(c);
  const siswaId = Number(b.siswa_id || 0);
  const mapelId = Number(b.mapel_id || 0);
  const semester = b.semester || SEMESTER_DEFAULT;
  const tahun = b.tahun_ajaran || TAHUN_DEFAULT;
  if (!siswaId || !mapelId) return c.json({ error: "siswa_id dan mapel_id wajib diisi" }, 400);
  const siswa = await one("SELECT kelas_id FROM siswa WHERE id = ?", [siswaId]);
  if (!siswa) return c.json({ error: "Murid tidak ditemukan" }, 404);
  const tolak = await cekAksesGuru(c.get("user"), mapelId, [siswa.kelas_id]);
  if (tolak) return c.json({ error: tolak }, 403);
  const s = ["s1", "s2", "s3", "s4", "s5"].map((k) => numOrNull(b[k]));
  const asts = numOrNull(b.asts);
  const asat = numOrNull(b.asat);
  for (const v of [...s, asts, asat]) if (!validNilai(v))
    return c.json({ error: "Nilai harus 0–100" }, 400);
  const th = b.th === null || b.th === undefined || b.th === "" ? 0 : Number(b.th);
  if (!Number.isInteger(th) || th < 0)
    return c.json({ error: "TH harus bilangan bulat >= 0" }, 400);
  const karakter = b.karakter === "A" ? "A" : "";
  const lama = await one(
    "SELECT * FROM nilai WHERE siswa_id=? AND mapel_id=? AND tahun_ajaran=? AND semester=?",
    [siswaId, mapelId, tahun, semester]
  );
  // Field yang dikirim (termasuk null eksplisit) menimpa; yang tidak
  // dikirim mempertahankan nilai lama — ini yang membuat simpan otomatis
  // per field di kartu murid aman.
  const ambil = (k: string) => (k in b ? numOrNull(b[k]) : lama?.[k] ?? null);
  const sBaru = ["s1", "s2", "s3", "s4", "s5"].map((k) => ambil(k));
  const astsBaru = ambil("asts");
  const asatBaru = ambil("asat");
  await run(
    `INSERT INTO nilai (siswa_id, mapel_id, tahun_ajaran, semester, s1, s2, s3, s4, s5,
      asts, asat, th, karakter, catatan, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE
      s1=VALUES(s1), s2=VALUES(s2), s3=VALUES(s3), s4=VALUES(s4), s5=VALUES(s5),
      asts=VALUES(asts), asat=VALUES(asat), th=VALUES(th),
      karakter=VALUES(karakter), catatan=VALUES(catatan),
      updated_by=VALUES(updated_by), updated_at=NOW()`,
    [
      siswaId, mapelId, tahun, semester,
      sBaru[0], sBaru[1], sBaru[2], sBaru[3], sBaru[4],
      astsBaru, asatBaru,
      "th" in b ? th : lama?.th ?? 0,
      "karakter" in b ? karakter : lama?.karakter ?? "",
      "catatan" in b ? String(b.catatan ?? "") : lama?.catatan ?? "",
      u.id,
    ]
  );
  void catatLog(c, "simpan_nilai", `siswa#${siswaId} mapel#${mapelId}`);
  return c.json({ ok: true });
});

// ---------- Rekap CSV ----------
app.get("/api/rekap.csv", requireRole("admin", "guru"), async (c) => {
  const { mapelId, semester, tahun, kelasIds } = parseLingkup(c);
  if (!mapelId || !kelasIds.length)
    return c.json({ error: "mapel_id dan kelas wajib diisi" }, 400);
  const tolak = await cekAksesGuru(c.get("user"), mapelId, kelasIds);
  if (tolak) return c.json({ error: tolak }, 403);
  const h = await hitungUntukLingkup(mapelId, kelasIds, semester, tahun);
  const mapelNama = (await one("SELECT nama FROM mapel WHERE id=?", [mapelId]))?.nama ?? "";
  const lines = [
    ["NISN", "Nama", "Kelas", "S1", "S2", "S3", "S4", "S5", "RT-S", "ASTS", "ASAT", "NR", "NA", "Predikat", "TH", "Karakter", "CHAR", "Deskripsi"].map(csvField).join(","),
    ...h.rows.map((r: any) =>
      [
        nisExcel(r.siswa.nisn), r.siswa.nama, r.siswa.kelas_nama,
        r.nilai.s[0], r.nilai.s[1], r.nilai.s[2], r.nilai.s[3], r.nilai.s[4],
        r.hasil.rtS, r.nilai.asts, r.nilai.asat, r.hasil.nr, r.hasil.na,
        r.hasil.predikat, r.nilai.th, r.nilai.karakter, r.hasil.char, r.hasil.deskripsi,
      ].map(csvField).join(",")
    ),
  ];
  void catatLog(c, "unduh_rekap_csv", `${mapelNama} ${h.kelas.map((k: any) => k.nama).join("+")}`);
  return new Response(bungkusCSV(lines), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rekap-${mapelNama}-${h.kelas.map((k: any) => k.nama).join("-")}.csv"`,
    },
  });
});

// ---------- Admin: kelola guru ----------
app.get("/api/admin/users", requireRole("admin"), async (c) => {
  const rows = await all(
    `SELECT u.id, u.username, u.role, u.created_at, g.nama AS guru_nama, g.nip AS guru_nip
     FROM users u LEFT JOIN guru g ON g.user_id = u.id ORDER BY u.id`
  );
  return c.json(rows);
});
app.post("/api/admin/users", requireRole("admin"), async (c) => {
  const { nama, nip, username, role } = await bacaBody(c);
  if (!nama) return c.json({ error: "Nama guru wajib diisi" }, 400);
  const uname = (username || usernameDariNama(nama)).trim();
  if (!uname) return c.json({ error: "Username tidak valid" }, 400);
  const peran = role === "admin" ? "admin" : "guru";
  // Pola GezyRaport: kata sandi awal = username.
  const hash = await Bun.password.hash(uname);
  try {
    const r = await run(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,NOW())",
      [uname, hash, peran]
    );
    if (peran === "guru")
      await run("INSERT INTO guru (user_id, nama, nip) VALUES (?,?,?)", [r.insertId, nama, nip ?? ""]);
  } catch {
    return c.json({ error: "Username sudah ada" }, 400);
  }
  void catatLog(c, "tambah_akun", `${uname} (${peran})`);
  return c.json({ ok: true, username: uname, password_awal: uname });
});
app.post("/api/admin/users/:id/reset", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const u = await one("SELECT * FROM users WHERE id = ?", [id]);
  if (!u) return c.json({ error: "Akun tidak ditemukan" }, 404);
  // Pola GezyRaport: reset ke username.
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [
    await Bun.password.hash(u.username),
    id,
  ]);
  void catatLog(c, "reset_sandi", u.username);
  return c.json({ ok: true, password_baru: u.username });
});
app.delete("/api/admin/users/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const u = c.get("user") as any;
  if (id === u.id) return c.json({ error: "Tidak bisa menghapus akun sendiri" }, 400);
  await run("DELETE FROM guru WHERE user_id = ?", [id]);
  await run("DELETE FROM sessions WHERE user_id = ?", [id]);
  await run("DELETE FROM users WHERE id = ?", [id]);
  void catatLog(c, "hapus_akun", `user#${id}`);
  return c.json({ ok: true });
});

// ---------- Admin: log, backup, restore ----------
app.get("/api/admin/log", requireRole("admin"), async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  return c.json(await all("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?", [limit]));
});
app.get("/api/admin/backup", requireRole("admin"), async (c) => {
  const dump: any = { aplikasi: "GezyDafnil", versi: 1, diekspor: new Date().toISOString() };
  for (const t of ["users", "guru", "mapel", "kelas", "siswa", "tp", "guru_mapel", "pengaturan", "nilai"])
    dump[t] = await all(`SELECT * FROM ${t}`);
  void catatLog(c, "backup_json", undefined);
  return c.json(dump);
});
app.post("/api/admin/restore", requireRole("admin"), async (c) => {
  const b = await bacaBody(c);
  if (!b || b.aplikasi !== "GezyDafnil" || !Array.isArray(b.users))
    return c.json({ error: "File backup GezyDafnil tidak valid" }, 400);
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const q = (sql: string, params: any[] = []) => conn.query(sql, params);
    for (const tbl of ["nilai", "guru_mapel", "pengaturan", "tp", "siswa", "kelas", "mapel", "guru", "users"])
      await q(`DELETE FROM ${tbl}`);
    const isi = async (tabel: string, cols: string[], rows: any[]) => {
      for (const r of rows ?? []) {
        const vals = cols.map((k) => r[k] ?? null);
        await q(`INSERT INTO ${tabel} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
      }
    };
    await isi("users", ["id", "username", "password_hash", "role", "created_at"], b.users);
    await isi("guru", ["id", "user_id", "nama", "nip"], b.guru);
    await isi("mapel", ["id", "nama", "kode", "aktif"], b.mapel);
    await isi("kelas", ["id", "nama", "tingkat"], b.kelas);
    await isi("siswa", ["id", "nisn", "nama", "lp", "kelas_id"], b.siswa);
    await isi("tp", ["id", "mapel_id", "tingkat", "semester", "tahun_ajaran", "kode", "teks", "urutan"], b.tp);
    await isi("guru_mapel", ["guru_id", "mapel_id", "kelas_id"], b.guru_mapel);
    await isi("pengaturan", ["id", "mapel_id", "semester", "tahun_ajaran", "rendah", "tinggi", "bobot_s", "bobot_asts", "bobot_asat", "ambang", "batas_th", "patok_th", "bonus_karakter", "hari_efektif", "mode_skala", "mode_th"], b.pengaturan);
    await isi("nilai", ["siswa_id", "mapel_id", "tahun_ajaran", "semester", "s1", "s2", "s3", "s4", "s5", "asts", "asat", "th", "karakter", "catatan", "updated_by", "updated_at"], b.nilai);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  void catatLog(c, "restore_json", `users=${(b.users ?? []).length}`);
  return c.json({ ok: true });
});

// ---------- Master Data (ADMIN ONLY) ----------
// Guru, murid, kelas, mapel, periode, TP, pengaturan: CRUD manual lengkap
// + export/import CSV per master (validasi per baris; baris valid masuk,
// baris gagal ditolak beserta alasannya — tidak setengah-setengah diam-diam).

async function guruDenganTugas(id: number) {
  const g = await one(
    `SELECT g.*, u.username, u.role FROM guru g JOIN users u ON u.id = g.user_id WHERE g.id = ?`,
    [id]
  );
  if (!g) return null;
  const tugas = await all(
    `SELECT gm.mapel_id, gm.kelas_id, m.nama AS mapel_nama, m.kode AS mapel_kode, k.nama AS kelas_nama
     FROM guru_mapel gm JOIN mapel m ON m.id = gm.mapel_id JOIN kelas k ON k.id = gm.kelas_id
     WHERE gm.guru_id = ? ORDER BY k.nama, m.nama`,
    [id]
  );
  return { ...g, tugas };
}

app.get("/api/admin/guru", requireRole("admin"), async (c) => {
  const rows = await all(
    `SELECT g.id, g.user_id, g.nama, g.nip, u.username, u.role, u.created_at
     FROM guru g JOIN users u ON u.id = g.user_id ORDER BY g.nama`
  );
  const out: any[] = [];
  for (const r of rows as any[]) out.push(await guruDenganTugas(r.id));
  return c.json(out);
});

app.post("/api/admin/guru", requireRole("admin"), async (c) => {
  const b = await bacaBody(c);
  const { nama, nip } = b;
  if (!nama) return c.json({ error: "Nama guru wajib diisi" }, 400);
  const uname = (b.username || usernameDariNama(nama)).trim();
  if (!uname) return c.json({ error: "Username tidak valid" }, 400);
  const peran = b.role === "admin" ? "admin" : "guru";
  const sandi = String(b.password || uname);
  if (sandi.length < 6) return c.json({ error: "Kata sandi minimal 6 karakter" }, 400);
  const ada = await one("SELECT id FROM users WHERE username = ?", [uname]);
  if (ada) return c.json({ error: "Username sudah ada" }, 400);
  const r = await run(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,NOW())",
    [uname, await Bun.password.hash(sandi), peran]
  );
  const gid = (
    await run("INSERT INTO guru (user_id, nama, nip) VALUES (?,?,?)", [
      r.insertId,
      nama,
      nip ?? "",
    ])
  ).insertId;
  if (Array.isArray(b.tugas)) {
    for (const t of b.tugas) {
      if (t.mapel_id && t.kelas_id)
        await run("INSERT IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)", [
          gid,
          t.mapel_id,
          t.kelas_id,
        ]);
    }
  }
  void catatLog(c, "tambah_guru", `${uname} (${peran})`);
  return c.json({ ok: true, id: gid, username: uname, password_awal: sandi });
});

app.put("/api/admin/guru/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await bacaBody(c);
  const g = await one("SELECT * FROM guru WHERE id = ?", [id]);
  if (!g) return c.json({ error: "Guru tidak ditemukan" }, 404);
  if (b.nama) await run("UPDATE guru SET nama = ?, nip = ? WHERE id = ?", [b.nama, b.nip ?? g.nip, id]);
  if (b.username) {
    const bentrok = await one("SELECT id FROM users WHERE username = ? AND id <> ?", [b.username, g.user_id]);
    if (bentrok) return c.json({ error: "Username sudah dipakai akun lain" }, 400);
    await run("UPDATE users SET username = ? WHERE id = ?", [b.username, g.user_id]);
  }
  if (b.password) {
    if (String(b.password).length < 6) return c.json({ error: "Kata sandi minimal 6 karakter" }, 400);
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [
      await Bun.password.hash(String(b.password)),
      g.user_id,
    ]);
  }
  if (b.role === "admin" || b.role === "guru")
    await run("UPDATE users SET role = ? WHERE id = ?", [b.role, g.user_id]);
  if (Array.isArray(b.tugas)) {
    await run("DELETE FROM guru_mapel WHERE guru_id = ?", [id]);
    for (const t of b.tugas) {
      if (t.mapel_id && t.kelas_id)
        await run("INSERT IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)", [
          id,
          t.mapel_id,
          t.kelas_id,
        ]);
    }
  }
  void catatLog(c, "ubah_guru", `guru#${id}`);
  return c.json({ ok: true });
});

app.delete("/api/admin/guru/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const g = await one(
    "SELECT g.*, u.username FROM guru g JOIN users u ON u.id = g.user_id WHERE g.id = ?",
    [id]
  );
  if (!g) return c.json({ error: "Guru tidak ditemukan" }, 404);
  const tugas = (await one("SELECT COUNT(*) c FROM guru_mapel WHERE guru_id = ?", [id]))?.c ?? 0;
  const nilai = (await one("SELECT COUNT(*) c FROM nilai WHERE updated_by = ?", [g.user_id]))?.c ?? 0;
  if (tugas > 0 || nilai > 0)
    return c.json(
      {
        error: `Tidak bisa dihapus: guru ini masih mengampu ${tugas} kelas×mapel dan pernah menyimpan ${nilai} nilai. Lepas dulu tugas mengajarnya di menu ini, atau hubungi admin.`,
      },
      400
    );
  await run("DELETE FROM sessions WHERE user_id = ?", [g.user_id]);
  await run("DELETE FROM guru WHERE id = ?", [id]);
  await run("DELETE FROM users WHERE id = ?", [g.user_id]);
  void catatLog(c, "hapus_guru", g.username);
  return c.json({ ok: true });
});

// ---------- Murid: ubah & hapus (tambah sudah ada di /api/siswa, admin) ----------
app.put("/api/siswa/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await bacaBody(c);
  const s = await one("SELECT * FROM siswa WHERE id = ?", [id]);
  if (!s) return c.json({ error: "Murid tidak ditemukan" }, 404);
  const nisn = normalisasiNISN(b.nisn ?? s.nisn);
  const nama = (b.nama ?? s.nama).trim();
  const lp = b.lp === "L" || b.lp === "P" ? b.lp : b.lp === "" || b.lp === null ? null : s.lp;
  const kelasId = Number(b.kelas_id ?? s.kelas_id);
  if (!nisn || !nama) return c.json({ error: "NISN dan nama wajib diisi" }, 400);
  if (b.lp && b.lp !== "L" && b.lp !== "P") return c.json({ error: "L/P harus L atau P" }, 400);
  const kelas = await one("SELECT id FROM kelas WHERE id = ?", [kelasId]);
  if (!kelas) return c.json({ error: "Kelas tidak ditemukan" }, 400);
  try {
    await run("UPDATE siswa SET nisn = ?, nama = ?, lp = ?, kelas_id = ? WHERE id = ?", [
      nisn,
      nama,
      lp,
      kelasId,
      id,
    ]);
  } catch {
    return c.json({ error: "NISN sudah dipakai murid lain" }, 400);
  }
  void catatLog(c, "ubah_siswa", `${nama} (${nisn})`);
  return c.json({ ok: true });
});

app.delete("/api/siswa/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const s = await one("SELECT * FROM siswa WHERE id = ?", [id]);
  if (!s) return c.json({ error: "Murid tidak ditemukan" }, 404);
  const nilai = (await one("SELECT COUNT(*) c FROM nilai WHERE siswa_id = ?", [id]))?.c ?? 0;
  if (nilai > 0)
    return c.json(
      { error: `Tidak bisa dihapus: murid ini sudah punya ${nilai} baris nilai. Hapus nilainya dulu bila memang salah input.` },
      400
    );
  await run("DELETE FROM siswa WHERE id = ?", [id]);
  void catatLog(c, "hapus_siswa", `${s.nama} (${s.nisn})`);
  return c.json({ ok: true });
});

// ---------- Kelas: ubah & hapus ----------
app.put("/api/kelas/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await bacaBody(c);
  const k = await one("SELECT * FROM kelas WHERE id = ?", [id]);
  if (!k) return c.json({ error: "Kelas tidak ditemukan" }, 404);
  const nama = (b.nama ?? k.nama).trim();
  const tingkat = String(b.tingkat ?? k.tingkat).trim();
  if (!["7", "8", "9"].includes(tingkat)) return c.json({ error: "Tingkat harus 7, 8, atau 9" }, 400);
  const wali = b.wali_guru_id === "" || b.wali_guru_id === null || b.wali_guru_id === undefined
    ? null
    : Number(b.wali_guru_id);
  if (wali !== null) {
    const g = await one("SELECT id FROM guru WHERE id = ?", [wali]);
    if (!g) return c.json({ error: "Wali kelas tidak ditemukan" }, 400);
  }
  try {
    await run("UPDATE kelas SET nama = ?, tingkat = ?, wali_guru_id = ? WHERE id = ?", [nama, tingkat, wali, id]);
  } catch {
    return c.json({ error: "Nama kelas sudah dipakai kelas lain" }, 400);
  }
  void catatLog(c, "ubah_kelas", nama);
  return c.json({ ok: true });
});

app.delete("/api/kelas/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const k = await one("SELECT * FROM kelas WHERE id = ?", [id]);
  if (!k) return c.json({ error: "Kelas tidak ditemukan" }, 404);
  const murid = (await one("SELECT COUNT(*) c FROM siswa WHERE kelas_id = ?", [id]))?.c ?? 0;
  const tugas = (await one("SELECT COUNT(*) c FROM guru_mapel WHERE kelas_id = ?", [id]))?.c ?? 0;
  if (murid > 0 || tugas > 0)
    return c.json(
      { error: `Tidak bisa dihapus: kelas ini masih berisi ${murid} murid dan ${tugas} penugasan mengajar. Pindahkan/hapus dulu isinya.` },
      400
    );
  await run("DELETE FROM kelas WHERE id = ?", [id]);
  void catatLog(c, "hapus_kelas", k.nama);
  return c.json({ ok: true });
});

// ---------- Mapel: ubah & hapus ----------
app.put("/api/mapel/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await bacaBody(c);
  const m = await one("SELECT * FROM mapel WHERE id = ?", [id]);
  if (!m) return c.json({ error: "Mapel tidak ditemukan" }, 404);
  const nama = (b.nama ?? m.nama).trim();
  const kode = String(b.kode ?? m.kode).trim().toUpperCase();
  const aktif = b.aktif === undefined ? m.aktif : b.aktif ? 1 : 0;
  if (!nama || !kode) return c.json({ error: "Nama dan kode wajib diisi" }, 400);
  try {
    await run("UPDATE mapel SET nama = ?, kode = ?, aktif = ? WHERE id = ?", [nama, kode, aktif, id]);
  } catch {
    return c.json({ error: "Kode mapel sudah dipakai mapel lain" }, 400);
  }
  void catatLog(c, "ubah_mapel", nama);
  return c.json({ ok: true });
});

app.delete("/api/mapel/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const m = await one("SELECT * FROM mapel WHERE id = ?", [id]);
  if (!m) return c.json({ error: "Mapel tidak ditemukan" }, 404);
  const tp = (await one("SELECT COUNT(*) c FROM tp WHERE mapel_id = ?", [id]))?.c ?? 0;
  const pg = (await one("SELECT COUNT(*) c FROM pengaturan WHERE mapel_id = ?", [id]))?.c ?? 0;
  const nl = (await one("SELECT COUNT(*) c FROM nilai WHERE mapel_id = ?", [id]))?.c ?? 0;
  const tg = (await one("SELECT COUNT(*) c FROM guru_mapel WHERE mapel_id = ?", [id]))?.c ?? 0;
  if (tp + pg + nl + tg > 0)
    return c.json(
      { error: `Tidak bisa dihapus: mapel ini masih dipakai (${tp} TP, ${pg} pengaturan, ${nl} nilai, ${tg} penugasan).` },
      400
    );
  await run("DELETE FROM mapel WHERE id = ?", [id]);
  void catatLog(c, "hapus_mapel", m.nama);
  return c.json({ ok: true });
});

// ---------- TP: ubah ----------
app.put("/api/tp/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await bacaBody(c);
  const t = await one("SELECT * FROM tp WHERE id = ?", [id]);
  if (!t) return c.json({ error: "TP tidak ditemukan" }, 404);
  const kode = String(b.kode ?? t.kode).trim().toUpperCase();
  const teks = (b.teks ?? t.teks).trim();
  if (!kode || !teks) return c.json({ error: "Kode dan teks TP wajib diisi" }, 400);
  try {
    await run("UPDATE tp SET kode = ?, teks = ? WHERE id = ?", [kode, teks, id]);
  } catch {
    return c.json({ error: "Kode TP sudah ada untuk mapel+tingkat+semester ini" }, 400);
  }
  void catatLog(c, "ubah_tp", kode);
  return c.json({ ok: true });
});

// ---------- Periode (semester/tahun ajaran) ----------
app.get("/api/admin/periode", requireRole("admin"), async (c) =>
  c.json(await all("SELECT * FROM periode ORDER BY tahun_ajaran DESC, semester"))
);
app.post("/api/admin/periode", requireRole("admin"), async (c) => {
  const { semester, tahun_ajaran, aktif } = await bacaBody(c);
  if (!semester || !tahun_ajaran) return c.json({ error: "Semester dan tahun ajaran wajib diisi" }, 400);
  try {
    const r = await run("INSERT INTO periode (semester, tahun_ajaran, aktif) VALUES (?,?,?)", [
      semester,
      tahun_ajaran,
      aktif ? 1 : 0,
    ]);
    if (aktif) {
      await run("UPDATE periode SET aktif = 0 WHERE id <> ?", [r.insertId]);
      await run("UPDATE periode SET aktif = 1 WHERE id = ?", [r.insertId]);
    }
    void catatLog(c, "tambah_periode", `${semester} ${tahun_ajaran}`);
    return c.json({ ok: true, id: r.insertId });
  } catch {
    return c.json({ error: "Periode sudah ada" }, 400);
  }
});
app.put("/api/admin/periode/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const { semester, tahun_ajaran, aktif } = await bacaBody(c);
  const p = await one("SELECT * FROM periode WHERE id = ?", [id]);
  if (!p) return c.json({ error: "Periode tidak ditemukan" }, 404);
  try {
    await run("UPDATE periode SET semester = ?, tahun_ajaran = ?, aktif = ? WHERE id = ?", [
      semester ?? p.semester,
      tahun_ajaran ?? p.tahun_ajaran,
      aktif === undefined ? p.aktif : aktif ? 1 : 0,
      id,
    ]);
    if (aktif) await run("UPDATE periode SET aktif = 0 WHERE id <> ?", [id]);
  } catch {
    return c.json({ error: "Periode sudah ada" }, 400);
  }
  void catatLog(c, "ubah_periode", `periode#${id}`);
  return c.json({ ok: true });
});
app.delete("/api/admin/periode/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const p = await one("SELECT * FROM periode WHERE id = ?", [id]);
  if (!p) return c.json({ error: "Periode tidak ditemukan" }, 404);
  const dipakai =
    ((await one("SELECT COUNT(*) c FROM tp WHERE semester=? AND tahun_ajaran=?", [p.semester, p.tahun_ajaran]))?.c ?? 0) +
    ((await one("SELECT COUNT(*) c FROM pengaturan WHERE semester=? AND tahun_ajaran=?", [p.semester, p.tahun_ajaran]))?.c ?? 0) +
    ((await one("SELECT COUNT(*) c FROM nilai WHERE semester=? AND tahun_ajaran=?", [p.semester, p.tahun_ajaran]))?.c ?? 0);
  if (dipakai > 0)
    return c.json({ error: `Tidak bisa dihapus: periode ini masih dipakai ${dipakai} data (TP/pengaturan/nilai).` }, 400);
  await run("DELETE FROM periode WHERE id = ?", [id]);
  void catatLog(c, "hapus_periode", `${p.semester} ${p.tahun_ajaran}`);
  return c.json({ ok: true });
});

// ---------- Pengaturan: daftar & hapus ----------
app.get("/api/admin/pengaturan", requireRole("admin"), async (c) =>
  c.json(
    await all(
      `SELECT pg.*, m.nama AS mapel_nama FROM pengaturan pg JOIN mapel m ON m.id = pg.mapel_id ORDER BY m.nama, pg.tahun_ajaran, pg.semester`
    )
  )
);
app.delete("/api/admin/pengaturan/:id", requireRole("admin"), async (c) => {
  await run("DELETE FROM pengaturan WHERE id = ?", [c.req.param("id")]);
  void catatLog(c, "hapus_pengaturan", `pengaturan#${c.req.param("id")}`);
  return c.json({ ok: true });
});

// ---------- Export / template / import CSV per master ----------
// Setiap impor: validasi per baris; baris valid masuk (atau diubah bila
// kuncinya sudah ada), baris gagal ditolak dengan {baris, alasan}.
const EXPORT_JENIS = ["guru", "murid", "kelas", "mapel", "tp", "pengaturan", "periode"] as const;

function lewatiHeader(rows: string[][], headerPertama: string): { data: string[][]; mulai: number } {
  if (!rows.length) return { data: [], mulai: 1 };
  const pertama = (rows[0][0] ?? "").trim().toLowerCase();
  if (pertama === headerPertama.toLowerCase()) return { data: rows.slice(1), mulai: 2 };
  return { data: rows, mulai: 1 };
}

app.get("/api/admin/export/:jenis", requireRole("admin"), async (c) => {
  const jenis = c.req.param("jenis") as (typeof EXPORT_JENIS)[number];
  if (!EXPORT_JENIS.includes(jenis)) return c.json({ error: "Jenis tidak dikenal" }, 400);
  let lines: string[] = [];
  if (jenis === "guru") {
    lines = [["Username", "Nama", "NIP", "Peran", "MapelDiampu"].map(csvField).join(",")];
    for (const g of (await all(
      `SELECT g.*, u.username, u.role FROM guru g JOIN users u ON u.id=g.user_id ORDER BY g.nama`
    )) as any[]) {
      const tugas = (await all(
        `SELECT m.kode, k.nama FROM guru_mapel gm JOIN mapel m ON m.id=gm.mapel_id JOIN kelas k ON k.id=gm.kelas_id WHERE gm.guru_id=? ORDER BY k.nama`,
        [g.id]
      )) as any[];
      lines.push([g.username, g.nama, g.nip, g.role, tugas.map((t: any) => `${t.kode}:${t.nama}`).join(";")].map(csvField).join(","));
    }
  } else if (jenis === "murid") {
    const kelasId = Number(c.req.query("kelas_id") || 0);
    lines = [["NISN", "Nama", "L/P", "Kelas"].map(csvField).join(",")];
    const rows = kelasId
      ? await all("SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id WHERE s.kelas_id=? ORDER BY k.nama, s.nama", [kelasId])
      : await all("SELECT s.*, k.nama AS kelas_nama FROM siswa s JOIN kelas k ON k.id=s.kelas_id ORDER BY k.nama, s.nama");
    for (const s of rows as any[])
      lines.push([nisExcel(s.nisn), s.nama, s.lp, s.kelas_nama].map(csvField).join(","));
  } else if (jenis === "kelas") {
    lines = [["Nama", "Tingkat", "Wali"].map(csvField).join(",")];
    for (const k of (await all(
      `SELECT k.*, u.username AS wali_username FROM kelas k LEFT JOIN guru g ON g.id=k.wali_guru_id LEFT JOIN users u ON u.id=g.user_id ORDER BY k.nama`
    )) as any[])
      lines.push([k.nama, k.tingkat, k.wali_username].map(csvField).join(","));
  } else if (jenis === "mapel") {
    lines = [["Nama", "Kode", "Aktif"].map(csvField).join(",")];
    for (const m of (await all("SELECT * FROM mapel ORDER BY nama")) as any[])
      lines.push([m.nama, m.kode, m.aktif ? 1 : 0].map(csvField).join(","));
  } else if (jenis === "tp") {
    const mapelId = Number(c.req.query("mapel_id") || 0);
    lines = [["Mapel", "Kode", "Tingkat", "Semester", "TahunAjaran", "Teks"].map(csvField).join(",")];
    const rows = mapelId
      ? await all("SELECT tp.*, m.kode AS mapel_kode FROM tp JOIN mapel m ON m.id=tp.mapel_id WHERE tp.mapel_id=? ORDER BY tp.tingkat, tp.urutan", [mapelId])
      : await all("SELECT tp.*, m.kode AS mapel_kode FROM tp JOIN mapel m ON m.id=tp.mapel_id ORDER BY m.nama, tp.tingkat, tp.urutan");
    for (const t of rows as any[])
      lines.push([t.mapel_kode, t.kode, t.tingkat, t.semester, t.tahun_ajaran, t.teks].map(csvField).join(","));
  } else if (jenis === "pengaturan") {
    lines = [["Mapel", "Semester", "TahunAjaran", "Rendah", "Tinggi", "BobotS", "BobotASTS", "BobotASAT", "Ambang", "BatasTH", "PatokTH", "BonusKarakter", "HariEfektif", "ModeSkala"].map(csvField).join(",")];
    for (const p of (await all(
      `SELECT pg.*, m.kode AS mapel_kode FROM pengaturan pg JOIN mapel m ON m.id=pg.mapel_id ORDER BY m.nama`
    )) as any[])
      lines.push([p.mapel_kode, p.semester, p.tahun_ajaran, p.rendah, p.tinggi, p.bobot_s, p.bobot_asts, p.bobot_asat, p.ambang, p.batas_th, p.patok_th, p.bonus_karakter, p.hari_efektif, p.mode_skala].map(csvField).join(","));
  } else if (jenis === "periode") {
    lines = [["Semester", "TahunAjaran", "Aktif"].map(csvField).join(",")];
    for (const p of (await all("SELECT * FROM periode ORDER BY tahun_ajaran, semester")) as any[])
      lines.push([p.semester, p.tahun_ajaran, p.aktif ? 1 : 0].map(csvField).join(","));
  }
  void catatLog(c, "export_csv", jenis);
  return new Response(bungkusCSV(lines), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gezydafnil-${jenis}.csv"`,
    },
  });
});

app.get("/api/admin/template/:jenis", requireRole("admin"), (c) => {
  const jenis = c.req.param("jenis");
  const contoh: Record<string, string> = {
    guru: "Username,Nama,NIP,Peran,Password,MapelDiampu\nsiti.asiyah,Siti Asiyah,198001012005011001,guru,siti.asiyah,MTK:7.1;MTK:7.2",
    murid: "NISN,Nama,L/P,Kelas\n0132505002,ADITYA PRATAMA,L,7.1",
    kelas: "Nama,Tingkat,Wali\n7.9,7,siti.asiyah",
    mapel: "Nama,Kode,Aktif\nMatematika,MTK,1",
    tp: "Mapel,Kode,Tingkat,Semester,TahunAjaran,Teks\nMTK,S1,7,Ganjil,2026/2027,menentukan hasil operasi hitung bilangan bulat.",
    pengaturan: "Mapel,Semester,TahunAjaran,Rendah,Tinggi,BobotS,BobotASTS,BobotASAT,Ambang,BatasTH,PatokTH,BonusKarakter,HariEfektif,ModeSkala\nMTK,Ganjil,2026/2027,70,95,0.7,0.15,0.15,85,10,70,10,110,excel",
    periode: "Semester,TahunAjaran,Aktif\nGenap,2026/2027,0",
  };
  if (!contoh[jenis]) return c.json({ error: "Jenis tidak dikenal" }, 400);
  return new Response(bungkusCSV(contoh[jenis].split("\n")), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="template-${jenis}.csv"`,
    },
  });
});

app.post("/api/admin/import/:jenis", requireRole("admin"), async (c) => {
  const jenis = c.req.param("jenis");
  const b = await bacaBody(c);
  const rowsMentah = parseCSV(String(b.csv ?? ""));
  const gagal: { baris: number; alasan: string }[] = [];
  let masuk = 0;
  let diubah = 0;

  const angka = (v: string | undefined, nama: string, baris: number): number | null => {
    if (v === undefined || v.trim() === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      gagal.push({ baris, alasan: `${nama} bukan angka: "${v}"` });
      return null;
    }
    return n;
  };

  if (jenis === "murid") {
    const { data, mulai } = lewatiHeader(rowsMentah, "NISN");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const nisn = normalisasiNISN(r[0] ?? "");
      const nama = (r[1] ?? "").trim();
      const lp = (r[2] ?? "").trim().toUpperCase();
      const kelasNama = (r[3] ?? "").trim() || (b.kelas_nama ?? "");
      if (!nisn) { gagal.push({ baris, alasan: "NISN kosong" }); continue; }
      if (!nama) { gagal.push({ baris, alasan: "Nama kosong" }); continue; }
      if (lp !== "" && lp !== "L" && lp !== "P") { gagal.push({ baris, alasan: `L/P harus L atau P, dapat "${r[2]}"` }); continue; }
      if (!kelasNama) { gagal.push({ baris, alasan: "Kelas kosong" }); continue; }
      const kelas = await one("SELECT id FROM kelas WHERE nama = ?", [kelasNama]);
      if (!kelas) { gagal.push({ baris, alasan: `Kelas "${kelasNama}" tidak ditemukan` }); continue; }
      const lama = await one("SELECT id FROM siswa WHERE nisn = ?", [nisn]);
      if (lama) {
        await run("UPDATE siswa SET nama=?, lp=?, kelas_id=? WHERE id=?", [nama, lp || null, kelas.id, lama.id]);
        diubah++;
      } else {
        await run("INSERT INTO siswa (nisn, nama, lp, kelas_id) VALUES (?,?,?,?)", [nisn, nama, lp || null, kelas.id]);
        masuk++;
      }
    }
  } else if (jenis === "guru") {
    const { data, mulai } = lewatiHeader(rowsMentah, "Username");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const nama = (r[1] ?? "").trim();
      const nip = (r[2] ?? "").trim();
      const username = (r[0] ?? "").trim() || usernameDariNama(nama);
      const peran = (r[3] ?? "guru").trim().toLowerCase() === "admin" ? "admin" : "guru";
      const sandi = (r[4] ?? "").trim() || username;
      if (!nama) { gagal.push({ baris, alasan: "Nama kosong" }); continue; }
      if (!username) { gagal.push({ baris, alasan: "Username kosong" }); continue; }
      if (sandi.length < 6) { gagal.push({ baris, alasan: "Kata sandi minimal 6 karakter" }); continue; }
      const tugas = (r[5] ?? "").split(";").map((x: string) => x.trim()).filter(Boolean);
      const tugasOk: { mapel_id: number; kelas_id: number }[] = [];
      let ok = true;
      for (const t of tugas) {
        const [kode, kelasNama] = t.split(":").map((x: string) => x.trim());
        const m = await one("SELECT id FROM mapel WHERE kode = ?", [kode?.toUpperCase()]);
        const k = await one("SELECT id FROM kelas WHERE nama = ?", [kelasNama]);
        if (!m || !k) { gagal.push({ baris, alasan: `Tugas "${t}" tidak valid (mapel/kelas tidak ditemukan)` }); ok = false; break; }
        tugasOk.push({ mapel_id: m.id, kelas_id: k.id });
      }
      if (!ok) continue;
      const lama = await one("SELECT id FROM users WHERE username = ?", [username]);
      let gid: number;
      if (lama) {
        const g = await one("SELECT id FROM guru WHERE user_id = ?", [lama.id]);
        if (g) {
          await run("UPDATE guru SET nama=?, nip=? WHERE id=?", [nama, nip, g.id]);
          gid = g.id;
        } else {
          gid = (await run("INSERT INTO guru (user_id, nama, nip) VALUES (?,?,?)", [lama.id, nama, nip])).insertId;
        }
        await run("UPDATE users SET role=? WHERE id=?", [peran, lama.id]);
        diubah++;
      } else {
        const uid = (await run("INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,NOW())", [
          username, await Bun.password.hash(sandi), peran,
        ])).insertId;
        gid = (await run("INSERT INTO guru (user_id, nama, nip) VALUES (?,?,?)", [uid, nama, nip])).insertId;
        masuk++;
      }
      for (const t of tugasOk)
        await run("INSERT IGNORE INTO guru_mapel (guru_id, mapel_id, kelas_id) VALUES (?,?,?)", [gid, t.mapel_id, t.kelas_id]);
    }
  } else if (jenis === "kelas") {
    const { data, mulai } = lewatiHeader(rowsMentah, "Nama");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const nama = (r[0] ?? "").trim();
      const tingkat = (r[1] ?? "").trim() || nama.split(".")[0];
      const waliUsername = (r[2] ?? "").trim();
      if (!nama) { gagal.push({ baris, alasan: "Nama kelas kosong" }); continue; }
      if (!["7", "8", "9"].includes(tingkat)) { gagal.push({ baris, alasan: `Tingkat harus 7/8/9, dapat "${tingkat}"` }); continue; }
      let waliId: number | null = null;
      if (waliUsername) {
        const g = await one("SELECT g.id FROM guru g JOIN users u ON u.id=g.user_id WHERE u.username=?", [waliUsername]);
        if (!g) { gagal.push({ baris, alasan: `Wali "${waliUsername}" tidak ditemukan` }); continue; }
        waliId = g.id;
      }
      const lama = await one("SELECT id FROM kelas WHERE nama = ?", [nama]);
      if (lama) {
        await run("UPDATE kelas SET tingkat=?, wali_guru_id=? WHERE id=?", [tingkat, waliId, lama.id]);
        diubah++;
      } else {
        await run("INSERT INTO kelas (nama, tingkat, wali_guru_id) VALUES (?,?,?)", [nama, tingkat, waliId]);
        masuk++;
      }
    }
  } else if (jenis === "mapel") {
    const { data, mulai } = lewatiHeader(rowsMentah, "Nama");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const nama = (r[0] ?? "").trim();
      const kode = (r[1] ?? "").trim().toUpperCase();
      const aktif = (r[2] ?? "1").trim();
      if (!nama || !kode) { gagal.push({ baris, alasan: "Nama dan Kode wajib diisi" }); continue; }
      if (aktif !== "0" && aktif !== "1") { gagal.push({ baris, alasan: `Aktif harus 0/1, dapat "${aktif}"` }); continue; }
      const lama = await one("SELECT id FROM mapel WHERE kode = ?", [kode]);
      if (lama) {
        await run("UPDATE mapel SET nama=?, aktif=? WHERE id=?", [nama, Number(aktif), lama.id]);
        diubah++;
      } else {
        await run("INSERT INTO mapel (nama, kode, aktif) VALUES (?,?,?)", [nama, kode, Number(aktif)]);
        masuk++;
      }
    }
  } else if (jenis === "tp") {
    const { data, mulai } = lewatiHeader(rowsMentah, "Mapel");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const kodeMapel = (r[0] ?? "").trim().toUpperCase();
      const kode = (r[1] ?? "").trim().toUpperCase();
      const tingkat = (r[2] ?? "").trim();
      const semester = (r[3] ?? "").trim();
      const tahun = (r[4] ?? "").trim();
      const teks = (r[5] ?? "").trim();
      if (!kodeMapel || !kode || !tingkat || !semester || !tahun || !teks) {
        gagal.push({ baris, alasan: "Semua kolom TP wajib diisi" });
        continue;
      }
      if (!["7", "8", "9"].includes(tingkat)) { gagal.push({ baris, alasan: `Tingkat harus 7/8/9, dapat "${tingkat}"` }); continue; }
      const m = await one("SELECT id FROM mapel WHERE kode = ?", [kodeMapel]);
      if (!m) { gagal.push({ baris, alasan: `Mapel "${kodeMapel}" tidak ditemukan` }); continue; }
      await run(
        `INSERT INTO tp (mapel_id, tingkat, semester, tahun_ajaran, kode, teks, urutan)
         VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE teks = VALUES(teks), urutan = VALUES(urutan)`,
        [m.id, tingkat, semester, tahun, kode, teks, Number(kode.replace(/\D/g, "")) || 0]
      );
      masuk++;
    }
  } else if (jenis === "pengaturan") {
    const { data, mulai } = lewatiHeader(rowsMentah, "Mapel");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const kodeMapel = (r[0] ?? "").trim().toUpperCase();
      const semester = (r[1] ?? "").trim();
      const tahun = (r[2] ?? "").trim();
      if (!kodeMapel || !semester || !tahun) { gagal.push({ baris, alasan: "Mapel, Semester, TahunAjaran wajib diisi" }); continue; }
      const m = await one("SELECT id FROM mapel WHERE kode = ?", [kodeMapel]);
      if (!m) { gagal.push({ baris, alasan: `Mapel "${kodeMapel}" tidak ditemukan` }); continue; }
      const sebelum = gagal.length;
      const rendah = angka(r[3], "Rendah", baris);
      const tinggi = angka(r[4], "Tinggi", baris);
      const bS = angka(r[5], "BobotS", baris);
      const bA = angka(r[6], "BobotASTS", baris);
      const bAt = angka(r[7], "BobotASAT", baris);
      const ambang = angka(r[8], "Ambang", baris);
      const batasTh = angka(r[9], "BatasTH", baris);
      const patokTh = angka(r[10], "PatokTH", baris);
      const bonus = angka(r[11], "BonusKarakter", baris);
      const hari = angka(r[12], "HariEfektif", baris);
      const mode = (r[13] ?? "murni").trim().toLowerCase();
      if (mode !== "excel" && mode !== "murni") { gagal.push({ baris, alasan: `ModeSkala harus excel/murni, dapat "${r[13]}"` }); continue; }
      if (gagal.length > sebelum) continue;
      const lama = await one("SELECT id FROM pengaturan WHERE mapel_id=? AND semester=? AND tahun_ajaran=?", [m.id, semester, tahun]);
      const vals = [rendah ?? 70, tinggi ?? 95, bS ?? 0.7, bA ?? 0.15, bAt ?? 0.15, ambang ?? 85, batasTh ?? 10, patokTh ?? 70, bonus ?? 10, hari ?? 110, mode];
      if (lama) {
        await run(
          `UPDATE pengaturan SET rendah=?, tinggi=?, bobot_s=?, bobot_asts=?, bobot_asat=?, ambang=?, batas_th=?, patok_th=?, bonus_karakter=?, hari_efektif=?, mode_skala=? WHERE id=?`,
          [...vals, lama.id]
        );
        diubah++;
      } else {
        await run(
          `INSERT INTO pengaturan (mapel_id, semester, tahun_ajaran, rendah, tinggi, bobot_s, bobot_asts, bobot_asat, ambang, batas_th, patok_th, bonus_karakter, hari_efektif, mode_skala)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [m.id, semester, tahun, ...vals]
        );
        masuk++;
      }
    }
  } else if (jenis === "periode") {
    const { data, mulai } = lewatiHeader(rowsMentah, "Semester");
    for (let i = 0; i < data.length; i++) {
      const baris = mulai + i;
      const r = data[i];
      if (r.every((x) => x.trim() === "")) continue;
      const semester = (r[0] ?? "").trim();
      const tahun = (r[1] ?? "").trim();
      const aktif = (r[2] ?? "0").trim();
      if (!semester || !tahun) { gagal.push({ baris, alasan: "Semester dan TahunAjaran wajib diisi" }); continue; }
      if (aktif !== "0" && aktif !== "1") { gagal.push({ baris, alasan: `Aktif harus 0/1, dapat "${aktif}"` }); continue; }
      const lama = await one("SELECT id FROM periode WHERE semester=? AND tahun_ajaran=?", [semester, tahun]);
      if (lama) {
        await run("UPDATE periode SET aktif=? WHERE id=?", [Number(aktif), lama.id]);
        diubah++;
      } else {
        const rid = (await run("INSERT INTO periode (semester, tahun_ajaran, aktif) VALUES (?,?,?)", [semester, tahun, Number(aktif)])).insertId;
        if (aktif === "1") {
          await run("UPDATE periode SET aktif=0 WHERE id<>?", [rid]);
          await run("UPDATE periode SET aktif=1 WHERE id=?", [rid]);
        }
        masuk++;
      }
      if (aktif === "1" && lama) await run("UPDATE periode SET aktif=0 WHERE id<>?", [lama.id]);
    }
  } else {
    return c.json({ error: "Jenis tidak dikenal" }, 400);
  }

  void catatLog(c, "impor_csv", `${jenis}: masuk ${masuk}, diubah ${diubah}, gagal ${gagal.length}`);
  return c.json({ ok: true, masuk, diubah, gagal });
});

// ---------- Static frontend ----------
app.get("/", (c) => new Response(Bun.file("./public/index.html")));
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT || 3103);
console.log(`GezyDafnil berjalan di http://localhost:${port}`);

export default { port, fetch: app.fetch };
