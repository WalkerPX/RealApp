/**
 * Faithful TypeScript port of Real's Hashids request-token encoder
 * (salt "realwebapp", min_length 16) — ported from real-deal-tracker's
 * verified Python port (15/15 against the minified web bundle).
 *
 * Mirrors the Python 1:1 using char arrays, because the shuffle salt is
 * `result-so-far + salt + current-alphabet` built by list concatenation —
 * string-based ports get the composition order wrong.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
const SEPS = "cfhistuCFHISTU";

function uniqueArr(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/** Python _shuffle: `i %= t.length` resets i each iteration (the gotcha). */
function shuffleArr(arr: string[], salt: string[]): string[] {
  if (salt.length === 0) return arr.slice();
  const r = arr.slice();
  let o = r.length - 1;
  let i = 0;
  let a = 0;
  while (o > 0) {
    i = i % salt.length;
    const n = salt[i].charCodeAt(0);
    a += n;
    const c = (n + i + a) % o;
    [r[c], r[o]] = [r[o], r[c]];
    o -= 1;
    i += 1;
  }
  return r;
}

function hashNum(e: number, t: string[]): string[] {
  const n: string[] = [];
  while (true) {
    n.unshift(t[e % t.length]);
    e = Math.floor(e / t.length);
    if (e <= 0) break;
  }
  return n;
}

export class RealHashids {
  private salt: string[];
  private alphabet: string[];
  private seps!: string[];
  private guards!: string[];
  private minLength: number;

  constructor(saltStr = "", minLength = 0) {
    this.salt = [...saltStr];
    this.minLength = minLength;
    let alphabet = uniqueArr([...ALPHABET]);
    let seps = uniqueArr([...SEPS]);
    alphabet = alphabet.filter((c) => !seps.includes(c));
    seps = shuffleArr(seps, this.salt);
    if (seps.length === 0 || alphabet.length / seps.length > 3.5) {
      const h = Math.floor(alphabet.length / 3.5);
      if (h > seps.length) {
        const b = h - seps.length;
        seps = seps.concat(alphabet.slice(0, b));
        alphabet = alphabet.slice(b);
      }
    }
    this.alphabet = shuffleArr(alphabet, this.salt);
    const s = Math.floor(this.alphabet.length / 12);
    if (this.alphabet.length < 3) {
      this.guards = seps.slice(0, s);
      this.seps = seps.slice(s);
    } else {
      this.guards = this.alphabet.slice(0, s);
      this.alphabet = this.alphabet.slice(s);
    }
  }

  encode(input: number | number[]): string {
    const numbers = Array.isArray(input) ? input : [input];
    const o = numbers.reduce((acc, v, i) => acc + (v % (i + 100)), 0);
    let n = this.alphabet.slice();
    let result = [n[o % n.length]];
    const a = result.slice(); // snapshot: python takes it before the loop
    for (let l = 0; l < numbers.length; l++) {
      const val = numbers[l];
      n = shuffleArr(n, a.concat(this.salt, n));
      const f = hashNum(val, n);
      result = result.concat(f);
      if (l + 1 < numbers.length) {
        const p = f[0].charCodeAt(0) + l;
        const m = val % p;
        result.push(this.seps[m % this.seps.length]);
      }
    }
    if (result.length < this.minLength) {
      const u = (o + result[0].charCodeAt(0)) % this.guards.length;
      result.unshift(this.guards[u]);
      if (result.length < this.minLength) {
        const s2 = (o + result[2].charCodeAt(0)) % this.guards.length;
        result.push(this.guards[s2]);
      }
    }
    const f = Math.floor(n.length / 2);
    while (result.length < this.minLength) {
      n = shuffleArr(n, n);
      result = n.slice(f).concat(result);
      result = result.concat(n.slice(0, f));
      const h = result.length - this.minLength;
      if (h > 0) {
        const b = Math.floor(h / 2);
        result = result.slice(b, b + this.minLength);
      }
    }
    return result.join("");
  }
}

const _HASHIDS = new RealHashids("realwebapp", 16);

/** real-request-token: hashids-encoded current epoch ms. */
export function requestToken(): string {
  return _HASHIDS.encode(Date.now());
}
