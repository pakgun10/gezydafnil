-- 003: mode skala default menjadi 'murni' (keputusan Pak Gun 18 Nov 2026).
-- Mengubah default kolom untuk instalasi baru DAN baris pengaturan yang
-- sudah ada (yang ter-seed dengan default 'excel' dari 001_init.sql).
ALTER TABLE pengaturan
  MODIFY mode_skala VARCHAR(20) NOT NULL DEFAULT 'murni'
  CHECK (mode_skala IN ('excel', 'murni'));
UPDATE pengaturan SET mode_skala = 'murni' WHERE mode_skala = 'excel';
