import { describe, test, expect } from "bun:test";
import {
  hitungLingkup,
  hitungSatu,
  hitungBatas,
  skala,
  DEFAULT_PENGATURAN,
  type NilaiMentah,
  type Tp,
} from "./hitung";

// Cache Excel (data_only) untuk 22 murid kelas 7.1, sheet '7' baris 10-31.
// Diambil langsung dari DAFNIL.xlsx -> data/excel-cache-22.json.
const CACHE = JSON.parse(
  await Bun.file(new URL("../data/excel-cache-22.json", import.meta.url)).text()
) as {
  nama: string;
  s: (number | null)[];
  asts: number | null;
  asat: number | null;
  nr: number;
  na: number;
  th: number | null;
  karakter: string | null;
  tinggi: string[];
  rendah: string[];
}[];

const TP: Tp[] = [
  { kode: "S1", teks: "menentukan hasil operasi hitung bilangan bulat." },
  { kode: "S2", teks: "menyelesaikan permasalahan bilangan bulat." },
  {
    kode: "S3",
    teks: "menyelesaikan permasalahan kontekstual yang terkait literasi finansial",
  },
];

function mentah(r: (typeof CACHE)[number]): NilaiMentah {
  return {
    s: [r.s[0], r.s[1], r.s[2], null, null],
    asts: r.asts,
    asat: r.asat,
    th: r.th,
    karakter: r.karakter,
  };
}

describe("kecocokan dengan cache Excel (lingkup per kelas, 22 murid 7.1)", () => {
  test("mode excel: NA sama persis 22/22", () => {
    const { hasil } = hitungLingkup(
      CACHE.map((r) => ({ nilai: mentah(r) })),
      TP,
      { modeSkala: "excel" }
    );
    const beda = CACHE.map((r, i) => ({ nama: r.nama, hitung: hasil[i].na, excel: r.na })).filter(
      (x) => x.hitung !== x.excel
    );
    expect(beda).toEqual([]);
    expect(hasil.map((h) => h.na)).toEqual(CACHE.map((r) => r.na));
  });

  test("mode excel: klasifikasi deskripsi P/Q sama 22/22", () => {
    const { hasil } = hitungLingkup(
      CACHE.map((r) => ({ nilai: mentah(r) })),
      TP,
      { modeSkala: "excel" }
    );
    for (let i = 0; i < CACHE.length; i++) {
      expect(hasil[i].tpTertinggi).toEqual(CACHE[i].tinggi);
      expect(hasil[i].tpTerendah).toEqual(CACHE[i].rendah);
    }
  });

  test("contoh bernama dari tugas", () => {
    const { hasil } = hitungLingkup(
      CACHE.map((r) => ({ nilai: mentah(r) })),
      TP,
      { modeSkala: "excel" }
    );
    const cari = (nama: string) => hasil[CACHE.findIndex((r) => r.nama === nama)];
    expect(cari("ADITYA PRATAMA").nr).toBe(65.2);
    expect(cari("ADITYA PRATAMA").na).toBe(88);
    expect(cari("ADJIE MAHESSA GALIH").na).toBe(95);
    expect(cari("AFIF SYADID WAFIDIN").na).toBe(70); // TH 30 -> patok 70
    expect(cari("AGUSTIANA MONIKA WIBOWO").na).toBe(97); // Karakter A +10
    expect(cari("AHMAD VITO DARMAWAN").na).toBe(94); // Karakter A +10
    expect(cari("ADITYA PRATAMA").tpTertinggi).toEqual(["S2", "S3"]);
    expect(cari("ADITYA PRATAMA").tpTerendah).toEqual(["S1"]);
  });

  test("mode murni MENGUBAH NA (didokumentasikan, bukan bug) — hanya 2/22 sama", () => {
    const { hasil } = hitungLingkup(
      CACHE.map((r) => ({ nilai: mentah(r) })),
      TP,
      { modeSkala: "murni" }
    );
    const sama = CACHE.filter((r, i) => hasil[i].na === r.na).length;
    expect(sama).toBe(2);
    // Contoh perubahannya: Aditya 88 -> 86.
    expect(hasil[0].na).toBe(86);
  });
});

describe("kasus tepi", () => {
  const cfg = { modeSkala: "excel" as const };
  test("satu murid saja dalam lingkup (min==max tidak bagi nol)", () => {
    const satu: NilaiMentah = { s: [80, 80, 80, null, null], asts: 80, asat: 80, th: 0, karakter: null };
    const { hasil } = hitungLingkup([{ nilai: satu }], TP, cfg);
    // NR = 80; batas excel: nrMin=min(1,80)=1, nrMax=80 -> skala normal.
    expect(hasil[0].nr).toBe(80);
    expect(hasil[0].na).toBe(95);
    // Mode murni satu murid: min==max -> skala mengembalikan ROUND(x).
    const murni = hitungLingkup([{ nilai: satu }], TP, { modeSkala: "murni" });
    expect(murni.hasil[0].na).toBe(80);
  });

  test("ASTS/ASAT kosong -> NR/NA kosong (bukan 0)", () => {
    const n: NilaiMentah = { s: [80, 80, 80, null, null], asts: null, asat: 70, th: 0, karakter: null };
    const { hasil } = hitungLingkup([{ nilai: n }], TP, cfg);
    expect(hasil[0].rtS).toBe(80);
    expect(hasil[0].nr).toBeNull();
    expect(hasil[0].na).toBeNull();
  });

  test("TH=10 tidak dipatok, TH=11 dipatok 70", () => {
    const dasar: NilaiMentah = { s: [90, 90, 90, null, null], asts: 90, asat: 90, th: 10, karakter: null };
    // Batas dihitung dengan konfigurasi yang sama dengan cfg (excel);
    // DEFAULT_PENGATURAN kini "murni" (keputusan Pak Gun 18 Nov 2026).
    const batas = hitungBatas([90], [90, 90, 90], { ...DEFAULT_PENGATURAN, modeSkala: "excel" });
    expect(hitungSatu(dasar, TP, batas, cfg).na).toBe(95);
    expect(hitungSatu({ ...dasar, th: 11 }, TP, batas, cfg).na).toBe(70);
  });

  test("Karakter A dengan NA 95 -> 99, bukan 105", () => {
    const n: NilaiMentah = { s: [90, 90, 90, null, null], asts: 90, asat: 90, th: 0, karakter: "A" };
    const batas = hitungBatas([90], [90, 90, 90], { ...DEFAULT_PENGATURAN, modeSkala: "excel" });
    expect(hitungSatu(n, TP, batas, cfg).na).toBe(99);
  });

  test("skala: x > tinggi dikembalikan apa adanya; min==max -> ROUND(x)", () => {
    expect(skala(97, 10, 90, 70, 95)).toBe(97);
    expect(skala(80, 80, 80, 70, 95)).toBe(80);
  });

  test("deskripsi kosong bila tidak ada nilai S", () => {
    const n: NilaiMentah = { s: [null, null, null, null, null], asts: null, asat: null, th: 0, karakter: null };
    const { hasil } = hitungLingkup([{ nilai: n }], TP, cfg);
    expect(hasil[0].deskripsi).toBe("");
    expect(hasil[0].char).toBe(0);
  });
});
