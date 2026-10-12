// rclone crypt format (backend/crypt/cipher.go): scrypt keys, XSalsa20-Poly1305 data blocks,
// AES-256-EME + base32hex names. Pure JS — runs on Obsidian mobile.
import { ecb } from "@noble/ciphers/aes.js";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";

export interface CryptOptions {
	password: string;
	salt: string; // rclone password2, "" = default salt
	dirNameEncrypt: boolean;
}

const DEFAULT_SALT = new Uint8Array([0xa8, 0x0d, 0xf4, 0x3a, 0x8f, 0xbd, 0x03, 0x08, 0xa7, 0xca, 0xb8, 0x3e, 0x58, 0x1f, 0x86, 0xb1]);
const MAGIC = new TextEncoder().encode("RCLONE\0\0");
const HEADER = 32; // magic 8 + nonce 24
const DATA = 65536;
const TAG = 16;
const B32 = "0123456789abcdefghijklmnopqrstuv";

export class Crypt {
	private dataKey: Uint8Array;
	private nameKey: Uint8Array;
	private nameTweak: Uint8Array;
	private dirNameEncrypt: boolean;

	private constructor(key: Uint8Array, dirNameEncrypt: boolean) {
		this.dataKey = key.slice(0, 32);
		this.nameKey = key.slice(32, 64);
		this.nameTweak = key.slice(64, 80);
		this.dirNameEncrypt = dirNameEncrypt;
	}

	static async create(opts: CryptOptions): Promise<Crypt> {
		const salt = opts.salt === "" ? DEFAULT_SALT : new TextEncoder().encode(opts.salt);
		const key = opts.password === "" ? new Uint8Array(80) : await scryptAsync(opts.password, salt, { N: 16384, r: 8, p: 1, dkLen: 80 });
		return new Crypt(key, opts.dirNameEncrypt);
	}

	encryptName(segment: string): string {
		if (segment === "") return "";
		const b = new TextEncoder().encode(segment.normalize("NFC"));
		const n = 16 - (b.length % 16);
		const padded = new Uint8Array(b.length + n).fill(n);
		padded.set(b);
		return b32encode(eme(this.nameKey, this.nameTweak, padded, true));
	}

	decryptName(segment: string): string {
		if (segment === "") return "";
		const raw = b32decode(segment);
		if (raw.length === 0 || raw.length % 16 !== 0) throw new Error(`bad encrypted name: ${segment}`);
		const p = eme(this.nameKey, this.nameTweak, raw, false);
		const n = p[p.length - 1]!;
		if (n < 1 || n > 16 || p.subarray(p.length - n).some((v) => v !== n)) throw new Error(`cannot decrypt name (wrong password?): ${segment}`);
		return new TextDecoder("utf-8", { fatal: true }).decode(p.subarray(0, p.length - n));
	}

	encryptPath(path: string): string {
		return this.mapPath(path.normalize("NFC"), (s) => this.encryptName(s));
	}

	decryptPath(path: string): string {
		return this.mapPath(path, (s) => this.decryptName(s));
	}

	private mapPath(path: string, f: (s: string) => string): string {
		const parts = path.split("/");
		return parts.map((s, i) => (this.dirNameEncrypt || i === parts.length - 1 ? f(s) : s)).join("/");
	}

	encryptData(plain: Uint8Array): Uint8Array {
		const nonce = crypto.getRandomValues(new Uint8Array(24));
		const out = new Uint8Array(HEADER + plain.length + TAG * Math.ceil(plain.length / DATA));
		out.set(MAGIC);
		out.set(nonce, 8);
		for (let i = 0, o = HEADER; i < plain.length; i += DATA, o += DATA + TAG) {
			out.set(xsalsa20poly1305(this.dataKey, nonce).encrypt(plain.subarray(i, i + DATA)), o);
			increment(nonce);
		}
		return out;
	}

