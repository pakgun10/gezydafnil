"""Ekstrak data seed GezyDafnil dari DAFNIL.xlsx (openpyxl, baca saja).

Sumber: ~/workspace/user/files/DAFNIL.xlsx
- Sheet '7','8','9': daftar murid (NISN disimpan sebagai TEKS — ada yang
  berawalan 0 dan ada yang berisi "/" di sheet 8/9, mis. "0125774157/10127").
- Sheet '7' baris 10-31: 22 murid kelas 7.1 yang sudah bernilai S1-S3 +
  ASTS + ASAT (1 murid TH=30, 2 murid Karakter=A).
- Sheet 'DESK' DIABAIKAN (versi lama rusak, merujuk sheet NILAI yang tak ada).
- Sheet '8'/'9': murid tetap diimpor, nilainya belum ada.
Keluaran: data/seed-dafnil.json (dipakai seed.ts, idempotent).
Jalankan: python3 scripts/extract-dafnil.py
"""
import json
import openpyxl
from pathlib import Path

SRC = Path.home() / "workspace/user/files/DAFNIL.xlsx"
OUT = Path(__file__).resolve().parent.parent / "data" / "seed-dafnil.json"

wb = openpyxl.load_workbook(SRC, data_only=True)

murid = []  # {nisn, nama, lp, kelas}
nilai = []  # {nisn, s1, s2, s3, s4, s5, asts, asat, th, karakter}
for sheet in ["7", "8", "9"]:
    ws = wb[sheet]
    for r in range(10, ws.max_row + 1):
        nama = ws.cell(r, 2).value
        if not nama:
            continue
        nisn = str(ws.cell(r, 5).value).strip()
        kelas = str(ws.cell(r, 4).value).strip()
        murid.append({
            "nisn": nisn,
            "nama": str(nama).strip(),
            "lp": (ws.cell(r, 3).value or "").strip() or None,
            "kelas": kelas,
        })
        vals = [ws.cell(r, c).value for c in range(6, 14)]  # S1..S5, RT-S, ASTS, ASAT
        s = vals[:5]
        asts, asat = vals[6], vals[7]
        if any(v is not None for v in s + [asts, asat]):
            nilai.append({
                "nisn": nisn,
                "s1": s[0], "s2": s[1], "s3": s[2], "s4": s[3], "s5": s[4],
                "asts": asts, "asat": asat,
                "th": ws.cell(r, 19).value,
                "karakter": ws.cell(r, 20).value,
                "catatan": ws.cell(r, 21).value,
            })

tp7 = []
ws7 = wb["7"]
for r in range(2, 7):
    teks = ws7.cell(r, 12).value
    if teks:
        tp7.append({"kode": ws7.cell(r, 11).value, "teks": str(teks).strip()})

data = {
    "mapel": "Matematika",
    "semester": "Ganjil",
    "tahun_ajaran": "2026/2027",
    "hari_efektif": 110,
    "tp_kelas_7": tp7,
    "murid": murid,
    "nilai_kelas_7_1": nilai,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"murid: {len(murid)}  nilai: {len(nilai)}  TP kelas 7: {len(tp7)}")
print(f"-> {OUT}")
