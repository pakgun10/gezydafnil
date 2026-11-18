# GezyDafnil

Daftar nilai & deskripsi raport otomatis — SMP Negeri 1 Punggur.
Prinsip: (1) input nilai murid apa adanya, (2) input Tujuan Pembelajaran (TP),
(3) deskripsi raport muncul otomatis.

Stack: **Bun 1.4.4 + Hono + MariaDB** (driver `mysql2/promise`, satu proses,
tanpa Docker). Port **3103** (GezyView 3101, GezyKomen 3102). Login mengikuti
pola GezyRaport (username + kata sandi, argon2id, cookie sesi HttpOnly 7 hari);
**tanpa SSO di v1** — SSO menyusul sebagai proyek terpisah.

## Menjalankan lokal

```bash
# 1. MariaDB lokal (VM ini instalasi manual, BUKAN service apt):
#    pastikan mariadbd jalan; bila belum:
mkdir -p /run/mysqld
/home/hatch/mariadb-10.11.13/bin/mariadbd --defaults-file=/home/hatch/mariadb-manual.cnf --user=root &
#    (tidak selamat dari reboot VM — start ulang manual bila perlu)

# 2. Dependensi + database + user (sekali saja):
cp .env.example .env        # isi DB_PASSWORD yang kuat
bun install
bun run setup-db            # sebagai root OS: buat DB gezydafnil + gezydafnil_test + user gezydafnil
bun run migrate             # terapkan migrations/001_init.sql, 002_wali_periode.sql
bun run seed                # admin + 788 murid + TP + 22 nilai dari DAFNIL.xlsx (idempotent)

# 3. Jalan:
bun start                   # http://localhost:3103
bun test                    # unit test rumus (lib/hitung.test.ts)
bun run verify              # verifikasi isi MariaDB + NA/deskripsi vs Excel
bun run verify-crud         # verifikasi CRUD + export/import lewat HTTP (server harus jalan)
```

### Variabel env (`.env`, JANGAN di-commit)

| Variabel | Default | Keterangan |
|---|---|---|
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | Host/port MariaDB |
| `DB_USER` | `gezydafnil` | User aplikasi (hak penuh hanya atas DB-nya) |
| `DB_PASSWORD` | — (wajib diisi) | Kata sandi user MariaDB |
| `DB_NAME` | `gezydafnil` | Database aplikasi |
| `TEST_DB_NAME` | `gezydafnil_test` | Database pengujian |
| `PORT` | `3103` | Port aplikasi |

### Akun default

- Username `admin`, kata sandi `admin123`.
- **SEGERA GANTI kata sandi admin setelah login pertama** (Admin → Kelola Guru →
  ganti kata sandi, atau buat akun admin baru lalu hapus yang lama). Jangan
  dipakai di produksi apa adanya. Akun guru baru: kata sandi awal = username
  (pola GezyRaport), guru wajib menggantinya setelah login pertama.

## Data awal (seed dari `~/workspace/user/files/DAFNIL.xlsx`)

- **788 murid** (kelas 7.1–7.8 = 256, 8.1–8.8 = 271, 9.1–9.8 = 261),
  NISN disimpan sebagai **TEKS** (ada yang berawalan 0 dan berisi `/`).
- Mapel **Matematika**, Semester **Ganjil 2026/2027**, hari efektif **110**.
- TP kelas 7: S1 "menentukan hasil operasi hitung bilangan bulat.",
  S2 "menyelesaikan permasalahan bilangan bulat.",
  S3 "menyelesaikan permasalahan kontekstual yang terkait literasi finansial".
- **22 murid kelas 7.1** sudah bernilai S1–S3 + ASTS + ASAT
  (1 murid TH=30, 2 murid Karakter=A).
- Sheet `DESK` diabaikan (versi lama rusak, merujuk sheet NILAI yang tidak ada);
  sheet `8`/`9` muridnya tetap diimpor, nilainya belum ada.
- Ekstrak ulang dari Excel: `python3 scripts/extract-dafnil.py` →
  `data/seed-dafnil.json`, lalu `bun run seed`.

## Rumus (satu-satunya sumber: `lib/hitung.ts`)

Per murid, per mapel, per semester:

- **RT-S** = ROUND(rata-rata nilai S yang terisi).
- **NR** = ROUND(0,7×RT-S + 0,15×ASTS + 0,15×ASAT, 2) — hanya bila RT-S, ASTS,
  ASAT ketiganya terisi (perbaikan dari Excel yang menganggap kosong = 0).
- **Skala** `skala(x, min, max, rendah=70, tinggi=95)`: x bila x > tinggi,
  bila tidak ROUND(70 + (x−min)/(max−min)×25). Bila min == max, kembalikan
  ROUND(x) (hindari bagi nol).
- **NA** = skala(NR) → bila TH > batas TH (default 10) dipatok ke 70 →
  bila Karakter "A" (Amat Baik) ditambah 10, maks 99. Urutan ini wajib.