	decryptData(enc: Uint8Array): Uint8Array {
		const out = new Uint8Array(Crypt.decryptedSize(enc.length));
		if (MAGIC.some((v, i) => enc[i] !== v)) throw new Error("not an rclone-encrypted file (bad magic)");
		const nonce = enc.slice(8, HEADER);
		for (let i = HEADER, o = 0; i < enc.length; i += DATA + TAG, o += DATA) {
			try {
				out.set(xsalsa20poly1305(this.dataKey, nonce).decrypt(enc.subarray(i, i + DATA + TAG)), o);
			} catch {
				throw new Error("failed to authenticate decrypted block (wrong password or corrupted file)");
			}
			increment(nonce);
		}
		return out;
	}

	static decryptedSize(encSize: number): number {
		const size = encSize - HEADER;
		if (size < 0) throw new Error("encrypted file too short");
		const residue = size % (DATA + TAG);
		if (residue !== 0 && residue <= TAG) throw new Error("encrypted file has truncated block");
		return Math.floor(size / (DATA + TAG)) * DATA + (residue && residue - TAG);
	}
}

// 24-byte nonce as a little-endian counter
function increment(n: Uint8Array): void {
	for (let i = 0; i < n.length; i++) if ((n[i] = n[i]! + 1) !== 256) break;
}

function b32encode(b: Uint8Array): string {
	let s = "", v = 0, bits = 0;
	for (const x of b) {
		v = ((v << 8) | x) & 0xffff;
		for (bits += 8; bits >= 5; ) s += B32[(v >>> (bits -= 5)) & 31];
	}
	return bits ? s + B32[(v << (5 - bits)) & 31] : s;
}

function b32decode(s: string): Uint8Array {
	const out: number[] = [];
	let v = 0, bits = 0;
	for (const ch of s.toLowerCase()) {
		const d = B32.indexOf(ch);
		if (d < 0) throw new Error(`bad encrypted name: ${s}`);
		v = ((v << 5) | d) & 0xffff;
		if ((bits += 5) >= 8) out.push((v >>> (bits -= 8)) & 255);
	}
	return Uint8Array.from(out);
}

// GF(2^128) doubling, as in github.com/rfjakob/eme
function x2(b: Uint8Array): Uint8Array {
	const o = new Uint8Array(16);
	o[0] = (b[0]! << 1) ^ (b[15]! >= 128 ? 135 : 0);
	for (let j = 1; j < 16; j++) o[j] = (b[j]! << 1) | (b[j - 1]! >> 7);
	return o;
}

// EME (Halevi–Rogaway) wide-block AES, port of rfjakob/eme Transform
function eme(key: Uint8Array, tweak: Uint8Array, P: Uint8Array, encrypt: boolean): Uint8Array {
	const m = P.length / 16;
	if (m < 1 || m > 128) throw new Error("name too long");
	const aes = () => ecb(key, { disablePadding: true }); // noble ciphers are single-use
	const t = (b: Uint8Array) => (encrypt ? aes().encrypt(b) : aes().decrypt(b));
	const L: Uint8Array[] = [];
	let li = aes().encrypt(new Uint8Array(16));
	for (let j = 0; j < m; j++) L.push((li = x2(li)));
	const xorL = (b: Uint8Array) => b.map((v, i) => v ^ L[i >> 4]![i & 15]!);

	const C = t(xorL(P));
	const MP = tweak.slice();
	C.forEach((v, i) => (MP[i & 15] = MP[i & 15]! ^ v));
	const MC = t(MP);
	let M = MP.map((v, i) => v ^ MC[i]!);
	const CCC1 = MC.map((v, i) => v ^ tweak[i]!);
	for (let j = 1; j < m; j++) {
		M = x2(M);
		for (let i = 0; i < 16; i++) {
			C[j * 16 + i] = C[j * 16 + i]! ^ M[i]!;
			CCC1[i] = CCC1[i]! ^ C[j * 16 + i]!;
		}
	}
	C.set(CCC1);
	return xorL(t(C));
}
