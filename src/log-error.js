// Safe one-line description of an error for the server log.
//
// Never log a raw error object: mysql2 attaches the interpolated statement as
// `err.sql` (and `sqlMessage`, parameters...), so a failing
// `UPDATE admin_users SET password_hash = ?` would put a bcrypt hash into the
// Plesk logs. Only name, code and message are kept; the stack (frames only, no
// statement) only when explicitly in development.

// Some server messages quote a value ("Incorrect ... value: '…'"): blank out
// anything that looks like a bcrypt hash, just in case.
const BCRYPT_HASH = /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}/g;

export function describeError(err, { withStack = false } = {}) {
  if (!(err instanceof Error)) return `non-error thrown: ${typeof err}`;
  const code = err.code ? ` [${err.code}]` : '';
  let text = `${err.name}${code}: ${String(err.message).replace(BCRYPT_HASH, '[redacted]')}`;
  if (withStack && typeof err.stack === 'string') {
    const frames = err.stack.split('\n').filter((line) => /^\s+at /.test(line));
    if (frames.length) text += `\n${frames.join('\n')}`;
  }
  return text;
}