- **Deskripsi per TP**: tiap nilai S dikonversi dengan skala yang sama;
  hasil > ambang (85) → "Murid sangat baik dalam …", ≤ ambang →
  "Murid perlu peningkatan kemampuan …". Deskripsi final = gabungan keduanya;
  CHAR = panjang deskripsi final.
- **Lingkup konversi**: default **per kelas**; di Input/Rekap bisa memilih
  gabungan beberapa kelas dalam satu tingkat (mis. 7.1+7.2). MIN/MAX dihitung
  dari nilai yang terisi dalam lingkup; NA **tidak disimpan permanen** —
  selalu dihitung ulang dari nilai mentah, jadi ganti lingkup langsung
  mengubah hasil.
- **Predikat**: ≥90 Amat Baik, 80–89 Baik, 70–79 Cukup, <70 Kurang.

### Mode skala — keputusan Pak Gun (18 Nov 2026, 20.39 WIB): `murni`

Ada dua mode (pengaturan per mapel+semester, default **`murni`**):

- `murni` (default): MIN/MAX hanya dari nilai yang terisi.
  Mode ini **mengubah NA dibanding file Excel** — hanya 2/22 yang sama
  dengan cache Excel (mis. Aditya NR 65,2 → 86, bukan 88), karena angka
  di file dihitung dengan quirk kolom penuh (lihat mode `excel`).
- `excel` (setia pada file): batas MIN/MAX efektif sama seperti rumus
  kolom penuh Excel — MIN(N:N) ikut menghitung sel N8 = jumlah bobot (=1) dan
  MIN/MAX(F:J) ikut menghitung bobot terkecil (0,15) dan batas atas (95).
  Dengan mode ini **NA 22/22 dan deskripsi 22/22 sama persis dengan cache Excel**.
  Tetap tersedia per mapel+semester bila ingin membandingkan dengan file lama.

## Fitur

- **Login** admin & guru (tanpa siswa). NIP hanya identitas, bukan kata sandi.
- **Pengaturan** (wizard 4 langkah): Profil Guru → Konteks Ajar & Rumus
  (rentang, bobot, ambang, batas TH, hari efektif, mode skala) → TP → Murid.
- **Input Nilai**: kartu per murid (satu murid satu layar), keyboard numerik,
  simpan otomatis per field, tombol Sebelumnya/Berikutnya, progres terisi,
  pencarian nama. Kolom: S1–S5, ASTS, ASAT, TH (Total Tidak Hadir),
  Karakter (A = Amat Baik), Catatan.
- **Deskripsi**: pratinjau live per murid, tombol Salin, penghitung CHAR.
- **Rekap**: per kelas×mapel (NA, predikat), unduh CSV
  (NISN, Nama, S1–S5, RT-S, ASTS, ASAT, NR, NA, TH, Karakter, Deskripsi).
- **Master Data** (`/master.html`, admin saja): CRUD manual lengkap untuk
  Guru, Murid, Kelas, Mapel, Periode, TP, Pengaturan — semua bisa dipakai
  dari HP. Termasuk:
  - Guru: nama, NIP, mapel yang diampu (kelas×mapel), username + kata sandi.
    Hapus guru **ditolak** bila masih mengampu kelas atau pernah menyimpan
    nilai (lepas dulu tugasnya).
  - Murid: NISN (teks), Nama, L/P, pindah kelas. Hapus ditolak bila sudah
    punya nilai.
  - Kelas: nama (7.1), tingkat, wali kelas opsional. Hapus ditolak bila masih
    berisi murid/penugasan.
  - Mapel/Periode/TP/Pengaturan: hapus ditolak bila masih dipakai data lain.
  - **Export/Import CSV per master**: template bisa diunduh; impor validasi
    per baris — baris valid masuk/diubah, baris gagal ditolak dengan daftar
    kesalahan (nomor baris + alasan). Impor murid dari DAFNIL.xlsx lewat
    `bun run seed` (atau `scripts/extract-dafnil.py` + seed).
- **Batas guru**: guru hanya melihat/mengisi nilai untuk mapel & kelas yang
  diampunya (tabel `guru_mapel`); CRUD master data hanya admin. Pengecualian
  lewat wizard Pengaturan: guru boleh menyimpan rumus & TP untuk mapel yang
  diampunya, dan menambah murid di kelas yang diampunya — di luar itu server
  menolak dengan 403.
- **Admin**: kelola akun guru, ganti kata sandi sendiri, Backup & Restore JSON
  (termasuk hash kata sandi), Log Aktivitas.

## Struktur

