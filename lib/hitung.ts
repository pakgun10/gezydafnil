/**
 * GezyDafnil — rumus nilai & deskripsi (FUNGSI MURNI, tanpa DB/HTTP).
 * Satu-satunya tempat rumus hidup; server dan test sama-sama memakainya.
 *
 * Alur per murid (per mapel per semester):
 *   RT-S = ROUND(rata-rata nilai S yang terisi)
 *   NR   = ROUND(0,7*RT-S + 0,15*ASTS + 0,15*ASAT, 2) — hanya bila RT-S,
 *          ASTS, ASAT ketiganya terisi (perbaikan dari Excel yang
 *          menganggap kosong = 0).
 *   NA   = skala(NR) lalu patok TH lalu bonus Karakter A.
 *          Urutan wajib: skala -> patok TH -> bonus A.
 *   Deskripsi per TP: tiap nilai S dikonversi dengan skala yang sama;
 *          hasil > ambang (85) -> "sangat baik", <= ambang -> "perlu
 *          peningkatan". Deskripsi final = gabungan keduanya.
 *
 * PENTING — dua mode skala (keputusan Pak Gun 18 Nov 2026, 20.39 WIB: default "murni"):
 *   - "murni" (DEFAULT): MIN/MAX hanya dari nilai yang terisi, tanpa sel
 *     parameter apa pun. Mode ini MENGUBAH NA dibanding cache Excel (hanya
 *     2/22 yang sama — mis. Aditya 65,2 -> 86, bukan 88), karena cache Excel
 *     memakai quirk kolom penuh (lihat mode "excel"). Inilah yang diputuskan
 *     Pak Gun: MIN/MAX hanya dari nilai yang terisi.
 *   - "excel" (setia pada file Excel): batas MIN/MAX efektif sama seperti
 *     rumus kolom penuh Excel. Di Excel, MIN(N:N) ikut menghitung sel N8 =
 *     jumlah bobot (=1) dan MIN(F:J) ikut menghitung bobot terkecil (=0,15)
 *     serta MAX(F:J) ikut menghitung batas atas F7 (=95).
 *     Maka: nrMin = min(jumlahBobot, min NR terisi),
 *           nrMax = max NR terisi,
 *           tpMin = min(bobotTerkecil, min S terisi),
 *           tpMax = max(batasAtas, max S terisi).
 *     Dengan mode ini NA 22 murid kelas 7.1 SAMA PERSIS dengan cache Excel
 *     (22/22) — dibuktikan lib/hitung.test.ts. Tersedia sebagai pilihan
 *     per mapel+semester bila Pak Gun ingin membandingkan dengan file lama.
 */

export type ModeSkala = "excel" | "murni";

/** Aturan TH (keputusan Pak Gun 19 Nov 2026: "B — pakai draf bertingkat"). */
export type ModeTh = "patok" | "bertingkat";

/**
 * Tier aturan TH bertingkat (draf yang disetujui Pak Gun, opsi B).
 * Batas atas NA per rentang TH; null = tanpa batas. Bonus Karakter A
 * tetap dihitung SESUDAH pemotongan ini (lihat hitungSatu).
 */
export interface TierTh {
  sampai: number; // TH s.d. nilai ini (inklusif)
  maksNA: number | null;
}

export const TIER_TH_BERTINGKAT: TierTh[] = [
  { sampai: 5, maksNA: null },
  { sampai: 10, maksNA: 90 },
  { sampai: 15, maksNA: 80 },
  { sampai: 25, maksNA: 75 },
  { sampai: Number.POSITIVE_INFINITY, maksNA: 70 },
];

/** Terapkan aturan TH ke NA hasil skala. */
export function terapkanTh(
  naSkala: number,
  th: number,
  cfg: Required<PengaturanHitung>
): number {
  if (cfg.modeTh === "patok") return th > cfg.batasTh ? cfg.patokTh : naSkala;
  for (const t of TIER_TH_BERTINGKAT) {
    if (th <= t.sampai) return t.maksNA === null ? naSkala : Math.min(naSkala, t.maksNA);
  }
  return naSkala;
}

