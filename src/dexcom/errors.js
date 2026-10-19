// -----------------------------------------------------------------------------
// DexcomError: every failure of a request to the Dexcom Share API, with a
// code the app maps to a status, a retry policy or a message. Messages never
// carry the credentials, an account or session id, a glucose value nor a URL.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  TLS_UNTRUSTED: 'tls_untrusted', // certificate refused
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
  REFUSED: 'refused', // the login answered "wrong credentials" (or a wrong region)
  LOCKED: 'locked', // the account is locked for too many attempts
  LOGIN_ERROR: 'login_error', // a login answered with an error code this client does not know
  SESSION: 'session', // the session id is unknown or expired (a login fixes it)
  REGION: 'region', // a host outside the fixed list
});

export class DexcomError extends Error {
  constructor(code, message, { status, retryAfterMs, apiCode } = {}) {
    super(message);
    this.name = 'DexcomError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    /** The `Code` of the error body of the API (a fixed word, never a value of the user). */
    if (apiCode !== undefined) this.apiCode = apiCode;
  }
}

/**
 * A stop that only the user ends (or a long wait): the credentials refused
 * (a wrong password, user name or region), the account locked by Dexcom for
 * too many attempts, or a login answered with an unknown error code.
 * Trying a wrong password again and again locks the account: the app stops
 * for a long, growing delay (1 h, 6 h, 24 h).
 */
export const isStop = (err) =>
  err?.code === CODES.REFUSED || err?.code === CODES.LOCKED || err?.code === CODES.LOGIN_ERROR;
