import crypto from 'node:crypto';

/**
 * Minimal password login: the cookie holds `expiry.hmac(expiry)` signed with
 * SESSION_SECRET (or a key derived from DASHBOARD_PASSWORD). Changing the
 * password therefore invalidates every session.
 */
export class Auth {
  private key: Buffer;
  private attempts = new Map<string, { n: number; since: number }>();
  static readonly COOKIE = 'gb_session';
  static readonly MAX_AGE_S = 30 * 24 * 3600;

  constructor(
    private password: string,
    secret: string,
  ) {
    this.key = crypto.createHash('sha256').update(`grokbot:${secret || password || 'open'}`).digest();
  }

  get required() {
    return this.password.length > 0;
  }

  private sign(v: string) {
    return crypto.createHmac('sha256', this.key).update(v).digest('base64url');
  }

  issue(now = Date.now()): string {
    const exp = String(now + Auth.MAX_AGE_S * 1000);
    return `${exp}.${this.sign(exp)}`;
  }

  verify(token: string | undefined, now = Date.now()): boolean {
    if (!this.required) return true;
    if (!token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || Number(exp) < now) return false;
    const expected = Buffer.from(this.sign(exp));
    const got = Buffer.from(sig);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  }

  checkPassword(candidate: string): boolean {
    const a = crypto.createHash('sha256').update(String(candidate)).digest();
    const b = crypto.createHash('sha256').update(this.password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** 10 attempts / 15 min / IP */
  allowAttempt(ip: string, now = Date.now()): boolean {
    const a = this.attempts.get(ip);
    if (!a || now - a.since > 15 * 60_000) {
      this.attempts.set(ip, { n: 1, since: now });
      return true;
    }
    a.n++;
    return a.n <= 10;
  }

  resetAttempts(ip: string) {
    this.attempts.delete(ip);
  }
}
