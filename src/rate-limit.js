// Cheap in-memory guards that run BEFORE any bcrypt work (per process):
// - a fixed-window request limit per client IP for the password forms
// - a cap on how many password checks (bcrypt) run at the same time, so a burst of
//   logins cannot starve the public QR pages of CPU.

export function createIpLimiter({ limit, windowMs, maxEntries = 10000 }) {
  const hits = new Map();

  function prune(now = Date.now()) {
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
    // Still huge (many spoofed IPs within one window): start over rather than grow.
    if (hits.size >= maxEntries) hits.clear();
  }

  return {
    /** Count one request; false when this IP is over the limit. */
    take(ip) {
      const now = Date.now();
      let entry = hits.get(ip);
      if (!entry || entry.resetAt <= now) {
        if (hits.size >= maxEntries) prune(now);
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(ip, entry);
      }
      entry.count += 1;
      return entry.count <= limit;
    },
    prune,
    get size() { return hits.size; },
  };
}

export function createSemaphore(max) {
  let active = 0;
  return {
    /** A release function, or null when `max` holders are already active. */
    tryAcquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          active -= 1;
        }
      };
    },
    get active() { return active; },
  };
}
