import { one, all, closePool } from "../db";
import { hitungLingkup, lengkapiPengaturan } from "../lib/hitung";

/**
 * Verifikasi GezyDafnil terhadap MariaDB (bukan SQLite):
 *  - hitungan seed (788 murid, 24 kelas, 3 TP, 22 nilai, admin),
 *  - mode skala di DB adalah "murni" (keputusan Pak Gun 18 Nov 2026),
 *  - NA 22/22 + klasifikasi deskripsi 22/22 cocok dengan cache Excel
 *    bila dihitung dengan mode "excel" (regresi terhadap file),
 *  - mode "murni" (default) mengubah NA seperti yang diputuskan
 *    (Aditya 65,2 -> 86, bukan 88; hanya 2/22 yang sama dengan Excel).
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
const modeDb = (await one(
  "SELECT mode_skala FROM pengaturan WHERE mapel_id=? AND semester='Ganjil' AND tahun_ajaran='2026/2027'",
  [mapel.id]
)) as any;
cek("mode skala di DB = murni (keputusan Pak Gun)", modeDb?.mode_skala === "murni", `dapat ${modeDb?.mode_skala}`);
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

const inputNilai = rows.map((r: any) => ({
  nilai: {
    s: [r.s1, r.s2, r.s3, r.s4, r.s5].map((v: any) => (v === null ? null : Number(v))),
    asts: r.asts === null ? null : Number(r.asts),
    asat: r.asat === null ? null : Number(r.asat),
    th: r.th ?? 0,
    karakter: r.karakter ?? "",
  },
}));

// Mode "excel": regresi terhadap file — harus 22/22 sama dengan cache.
const { hasil } = hitungLingkup(
  inputNilai,
  tpRows,
  lengkapiPengaturan({ modeSkala: "excel" })
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
cek("NA cocok Excel 22/22 (mode excel, regresi)", naSama === 22, `${naSama}/22`);
cek("deskripsi cocok Excel 22/22 (mode excel)", deskSama === 22, `${deskSama}/22`);
for (const b of beda) console.log("  beda:", b);

// Mode "murni" (default, keputusan Pak Gun): NA berubah dari cache Excel.
const { hasil: hasilMurni } = hitungLingkup(
  inputNilai,
  tpRows,
  lengkapiPengaturan({ modeSkala: "murni" })
);
const contohMurni = (nama: string) => {
  const i = rows.findIndex((r: any) => r.nama === nama);
  return { nr: hasilMurni[i].nr, na: hasilMurni[i].na };
};
const murniSama = rows.filter(
  (r: any, i: number) => hasilMurni[i].na === cacheByNama.get(r.nama)?.na
).length;
cek("mode murni: Aditya 65,2 -> NA 86 (bukan 88)", contohMurni("ADITYA PRATAMA").na === 86, `dapat ${contohMurni("ADITYA PRATAMA").na}`);
cek("mode murni: Afif TH30 tetap dipatok 70", contohMurni("AFIF SYADID WAFIDIN").na === 70, `dapat ${contohMurni("AFIF SYADID WAFIDIN").na}`);
cek("mode murni: hanya 2/22 sama dengan Excel (terdokumentasi)", murniSama === 2, `${murniSama}/22`);

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
