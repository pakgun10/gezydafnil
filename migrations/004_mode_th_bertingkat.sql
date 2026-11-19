-- 004: aturan TH bertingkat menjadi default (keputusan Pak Gun 19 Nov 2026, opsi B).
-- Kolom mode_th sudah disiapkan sejak 001_init.sql ('patok' saja); kini
-- diizinkan 'bertingkat' dan dijadikan default untuk instalasi baru DAN
-- baris pengaturan yang sudah ada.
ALTER TABLE pengaturan
  MODIFY mode_th VARCHAR(20) NOT NULL DEFAULT 'bertingkat'
  CHECK (mode_th IN ('patok', 'bertingkat'));
UPDATE pengaturan SET mode_th = 'bertingkat' WHERE mode_th = 'patok';
