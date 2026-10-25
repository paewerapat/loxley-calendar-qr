-- Back-office login (task 03). All DATETIME values are UTC (connections run
-- SET time_zone = '+00:00'). DATETIME(3) keeps milliseconds so a password change
-- can be compared exactly with a session's login time.

-- Users are created with `npm run admin:create` (no sign-up page).
CREATE TABLE IF NOT EXISTS admin_users (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username            VARCHAR(32)  NOT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at       DATETIME     NULL,
  -- Sessions that logged in before this moment are treated as logged out.
  password_changed_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY admin_users_username_unique (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Failed login counter per IP + lowercased username (shared by every Passenger
-- process, survives restarts).
CREATE TABLE IF NOT EXISTS login_throttle (
  ip              VARCHAR(64)  NOT NULL,
  username        VARCHAR(64)  NOT NULL,
  failures        INT UNSIGNED NOT NULL DEFAULT 0,
  first_failed_at DATETIME(3)  NOT NULL,
  locked_until    DATETIME(3)  NULL,
  PRIMARY KEY (ip, username),
  KEY login_throttle_first_failed_at (first_failed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Schema expected by express-mysql-session (createDatabaseTable: false). Session
-- ids are case-sensitive random strings, so session_id/data use utf8mb4_bin like
-- the library's own schema.
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  expires    INT UNSIGNED NOT NULL,
  data       MEDIUMTEXT   CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
