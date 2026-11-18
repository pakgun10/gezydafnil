-- GezyDafnil — migrasi 002: wali kelas + periode (semester/tahun ajaran)
-- Wali kelas opsional di tabel kelas; periode menjadi master data sendiri
-- (sebelumnya semester/tahun ajaran hanya string bebas di TP/pengaturan).

ALTER TABLE kelas ADD COLUMN wali_guru_id INT NULL AFTER tingkat;
ALTER TABLE kelas ADD CONSTRAINT fk_kelas_wali
  FOREIGN KEY (wali_guru_id) REFERENCES guru(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS periode (
  id INT AUTO_INCREMENT PRIMARY KEY,
  semester VARCHAR(20) NOT NULL,
  tahun_ajaran VARCHAR(20) NOT NULL,
  aktif TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE (semester, tahun_ajaran)
);

-- Periode berjalan dari seed awal.
INSERT IGNORE INTO periode (semester, tahun_ajaran, aktif)
VALUES ('Ganjil', '2026/2027', 1);
