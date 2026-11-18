/**
 * Verifikasi CRUD + export/import GezyDafnil lewat HTTP API (server harus
 * jalan di http://127.0.0.1:3103). Data uji dibuat lalu dibersihkan lagi.
 * Jalan: bun scripts/verify-crud.ts
 */
const BASE = process.env.DAFNIL_URL ?? "http://127.0.0.1:3103";
let cookie = "";
let gagal = 0;

function cek(nama: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "GAGAL"} ${nama}${detail ? " — " + detail : ""}`);
  if (!ok) gagal++;
}

async function req(path: string, opt: any = {}, simpanCookie = true) {
  const r = await fetch(BASE + path, {
    ...opt,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(opt.headers || {}) },
  });
  const setCookie = r.headers.get("set-cookie");
  if (simpanCookie && setCookie) cookie = setCookie.split(";")[0];
  const teks = await r.text();
  let data: any = null;
  try { data = JSON.parse(teks); } catch { data = teks; }
  return { status: r.status, data, teks };
}

// ---------- login admin ----------
let r = await req("/api/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin123" }) });
cek("login admin sukses", r.status === 200, `status ${r.status}`);
r = await req("/api/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "salah" }) }, false);
cek("login admin kata sandi salah ditolak 401", r.status === 401, `status ${r.status}`);

// ---------- 1. tambah guru manual ----------
r = await req("/api/admin/guru", {
  method: "POST",
  body: JSON.stringify({ nama: "Guru Tes", nip: "199001012020011001", username: "guru.tes", password: "guru.tes", role: "guru" }),
});
cek("tambah guru manual", r.status === 200 && r.data.username === "guru.tes", JSON.stringify(r.data));
const guruTesId = r.data.id;

// tambah kelas manual 7.9
r = await req("/api/kelas", { method: "POST", body: JSON.stringify({ nama: "7.9" }) });
cek("tambah kelas manual 7.9", r.status === 200, JSON.stringify(r.data));
const kelasList = (await req("/api/kelas")).data;
const kelas79 = kelasList.find((k: any) => k.nama === "7.9");
cek("kelas 7.9 ditemukan", !!kelas79, `id ${kelas79?.id}`);

// tugaskan guru ke MTK 7.9
const mapelList = (await req("/api/mapel")).data;
const mtk = mapelList.find((m: any) => m.kode === "MTK");
r = await req(`/api/admin/guru/${guruTesId}`, {
  method: "PUT",
  body: JSON.stringify({ tugas: [{ mapel_id: mtk.id, kelas_id: kelas79.id }] }),
});
cek("tugaskan guru ke MTK 7.9", r.status === 200, JSON.stringify(r.data));

// tambah murid manual di 7.9
r = await req("/api/siswa", {
  method: "POST",
  body: JSON.stringify({ nisn: "9999999999", nama: "TES MURID SATU", lp: "L", kelas_id: kelas79.id }),
});
cek("tambah murid manual", r.status === 200, JSON.stringify(r.data));
let muridList = (await req(`/api/siswa?kelas_id=${kelas79.id}`)).data;
let muridTes = muridList.find((s: any) => s.nisn === "9999999999");
cek("murid tes ditemukan di 7.9", !!muridTes, `id ${muridTes?.id}`);

// ubah murid (pindah nama + L/P)
r = await req(`/api/siswa/${muridTes.id}`, {
  method: "PUT",
  body: JSON.stringify({ nama: "TES MURID SATU UBAH", lp: "P" }),
});
cek("ubah murid manual", r.status === 200, JSON.stringify(r.data));
muridList = (await req(`/api/siswa?kelas_id=${kelas79.id}`)).data;
muridTes = muridList.find((s: any) => s.nisn === "9999999999");
cek("nama murid berubah", muridTes?.nama === "TES MURID SATU UBAH" && muridTes?.lp === "P", JSON.stringify(muridTes));

// ---------- 2. export CSV murid, ubah nama, import kembali ----------
// Export endpoint mengembalikan CSV mentah (bukan JSON).
const exp = await fetch(`${BASE}/api/admin/export/murid?kelas_id=${kelas79.id}`, { headers: { Cookie: cookie } });
const csvAwal = await exp.text();
cek("export CSV murid 200", exp.status === 200, `status ${exp.status}, ${csvAwal.split("\n").length} baris`);
const csvUbah = csvAwal.replace("TES MURID SATU UBAH", "TES MURID SATU FINAL");
r = await req("/api/admin/import/murid", { method: "POST", body: JSON.stringify({ csv: csvUbah }) });
cek("import CSV hasil export (ubah nama)", r.status === 200 && r.data.diubah >= 1 && r.data.gagal.length === 0, JSON.stringify(r.data));
muridList = (await req(`/api/siswa?kelas_id=${kelas79.id}`)).data;
muridTes = muridList.find((s: any) => s.nisn === "9999999999");
cek("nama murid berubah lewat import", muridTes?.nama === "TES MURID SATU FINAL", JSON.stringify(muridTes));

// ---------- 3. import CSV dengan 1 baris sengaja salah ----------
// Murid dan kelas masih dipakai untuk verifikasi hapus di bawah.
const nipBaru = "0123456789";
const csvCampur = [
  "NISN,Nama,L/P,Kelas",
  `9999999999,TES MURID SATU FINAL,L,7.9`,
  `${nipBaru},TES MURID DUA,X,7.9`,
].join("\n");
r = await req("/api/admin/import/murid", { method: "POST", body: JSON.stringify({ csv: csvCampur }) });
cek("import campuran: baris benar masuk", r.status === 200 && r.data.diubah >= 1, JSON.stringify(r.data));
cek("import campuran: 1 baris gagal ditolak + ada alasan", r.data.gagal.length === 1 && /L\/P/.test(r.data.gagal[0].alasan), JSON.stringify(r.data.gagal));
muridList = (await req(`/api/siswa?kelas_id=${kelas79.id}`)).data;
cek("baris salah (NISN 0123456789) TIDAK masuk", !muridList.some((s: any) => s.nisn === nipBaru));

// ---------- 4. hapus guru: ditolak saat masih mengampu ----------
// Guru Tes memiliki tugas MTK 7.9
r = await req(`/api/admin/guru/${guruTesId}`, { method: "DELETE" });
cek("hapus guru ditolak saat masih mengampu (400)", r.status === 400, JSON.stringify(r.data));
// lepas tugas, lalu hapus berhasil
await req(`/api/admin/guru/${guruTesId}`, { method: "PUT", body: JSON.stringify({ tugas: [] }) });
r = await req(`/api/admin/guru/${guruTesId}`, { method: "DELETE" });
cek("hapus guru berhasil setelah tugas dilepas", r.status === 200, JSON.stringify(r.data));

// ---------- 5. hapus murid + kelas ----------
r = await req(`/api/siswa/${muridTes.id}`, { method: "DELETE" });
cek("hapus murid tes", r.status === 200, JSON.stringify(r.data));
r = await req(`/api/kelas/${kelas79.id}`, { method: "DELETE" });
cek("hapus kelas 7.9", r.status === 200, JSON.stringify(r.data));
muridList = (await req(`/api/siswa?kelas_id=${kelas79.id}`)).data;
cek("kelas 7.9 kosong setelah bersih-bersih", muridList.length === 0, `${muridList.length} murid`);

// ---------- 6. batas guru: guru hanya bisa kelas yang diampu ----------
// Buat guru kedua + tugaskan hanya ke 7.1, lalu login sebagai dia.
r = await req("/api/admin/guru", {
  method: "POST",
  body: JSON.stringify({ nama: "Guru Batas", username: "guru.batas", password: "guru.batas", role: "guru" }),
});
const guruBatasId = r.data.id;
const kelas71 = kelasList.find((k: any) => k.nama === "7.1");
await req(`/api/admin/guru/${guruBatasId}`, {
  method: "PUT",
  body: JSON.stringify({ tugas: [{ mapel_id: mtk.id, kelas_id: kelas71.id }] }),
});
const cookieAdmin = cookie;
cookie = "";
r = await req("/api/login", { method: "POST", body: JSON.stringify({ username: "guru.batas", password: "guru.batas" }) });
cek("login guru sukses", r.status === 200, `status ${r.status}`);
const kelas72 = kelasList.find((k: any) => k.nama === "7.2");
r = await req(`/api/nilai?mapel_id=${mtk.id}&kelas_ids=${kelas72.id}`);
cek("guru ditolak akses kelas 7.2 (bukan ampuannya)", r.status === 403, `status ${r.status}`);
r = await req(`/api/nilai?mapel_id=${mtk.id}&kelas_ids=${kelas71.id}`);
cek("guru bisa akses kelas 7.1 (ampuannya)", r.status === 200 && r.data.rows.length === 32, `rows ${r.data?.rows?.length}`);
r = await req("/api/admin/guru");
cek("guru ditolak CRUD master data (403)", r.status === 403, `status ${r.status}`);
// NA kelas 7.1 lewat API harus sama dengan Excel (cek ulang dari sisi HTTP).
const cache = JSON.parse(await Bun.file(new URL("../data/excel-cache-22.json", import.meta.url)).text());
const byNama = new Map(cache.map((x: any) => [x.nama, x]));
let naSama = 0;
for (const row of r.data?.rows ?? []) {
  const c = byNama.get(row.siswa.nama);
  if (c && row.hasil.na === c.na) naSama++;
}
const r71 = await req(`/api/nilai?mapel_id=${mtk.id}&kelas_ids=${kelas71.id}`);
naSama = 0;
for (const row of r71.data.rows) {
  const c = byNama.get(row.siswa.nama);
  if (c && row.hasil.na === c.na) naSama++;
}
cek("NA 7.1 via API cocok Excel 22/22", naSama === 22, `${naSama}/22`);

// bersih-bersih guru batas (kembali sebagai admin)
cookie = cookieAdmin;
await req(`/api/admin/guru/${guruBatasId}`, { method: "PUT", body: JSON.stringify({ tugas: [] }) });
r = await req(`/api/admin/guru/${guruBatasId}`, { method: "DELETE" });
cek("hapus guru batas (bersih-bersih)", r.status === 200, JSON.stringify(r.data));

console.log(gagal ? `\n${gagal} pemeriksaan GAGAL.` : "\nSemua pemeriksaan CRUD lolos.");
process.exit(gagal ? 1 : 0);
