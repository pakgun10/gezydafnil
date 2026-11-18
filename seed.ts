import { one, all, run } from "./db";

// Seed GezyDafnil (MariaDB) — IDEMPOTENT (boleh dijalankan berulang;
// INSERT IGNORE / ON DUPLICATE KEY UPDATE di mana-mana). Data murid &
// nilai berasal dari DAFNIL.xlsx (lihat scripts/extract-dafnil.py;
// sheet DESK sengaja diabaikan). Jalankan dulu: bun scripts/migrate.ts
const seed = JSON.parse(
  await Bun.file(new URL("./data/seed-dafnil.json", import.meta.url)).text()
) as {
  mapel: string;
  semester: string;
  tahun_ajaran: string;
  hari_efektif: number;
  tp_kelas_7: { kode: string; teks: string }[];
  murid: { nisn: string; nama: string; lp: string | null; kelas: string }[];
  nilai_kelas_7_1: {
    nisn: string;
    s1: number | null;
    s2: number | null;
    s3: number | null;
    s4: number | null;
    s5: number | null;
    asts: number | null;
    asat: number | null;
    th: number | null;
    karakter: string | null;
    catatan: string | null;
  }[];
};

// ---------- Admin bawaan (pola GezyRaport) ----------
// PERINGATAN: kata sandi bawaan "admin123" HARUS segera diganti setelah
// login pertama (Admin > Kelola Guru > ubah sandi admin, atau buat akun
// admin baru lalu hapus yang ini). Jangan dipakai di produksi apa adanya.
const adminAda = await one("SELECT id FROM users WHERE username = 'admin'");
if (!adminAda) {
  const hash = await Bun.password.hash("admin123");
  await run(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,NOW())",
    ["admin", hash, "admin"]
  );
  console.log("OK: user admin dibuat (username: admin, password: admin123).");
  console.log("    !! SEGERA GANTI kata sandi admin setelah login pertama.");
} else {
  console.log("OK: user admin sudah ada, dilewati.");
}

// ---------- Mapel ----------
await run("INSERT IGNORE INTO mapel (nama, kode, aktif) VALUES (?,?,1)", [
  seed.mapel,
  "MTK",
]);
const mapel = (await one("SELECT id FROM mapel WHERE kode = 'MTK'")) as any;
console.log(`OK: mapel ${seed.mapel} (id ${mapel.id}).`);

// ---------- Pengaturan default mapel+semester ----------
await run(
  `INSERT IGNORE INTO pengaturan
   (mapel_id, semester, tahun_ajaran, hari_efektif)
   VALUES (?,?,?,?)`,
  [mapel.id, seed.semester, seed.tahun_ajaran, seed.hari_efektif]
);

// ---------- Kelas + murid ----------
const kelasId = new Map<string, number>();
for (const m of seed.murid) {
  if (!kelasId.has(m.kelas)) {
    await run("INSERT IGNORE INTO kelas (nama, tingkat) VALUES (?,?)", [
      m.kelas,
      m.kelas.split(".")[0],
    ]);
    const k = (await one("SELECT id FROM kelas WHERE nama = ?", [m.kelas])) as any;
    kelasId.set(m.kelas, k.id);
  }
}
let muridBaru = 0;
for (const m of seed.murid) {
  const r = await run(
    "INSERT IGNORE INTO siswa (nisn, nama, lp, kelas_id) VALUES (?,?,?,?)",
    [m.nisn, m.nama, m.lp || null, kelasId.get(m.kelas)!]
  );
  if (r.affectedRows) muridBaru++;
}
console.log(
  `OK: ${kelasId.size} kelas, ${seed.murid.length} murid (baru: ${muridBaru}).`
);

// ---------- TP kelas 7 ----------
let tpBaru = 0;
for (let i = 0; i < seed.tp_kelas_7.length; i++) {
  const t = seed.tp_kelas_7[i];
  const r = await run(
    `INSERT IGNORE INTO tp
     (mapel_id, tingkat, semester, tahun_ajaran, kode, teks, urutan)
     VALUES (?,?,?,?,?,?,?)`,
    [mapel.id, "7", seed.semester, seed.tahun_ajaran, t.kode, t.teks, i + 1]
  );
  if (r.affectedRows) tpBaru++;
}
console.log(`OK: TP kelas 7: ${seed.tp_kelas_7.length} (baru: ${tpBaru}).`);

// ---------- Nilai 22 murid kelas 7.1 ----------
const siswaId = new Map<string, number>();
for (const row of (await all("SELECT id, nisn FROM siswa")) as any[])
  siswaId.set(row.nisn, row.id);
let nilaiBaru = 0;
for (const n of seed.nilai_kelas_7_1) {
  const sid = siswaId.get(n.nisn);
  if (!sid) {
    console.log(`  lewati nilai: murid ${n.nisn} tidak ditemukan`);
    continue;
  }
  const r = await run(
    `INSERT IGNORE INTO nilai
     (siswa_id, mapel_id, tahun_ajaran, semester, s1, s2, s3, s4, s5,
      asts, asat, th, karakter, catatan, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [
      sid,
      mapel.id,
      seed.tahun_ajaran,
      seed.semester,
      n.s1,
      n.s2,
      n.s3,
      n.s4,
      n.s5,
      n.asts,
      n.asat,
      n.th ?? 0,
      n.karakter ?? "",
      n.catatan ?? "",
    ]
  );
  if (r.affectedRows) nilaiBaru++;
}
console.log(`OK: nilai awal: ${seed.nilai_kelas_7_1.length} (baru: ${nilaiBaru}).`);

console.log("Seed selesai.");
process.exit(0);