export interface PengaturanHitung {
  rendah?: number; // default 70
  tinggi?: number; // default 95
  bobotS?: number; // default 0.7
  bobotAsts?: number; // default 0.15
  bobotAsat?: number; // default 0.15
  ambang?: number; // default 85
  batasTh?: number; // default 10 (hanya mode "patok")
  patokTh?: number; // default 70 (hanya mode "patok")
  bonusKarakter?: number; // default 10
  modeSkala?: ModeSkala; // default "murni" (keputusan Pak Gun 18 Nov 2026)
  modeTh?: ModeTh; // default "bertingkat" (keputusan Pak Gun 19 Nov 2026, opsi B)
}

export const DEFAULT_PENGATURAN: Required<PengaturanHitung> = {
  rendah: 70,
  tinggi: 95,
  bobotS: 0.7,
  bobotAsts: 0.15,
  bobotAsat: 0.15,
  ambang: 85,
  batasTh: 10,
  patokTh: 70,
  bonusKarakter: 10,
  modeSkala: "murni",
  modeTh: "bertingkat",
};

export function lengkapiPengaturan(
  p: PengaturanHitung | null | undefined
): Required<PengaturanHitung> {
  return { ...DEFAULT_PENGATURAN, ...(p ?? {}) };
}

export interface NilaiMentah {
  /** Nilai S1..S5 mentah (0-100), null bila kosong. */
  s: (number | null)[];
  asts: number | null;
  asat: number | null;
  /** Total Tidak Hadir (hari). null = belum diisi = 0. */
  th: number | null;
  /** "" / null = biasa, "A" = Amat Baik. */
  karakter: string | null;
  catatan?: string | null;
}

export interface Tp {
  kode: string; // "S1".."S5"
  teks: string;
}

export interface BatasLingkup {
  nrMin: number | null;
  nrMax: number | null;
  tpMin: number | null;
  tpMax: number | null;
}

export interface HasilHitung {
  rtS: number | null;
  nr: number | null;
  /** NA sebelum patok TH & bonus A (null bila NR null). */
  naSkala: number | null;
  na: number | null;
  predikat: string | null;
  tpTertinggi: string[]; // kode TP, mis. ["S2","S3"]
  tpTerendah: string[];
  deskripsiTertinggi: string;
  deskripsiTerendah: string;
  deskripsi: string;
  char: number;
}

/** Skala linear satu nilai ke [rendah, tinggi]. */
export function skala(
  x: number,
  min: number,
  max: number,
  rendah: number,
  tinggi: number
): number {
  if (x > tinggi) return x;
  if (min === max) return Math.round(x); // hindari bagi nol
  return Math.round(rendah + ((x - min) / (max - min)) * (tinggi - rendah));
}

export function predikatUntuk(na: number | null): string | null {
  if (na === null || Number.isNaN(na)) return null;
  if (na >= 90) return "Amat Baik";
  if (na >= 80) return "Baik";
  if (na >= 70) return "Cukup";
  return "Kurang";
}

function isiS(n: NilaiMentah): number[] {
  return (n.s ?? []).filter(
    (v): v is number => typeof v === "number" && !Number.isNaN(v)
  );
}

export function hitungRtS(n: NilaiMentah): number | null {
  const v = isiS(n);
  if (!v.length) return null;
  return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
}

export function hitungNr(
  n: NilaiMentah,
  cfg: Required<PengaturanHitung>
): { rtS: number | null; nr: number | null } {
  const rtS = hitungRtS(n);
  if (rtS === null || n.asts === null || n.asts === undefined || n.asat === null || n.asat === undefined)
    return { rtS, nr: null };
  const nr =
    Math.round(
      (rtS * cfg.bobotS + n.asts * cfg.bobotAsts + n.asat * cfg.bobotAsat) * 100
    ) / 100;
  return { rtS, nr };
}

/**
 * Hitung batas MIN/MAX sebuah lingkup dari baris-baris nilai mentah
 * dalam lingkup itu. `nrList` = NR tiap baris (hanya yang terisi),
 * `tpList` = semua nilai S mentah yang terisi.
 */
