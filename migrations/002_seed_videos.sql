-- Seed all 14 slugs up front so QR codes can be generated before any file exists.
-- INSERT IGNORE never overwrites a row that already exists (e.g. a title the
-- customer edited later).
-- Slugs must not change after their QR is printed ('ecard-lee' is already printed).
INSERT IGNORE INTO videos (slug, title, kind, sort_order) VALUES
  ('m01', 'มกราคม 2570',     'monthly', 1),
  ('m02', 'กุมภาพันธ์ 2570',   'monthly', 2),
  ('m03', 'มีนาคม 2570',      'monthly', 3),
  ('m04', 'เมษายน 2570',      'monthly', 4),
  ('m05', 'พฤษภาคม 2570',    'monthly', 5),
  ('m06', 'มิถุนายน 2570',     'monthly', 6),
  ('m07', 'กรกฎาคม 2570',    'monthly', 7),
  ('m08', 'สิงหาคม 2570',     'monthly', 8),
  ('m09', 'กันยายน 2570',     'monthly', 9),
  ('m10', 'ตุลาคม 2570',      'monthly', 10),
  ('m11', 'พฤศจิกายน 2570',  'monthly', 11),
  ('m12', 'ธันวาคม 2570',     'monthly', 12),
  ('ecard-lee',    'e-card ปีใหม่ Lee',    'ecard', 13),
  ('ecard-loxley', 'e-card ปีใหม่ LOXLEY', 'ecard', 14);
