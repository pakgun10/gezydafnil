import { one, all, closePool } from "../db";
import { hitungLingkup, lengkapiPengaturan } from "../lib/hitung";

/**
 * Verifikasi GezyDafnil terhadap MariaDB (bukan SQLite):
 *  - hitungan seed (788 murid, 24 kelas, 3 TP, 22 nilai, admin),
 *  - NA 22/22 + klasifikasi deskripsi 22/22 cocok dengan cache Excel
 *    untuk kelas 7.1, lingkup per kelas, mode skala "excel" (default).
 * Jalan: bun scripts/verify.ts   (setelah migrate + seed)
 */
let gagal = 0;
function cek(nama: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "GAGAL"} ${nama}${detail ? " — " + detail : ""}`);
  if (!ok) gagal++;
}

const murid = (await one("SELECT COUNT(*) c FROM siswa"))?.c;
const kelas = (await one("SELECT COUNT(*) c FROM kelas"))?.c;
const tp = (await one("SELECT COUNT(*) c FROM tp"))?.c;
const nilai = (await one("SELECT COUNT(*) c FROM nilai"))?.c;
const admin = await one("SELECT id FROM users WHERE username='admin' AND role='admin'");
cek("murid = 788", murid === 788, `dapat ${murid}`);
cek("kelas = 24", kelas === 24, `dapat ${kelas}`);
cek("TP = 3", tp === 3, `dapat ${tp}`);
cek("nilai awal = 22", nilai === 22, `dapat ${nilai}`);
cek("admin ada", !!admin);

const mapel = (await one("SELECT id FROM mapel WHERE kode='MTK'")) as any;
const kelas71 = (await one("SELECT id FROM kelas WHERE nama='7.1'")) as any;
const tpRows = (await all(
  "SELECT kode, teks FROM tp WHERE mapel_id=? AND tingkat='7' AND semester='Ganjil' AND tahun_ajaran='2026/2027' ORDER BY urutan",
  [mapel.id]
)) as { kode: string; teks: string }[];
const rows = (await all(
  `SELECT s.nama, n.s1, n.s2, n.s3, n.s4, n.s5, n.asts, n.asat, n.th, n.karakter
   FROM nilai n JOIN siswa s ON s.id = n.siswa_id
   WHERE n.mapel_id = ? AND s.kelas_id = ? AND n.semester='Ganjil' AND n.tahun_ajaran='2026/2027'
   ORDER BY s.nama`,
  [mapel.id, kelas71.id]
)) as any[];

const cache = JSON.parse(
  await Bun.file(new URL("../data/excel-cache-22.json", import.meta.url)).text()
) as any[];
const cacheByNama = new Map(cache.map((r: any) => [r.nama, r]));

const { hasil } = hitungLingkup(
  rows.map((r: any) => ({
    nilai: {
      s: [r.s1, r.s2, r.s3, r.s4, r.s5].map((v: any) => (v === null ? null : Number(v))),
      asts: r.asts === null ? null : Number(r.asts),
      asat: r.asat === null ? null : Number(r.asat),
      th: r.th ?? 0,
      karakter: r.karakter ?? "",
    },
  })),
  tpRows,
  lengkapiPengaturan(undefined)
);

let naSama = 0;
let deskSama = 0;
const beda: string[] = [];
rows.forEach((r: any, i: number) => {
  const c = cacheByNama.get(r.nama);
  if (!c) return;
  if (hasil[i].na === c.na) naSama++;
  else beda.push(`${r.nama}: NA hitung ${hasil[i].na} vs Excel ${c.na}`);
  if (
    JSON.stringify(hasil[i].tpTertinggi) === JSON.stringify(c.tinggi) &&
    JSON.stringify(hasil[i].tpTerendah) === JSON.stringify(c.rendah)
  )
    deskSama++;
  else beda.push(`${r.nama}: deskripsi hitung ${hasil[i].tpTertinggi}/${hasil[i].tpTerendah} vs Excel ${c.tinggi}/${c.rendah}`);
});
cek("NA cocok Excel 22/22 (mode excel)", naSama === 22, `${naSama}/22`);
cek("deskripsi cocok Excel 22/22", deskSama === 22, `${deskSama}/22`);
for (const b of beda) console.log("  beda:", b);

const contoh = (nama: string) => {
  const i = rows.findIndex((r: any) => r.nama === nama);
  return { nr: hasil[i].nr, na: hasil[i].na };
};
console.log("  Aditya 65,2 ->", contoh("ADITYA PRATAMA"));
console.log("  Adjie ->", contoh("ADJIE MAHESSA GALIH"));
console.log("  Afif TH30 ->", contoh("AFIF SYADID WAFIDIN"));
console.log("  Agustiana A ->", contoh("AGUSTIANA MONIKA WIBOWO"));
console.log("  Vito A ->", contoh("AHMAD VITO DARMAWAN"));

await closePool();
if (gagal) {
  console.log(`\n${gagal} pemeriksaan GAGAL.`);
  process.exit(1);
}
console.log("\nSemua pemeriksaan lolos.");
process.exit(0);