export function hitungBatas(
  nrList: number[],
  tpList: number[],
  cfg: Required<PengaturanHitung>
): BatasLingkup {
  if (!nrList.length && !tpList.length)
    return { nrMin: null, nrMax: null, tpMin: null, tpMax: null };
  const jumlahBobot = cfg.bobotS + cfg.bobotAsts + cfg.bobotAsat;
  const bobotTerkecil = Math.min(cfg.bobotS, cfg.bobotAsts, cfg.bobotAsat);
  let nrMin: number | null = null;
  let nrMax: number | null = null;
  let tpMin: number | null = null;
  let tpMax: number | null = null;
  if (nrList.length) {
    const lo = Math.min(...nrList);
    const hi = Math.max(...nrList);
    if (cfg.modeSkala === "excel") {
      nrMin = Math.min(jumlahBobot, lo);
      nrMax = hi;
    } else {
      nrMin = lo;
      nrMax = hi;
    }
  }
  if (tpList.length) {
    const lo = Math.min(...tpList);
    const hi = Math.max(...tpList);
    if (cfg.modeSkala === "excel") {
      tpMin = Math.min(bobotTerkecil, lo);
      tpMax = Math.max(cfg.tinggi, hi);
    } else {
      tpMin = lo;
      tpMax = hi;
    }
  }
  return { nrMin, nrMax, tpMin, tpMax };
}

/** Hitung satu murid. `batas` harus berasal dari lingkup yang sama. */
export function hitungSatu(
  n: NilaiMentah,
  tpList: Tp[],
  batas: BatasLingkup,
  cfgIn?: PengaturanHitung
): HasilHitung {
  const cfg = lengkapiPengaturan(cfgIn);
  const { rtS, nr } = hitungNr(n, cfg);

  let naSkala: number | null = null;
  let na: number | null = null;
  if (nr !== null && batas.nrMin !== null && batas.nrMax !== null) {
    naSkala = skala(nr, batas.nrMin, batas.nrMax, cfg.rendah, cfg.tinggi);
    na = naSkala;
    // 1) Aturan TH — "bertingkat" (default, keputusan Pak Gun 19 Nov 2026,
    //    opsi B) atau "patok" (aturan Excel lama: TH > batas -> patok).
    const th = n.th ?? 0;
    na = terapkanTh(naSkala, th, cfg);
    // 2) Bonus Karakter A ("Amat Baik").
    if ((n.karakter ?? "") === "A") na = Math.min(99, na + cfg.bonusKarakter);
  }

  // Deskripsi per TP.
  const tpTertinggi: string[] = [];
  const tpTerendah: string[] = [];
  const teksTertinggi: string[] = [];
  const teksTerendah: string[] = [];
  if (batas.tpMin !== null && batas.tpMax !== null) {
    tpList.forEach((tp, i) => {
      const v = n.s?.[i];
      if (typeof v !== "number" || Number.isNaN(v)) return;
      const hasil = skala(v, batas.tpMin!, batas.tpMax!, cfg.rendah, cfg.tinggi);
      if (hasil > cfg.ambang) {
        tpTertinggi.push(tp.kode);
        teksTertinggi.push(tp.teks);
      } else {
        tpTerendah.push(tp.kode);
        teksTerendah.push(tp.teks);
      }
    });
  }
  const deskripsiTertinggi = teksTertinggi.length
    ? "Murid sangat baik dalam " + teksTertinggi.join(", ")
    : "";
  const deskripsiTerendah = teksTerendah.length
    ? "Murid perlu peningkatan kemampuan " + teksTerendah.join(", ")
    : "";
  const deskripsi = [deskripsiTertinggi, deskripsiTerendah]
    .filter(Boolean)
    .join(" ");

  return {
    rtS,
    nr,
    naSkala,
    na,
    predikat: predikatUntuk(na),
    tpTertinggi,
    tpTerendah,
    deskripsiTertinggi,
    deskripsiTerendah,
    deskripsi,
    char: deskripsi.length,
  };
}

/**
 * Hitung seluruh baris dalam satu lingkup: batas dihitung dari baris itu
 * sendiri, lalu tiap baris dihitung dengan batas yang sama.
 */
export function hitungLingkup(
  baris: { nilai: NilaiMentah }[],
  tpList: Tp[],
  cfgIn?: PengaturanHitung
): { batas: BatasLingkup; hasil: HasilHitung[] } {
  const cfg = lengkapiPengaturan(cfgIn);
  const nrList: number[] = [];
  const tpValues: number[] = [];
  for (const b of baris) {
    const { nr } = hitungNr(b.nilai, cfg);
    if (nr !== null) nrList.push(nr);
    for (const v of isiS(b.nilai)) tpValues.push(v);
  }
  const batas = hitungBatas(nrList, tpValues, cfg);
  return { batas, hasil: baris.map((b) => hitungSatu(b.nilai, tpList, batas, cfg)) };
}