```
server.ts            Hono + API JSON + file statis (port 3103)
db.ts                pool mysql2, configFromEnv, helper one/all/run, runMigrations
auth.ts              sesi cookie "sesi" HttpOnly 7 hari, requireRole
util.ts              catatLog, parseCSV, helper CSV
lib/hitung.ts        rumus murni (RT-S/NR/skala/NA/deskripsi) + hitungLingkup
lib/hitung.test.ts   unit test rumus vs cache Excel (10 tes)
seed.ts              seed idempotent dari data/seed-dafnil.json
scripts/
  extract-dafnil.py  DAFNIL.xlsx -> data/seed-dafnil.json (openpyxl)
  setup-db.ts        buat DB + user MariaDB (root via unix socket)
  migrate.ts         jalankan migrasi yang belum diterapkan
  verify.ts          verifikasi isi DB + NA/deskripsi vs Excel
  verify-crud.ts     verifikasi CRUD + export/import lewat HTTP
migrations/          001_init.sql, 002_wali_periode.sql
public/              login, beranda, pengaturan, input, deskripsi, rekap,
                     admin, master + js/common.js + css/style.css
ops/systemd/         gezydafnil.service (contoh unit systemd)
data/                seed-dafnil.json, excel-cache-22.json (fixture uji)
```

## Deploy VPS (di tangan Pak Gun)

```bash
# Di VPS (MariaDB + Node/Bun sudah terpasang, pola GezyView/GezyCBT):
# 1. MariaDB: buat DB + user (ganti kata sandi):
sudo mariadb -e "CREATE DATABASE gezydafnil CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mariadb -e "CREATE USER 'gezydafnil'@'127.0.0.1' IDENTIFIED BY 'KATA-SANDI-KUAT';"
sudo mariadb -e "GRANT ALL PRIVILEGES ON gezydafnil.* TO 'gezydafnil'@'127.0.0.1'; FLUSH PRIVILEGES;"
# 2. Kode:
sudo mkdir -p /opt/gezydafnil && sudo chown $USER:$USER /opt/gezydafnil
git clone <repo> /opt/gezydafnil && cd /opt/gezydafnil
bun install
# 3. Env (JANGAN commit): salin .env.example ke /etc/gezydafnil.env dan isi
#    DB_PASSWORD + PORT=3103 (lihat ops/systemd/gezydafnil.service).
# 4. Migrasi + seed:
bun run migrate && bun run seed
# 5. Service + nginx:
sudo cp ops/systemd/gezydafnil.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gezydafnil
#    nginx: reverse proxy ke 127.0.0.1:3103 (contoh di bawah), lalu certbot.
```

Contoh nginx (sesuaikan domain):

```nginx
server {
    listen 80;
    server_name dafnil.pakgun.web.id;
    location / {
        proxy_pass http://127.0.0.1:3103;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Backup: Admin → Unduh Backup JSON (berkala). Restore: Admin → Pulihkan
(menimpa semua data — hati-hati).

## Verifikasi (lokal, 18 Nov 2026)

- `bun test`: **10/10 lolos** (NA 22/22, deskripsi 22/22 vs Excel, kasus tepi).
- `bun run verify` (MariaDB): murid 788, kelas 24, TP 3, nilai 22, admin ada;
  NA 22/22, deskripsi 22/22; Aditya NR 65,2 → NA 88; Adjie → 95;
  Afif TH 30 → 70; Agustiana A → 97; Vito A → 94.
- `bun run verify-crud` (HTTP, port 3103): **27/27 lolos** — tambah guru,
  kelas 7.9, murid, ubah, export CSV murid → ubah nama → import (diubah 1),
  import campuran (1 baris benar masuk, 1 baris salah L/P ditolak dengan
  alasan), hapus guru ditolak saat mengampu lalu berhasil setelah tugas
  dilepas, hapus murid + kelas, guru ditolak akses kelas 7.2 (403) dan CRUD
  master (403), guru bisa akses 7.1 (32 baris), NA via API 22/22.
  Data uji dibersihkan lagi (users=1 admin, siswa=788, kelas=24, nilai=22).
- Tambahan: impor guru (1 masuk, 1 gagal — mapel tak dikenal, alasan jelas);
  impor pengaturan (ambang 86 → kembali 85); semua halaman utama 200 saat
  login (login, beranda, pengaturan, input, deskripsi, rekap, admin, master);
  `/api/me` tanpa login 401; login kata sandi salah 401.

## Pertanyaan untuk Pak Gun (mengubah hasil — jangan ditebak)

1. **Mode skala**: SUDAH DIPUTUSKAN Pak Gun 18 Nov 2026, 20.39 WIB — pakai
   `murni` (default; migrasi 003 mengubah baris pengaturan yang ada).
   Mode `excel` tetap tersedia per mapel+semester untuk perbandingan.
2. **Aturan TH bertingkat**: saat ini mode "patok" (TH > 10 → NA dipatok 70,
   seperti Excel). Apakah mau bertingkat (mis. makin banyak tidak hadir makin
   besar potongan)? Bila ya, perlu batas dan potongannya.
3. **SSO**: tetap proyek terpisah setelah live (sudah disepakati).
