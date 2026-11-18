-- GezyDafnil — migrasi 001: skema awal
-- Dialek MariaDB. Dijalankan berurutan oleh db.ts (runMigrations); setiap
-- berkas dicatat di tabel `migrations` sehingga idempotent.
-- Tabel dan nama kolom sama seperti versi SQLite sebelumnya, hanya tipe
-- yang disesuaikan (AUTO_INCREMENT, VARCHAR/TEXT, DECIMAL, DATETIME,
-- BIGINT untuk expires_at dalam milidetik epoch — sama seperti sebelumnya).

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'guru')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guru (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  nama VARCHAR(255) NOT NULL,
  nip VARCHAR(50),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mapel (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nama VARCHAR(255) NOT NULL,
  kode VARCHAR(20) NOT NULL UNIQUE,
  aktif TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS kelas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nama VARCHAR(20) NOT NULL UNIQUE, -- "7.1", "8.2", ...
  tingkat VARCHAR(5) NOT NULL       -- "7", "8", "9"
);

CREATE TABLE IF NOT EXISTS siswa (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nisn VARCHAR(50) NOT NULL UNIQUE, -- TEKS: ada yang berawalan 0 / berisi "/"
  nama VARCHAR(255) NOT NULL,
  lp VARCHAR(5) CHECK (lp IN ('L', 'P')),
  kelas_id INT NOT NULL,
  FOREIGN KEY (kelas_id) REFERENCES kelas(id),
  INDEX idx_siswa_kelas (kelas_id)
);

CREATE TABLE IF NOT EXISTS tp (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mapel_id INT NOT NULL,
  tingkat VARCHAR(5) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  tahun_ajaran VARCHAR(20) NOT NULL,
  kode VARCHAR(10) NOT NULL,         -- "S1".."S5"
  teks TEXT NOT NULL,
  urutan INT NOT NULL DEFAULT 0,
  UNIQUE (mapel_id, tingkat, semester, tahun_ajaran, kode),
  FOREIGN KEY (mapel_id) REFERENCES mapel(id)
);

CREATE TABLE IF NOT EXISTS guru_mapel (
  guru_id INT NOT NULL,
  mapel_id INT NOT NULL,
  kelas_id INT NOT NULL,
  PRIMARY KEY (guru_id, mapel_id, kelas_id),
  FOREIGN KEY (guru_id) REFERENCES guru(id) ON DELETE CASCADE,
  FOREIGN KEY (mapel_id) REFERENCES mapel(id) ON DELETE CASCADE,
  FOREIGN KEY (kelas_id) REFERENCES kelas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pengaturan (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mapel_id INT NOT NULL,
  semester VARCHAR(20) NOT NULL,
  tahun_ajaran VARCHAR(20) NOT NULL,
  rendah DECIMAL(5,2) NOT NULL DEFAULT 70,
  tinggi DECIMAL(5,2) NOT NULL DEFAULT 95,
  bobot_s DECIMAL(5,2) NOT NULL DEFAULT 0.70,
  bobot_asts DECIMAL(5,2) NOT NULL DEFAULT 0.15,
  bobot_asat DECIMAL(5,2) NOT NULL DEFAULT 0.15,
  ambang DECIMAL(5,2) NOT NULL DEFAULT 85,
  batas_th INT NOT NULL DEFAULT 10,
  patok_th DECIMAL(5,2) NOT NULL DEFAULT 70,
  bonus_karakter DECIMAL(5,2) NOT NULL DEFAULT 10,
  hari_efektif INT NOT NULL DEFAULT 110,
  mode_skala VARCHAR(20) NOT NULL DEFAULT 'excel' CHECK (mode_skala IN ('excel', 'murni')),
  mode_th VARCHAR(20) NOT NULL DEFAULT 'patok' CHECK (mode_th IN ('patok')),
  UNIQUE (mapel_id, semester, tahun_ajaran),
  FOREIGN KEY (mapel_id) REFERENCES mapel(id)
);

CREATE TABLE IF NOT EXISTS nilai (
  siswa_id INT NOT NULL,
  mapel_id INT NOT NULL,
  tahun_ajaran VARCHAR(20) NOT NULL,
  semester VARCHAR(20) NOT NULL,
  s1 DECIMAL(5,2), s2 DECIMAL(5,2), s3 DECIMAL(5,2), s4 DECIMAL(5,2), s5 DECIMAL(5,2),
  asts DECIMAL(5,2), asat DECIMAL(5,2),
  th INT NOT NULL DEFAULT 0,
  karakter VARCHAR(5) NOT NULL DEFAULT '',
  catatan TEXT NOT NULL DEFAULT '',
  updated_by INT,
  updated_at DATETIME,
  PRIMARY KEY (siswa_id, mapel_id, tahun_ajaran, semester),
  FOREIGN KEY (siswa_id) REFERENCES siswa(id) ON DELETE CASCADE,
  FOREIGN KEY (mapel_id) REFERENCES mapel(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at BIGINT NOT NULL, -- epoch milidetik, sama seperti versi SQLite
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  waktu DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT,
  username VARCHAR(100),
  peran VARCHAR(20),
  aksi VARCHAR(100) NOT NULL,
  detail TEXT,
  ip VARCHAR(64),
  INDEX idx_log_waktu (waktu)
);
