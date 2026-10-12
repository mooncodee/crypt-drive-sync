// Byte compatibility with real rclone. Run tests/make-fixtures.sh first.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Crypt } from "../src/crypt.ts";

const F = path.join(import.meta.dirname, "fixtures");
const PLAIN = path.join(F, "plain");
const rclone = (...args: string[]) => execFileSync("rclone", ["--config=", ...args]).toString().trim();
const files = (dir: string) =>
	(fs.readdirSync(dir, { recursive: true }) as string[]).filter((p) => fs.statSync(path.join(dir, p)).isFile()).sort();
const nfc = (a: string[]) => a.map((p) => p.normalize("NFC")).sort();

const SETS = [
	{ dir: "enc", salt: "", dirNameEncrypt: true, extra: "" },
	{ dir: "enc-salt", salt: "test-salt", dirNameEncrypt: true, extra: `,password2=${rclone("obscure", "test-salt")}` },
	{ dir: "enc-nodir", salt: "", dirNameEncrypt: false, extra: ",directory_name_encryption=false" },
];
const remote = (dir: string, extra: string) => `:crypt,remote=${dir},password=${rclone("obscure", "test-pass")}${extra}:`;

for (const s of SETS) {
	const ENC = path.join(F, s.dir);
	let c: Crypt;
	before(async () => {
		c = await Crypt.create({ password: "test-pass", salt: s.salt, dirNameEncrypt: s.dirNameEncrypt });
	});

	test(`${s.dir}: decrypts rclone names and files`, () => {
		const enc = files(ENC);
		assert.deepEqual(nfc(enc.map((e) => c.decryptPath(e))), nfc(files(PLAIN)));
		for (const e of enc) {
			const plain = fs.readFileSync(path.join(PLAIN, c.decryptPath(e)));
			assert.deepEqual(c.decryptData(fs.readFileSync(path.join(ENC, e))), new Uint8Array(plain), e);
		}
	});

	test(`${s.dir}: encrypts names exactly like rclone`, () => {
		const byPlain = new Map(files(ENC).map((e) => [c.decryptPath(e), e]));
		let nfd = 0;
		for (const [p, e] of byPlain) {
			if (p === p.normalize("NFC")) assert.equal(c.encryptPath(p), e);
			else nfd++;
		}
		assert.equal(nfd, 1);
		// plugin's name for the NFD file == rclone's name for the NFC one
		const name = "Заметка йё.md";
		assert.equal(c.encryptName(name.normalize("NFD")), byPlain.get(`Заметки/${name.normalize("NFC")}`)!.split("/").pop());
	});

	test(`${s.dir}: rclone decrypts what the plugin encrypted`, () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crypt-"));
		for (const p of files(PLAIN)) {
			const dst = path.join(tmp, "enc", c.encryptPath(p));
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.writeFileSync(dst, c.encryptData(fs.readFileSync(path.join(PLAIN, p))));
		}
		rclone("copy", remote(path.join(tmp, "enc"), s.extra), path.join(tmp, "out"));
		const out = files(path.join(tmp, "out"));
		assert.deepEqual(nfc(out), nfc(files(PLAIN)));
		for (const p of out) assert.deepEqual(fs.readFileSync(path.join(tmp, "out", p)), fs.readFileSync(path.join(PLAIN, p)), p);
		fs.rmSync(tmp, { recursive: true });
	});

	test(`${s.dir}: decryptedSize`, () => {
		for (const e of files(ENC)) {
			assert.equal(Crypt.decryptedSize(fs.statSync(path.join(ENC, e)).size), fs.statSync(path.join(PLAIN, c.decryptPath(e))).size, e);
		}
	});
}

test("wrong password, tampering and impossible sizes throw", async () => {
	const ENC = path.join(F, "enc");
	const c = await Crypt.create({ password: "test-pass", salt: "", dirNameEncrypt: true });
	const wrong = await Crypt.create({ password: "wrong-pass", salt: "", dirNameEncrypt: true });
	const enc = files(ENC);
	for (const seg of new Set(enc.flatMap((e) => e.split("/")))) assert.throws(() => wrong.decryptName(seg), seg);
	for (const e of enc) {
		const data = fs.readFileSync(path.join(ENC, e));
		if (data.length > 32) assert.throws(() => wrong.decryptData(data), e);
	}
	assert.throws(() => c.decryptName("not-an-rclone-name.md"));

	const big = new Uint8Array(fs.readFileSync(path.join(ENC, c.encryptPath("bin/1m.bin"))));
	c.decryptData(big);
	for (const i of [0, 10, 500_000, big.length - 1]) {
		const t = big.slice();
		t[i]! ^= 1;
		assert.throws(() => c.decryptData(t), `byte ${i}`);
	}
	assert.throws(() => c.decryptData(big.subarray(0, big.length - 1)), "truncated by 1");
	assert.throws(() => c.decryptData(big.subarray(0, 32 + 65552 + 10)), "truncated block header");

	assert.equal(Crypt.decryptedSize(32), 0);
	assert.equal(Crypt.decryptedSize(32 + 65552), 65536);
	assert.equal(Crypt.decryptedSize(32 + 65552 + 17), 65537);
	for (const n of [0, 31, 33, 48, 32 + 65552 + 16]) assert.throws(() => Crypt.decryptedSize(n), String(n));
});
