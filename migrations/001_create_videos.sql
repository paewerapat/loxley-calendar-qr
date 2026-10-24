-- One row per QR code. slug never changes once the QR is printed.
-- r2_key keeps the column name from the qr-video-cms data model; with deployment
-- option C it holds the path relative to STORAGE_DIR, e.g. 'videos/m01/1730000000.mp4'
-- (NULL = not uploaded yet).
CREATE TABLE IF NOT EXISTS videos (
  slug        VARCHAR(64)     NOT NULL,
  title       VARCHAR(255)    NOT NULL,
  kind        VARCHAR(16)     NOT NULL,
  sort_order  INT             NOT NULL,
  r2_key      VARCHAR(255)    NULL,
  poster_key  VARCHAR(255)    NULL,
  size_bytes  BIGINT UNSIGNED NULL,
  updated_at  DATETIME        NULL,
  updated_by  VARCHAR(255)    NULL,
  PRIMARY KEY (slug),
  CONSTRAINT videos_kind_check CHECK (kind IN ('monthly', 'ecard'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
