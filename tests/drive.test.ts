import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestUrlParam } from 'obsidian';
import { CryptDriveFs, DriveClient, GoogleAuth, pollDeviceLogin } from '../src/drive.ts';
import type { Request } from '../src/drive.ts';

const FOLDER = 'application/vnd.google-apps.folder';
const noSleep = async () => {};
const res = (status: number, j: unknown = {}, headers: Record<string, string> = {}) =>
	({ status, json: j, text: JSON.stringify(j), arrayBuffer: new ArrayBuffer(0), headers });
const tokenOk = () => res(200, { access_token: 'AT', expires_in: 3600 });

// Fake crypt: "enc_" prefix per segment, 4-byte data header.
const crypt = {
	encryptPath: (p: string) => p.split('/').map((s) => `enc_${s}`).join('/'),
	decryptPath: (p: string) => p.split('/').map((s) => { if (!s.startsWith('enc_')) throw new Error('bad'); return s.slice(4); }).join('/'),
	encryptData: (d: Uint8Array) => new Uint8Array([9, 9, 9, 9, ...d]),
	decryptData: (d: Uint8Array) => d.slice(4),
};

interface Item { id: string; name: string; mimeType: string; parents: string[]; modifiedTime: string; data?: Uint8Array }

// Minimal in-memory Drive: list (q parsing), mkdir, multipart create/update, download, move.
function fakeDrive(folder = 'Obsidian') {
	const items: Item[] = [];
	const calls: RequestUrlParam[] = [];
	let n = 0;
	const add = (it: Omit<Item, 'id'>) => { const i = { id: `id${++n}`, ...it }; items.push(i); return i; };
	const meta = (i: Item) => ({ id: i.id, name: i.name, mimeType: i.mimeType, modifiedTime: i.modifiedTime, size: String(i.data?.length ?? 0), md5Checksum: `md5-${i.id}` });
	const req: Request = async (p) => {
		calls.push(p);
		const u = new URL(p.url);
		if (u.hostname === 'oauth2.googleapis.com') return tokenOk();
		const id = u.pathname.match(/\/files\/([^/]+)$/)?.[1];
		if (p.method === undefined && !id) {
			const q = u.searchParams.get('q')!;
			const parent = q.match(/'([^']*)' in parents/)![1];
			const name = q.match(/name='([^']*)'/)?.[1];
			const isFolder = q.includes("mimeType='") ? true : q.includes("mimeType!='") ? false : undefined;
			const files = items.filter((i) => i.parents.includes(parent!) && (name === undefined || i.name === name) &&
				(isFolder === undefined || (i.mimeType === FOLDER) === isFolder)).map(meta);
			return res(200, { files });
		}
		if (p.method === undefined && !u.searchParams.has('alt')) {
			const i = items.find((x) => x.id === id);
			return i ? res(200, { ...meta(i), parents: i.parents, trashed: false }) : res(404, { error: { message: 'not found' } });
		}
		if (p.method === undefined) return { ...res(200), arrayBuffer: items.find((i) => i.id === id)!.data!.slice().buffer };
		if (p.method === 'PATCH' && u.searchParams.has('addParents')) {
			const it = items.find((i) => i.id === id)!;
			it.parents = [u.searchParams.get('addParents')!];
			const b = JSON.parse((p.body as string) || '{}') as { name?: string };
			if (b.name) it.name = b.name;
			return res(200, { id });
		}
		if (u.searchParams.get('uploadType') === 'multipart') {
			const raw = new Uint8Array(p.body as ArrayBuffer);
			const text = new TextDecoder('latin1').decode(raw);
			const b = p.contentType!.split('boundary=')[1]!;
			const m = JSON.parse(text.split('\r\n\r\n')[1]!.split(`\r\n--${b}`)[0]!);
			const start = text.indexOf('\r\n\r\n', text.indexOf('application/octet-stream')) + 4;
			const data = raw.slice(start, text.lastIndexOf(`\r\n--${b}--`));
			const it = id ? Object.assign(items.find((i) => i.id === id)!, { data, modifiedTime: m.modifiedTime })
				: add({ name: m.name, parents: m.parents, mimeType: 'application/octet-stream', modifiedTime: m.modifiedTime, data });
			return res(200, meta(it));
		}
		const body = JSON.parse(p.body as string);
		return res(200, { id: add({ ...body, modifiedTime: '' }).id }); // mkdir
	};
	const drive = new DriveClient(req, new GoogleAuth(req, 'c', 's', 'r'), noSleep);
	const fs = new CryptDriveFs(drive, crypt, { rootPath: 'encrypted', folder, trashDir: '_deleted/' }, (n) => n - 4);
	const mkdir = (name: string, parent: string) => add({ name, parents: [parent], mimeType: FOLDER, modifiedTime: '' }).id;
	return { items, calls, req, drive, fs, add, mkdir };
}

test('multipart body is well-formed and binary-exact', async () => {
	const d = fakeDrive();
	const data = new Uint8Array([0, 255, 13, 10, 45, 45, 1]);
	const e = await d.fs.write('a/b.md', data, Date.UTC(2026, 0, 2, 3, 4, 5));
	const up = d.calls.find((c) => c.url.includes('uploadType=multipart'))!;
	assert.equal(up.method, 'POST');
	const b = up.contentType!.match(/^multipart\/related; boundary=(.+)$/)![1]!;
	const raw = new Uint8Array(up.body as ArrayBuffer);
	const te = new TextEncoder();
	const head = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`;
	const text = new TextDecoder('latin1').decode(raw);
	assert.ok(text.startsWith(head));
	const json = text.slice(head.length, text.indexOf(`\r\n--${b}\r\n`));
	const meta = JSON.parse(json);
	assert.equal(meta.name, 'enc_b.md');
	assert.equal(meta.modifiedTime, '2026-01-02T03:04:05.000Z');
	const expected = new Uint8Array([...te.encode(`${head}${json}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`), 9, 9, 9, 9, ...data, ...te.encode(`\r\n--${b}--\r\n`)]);
	assert.deepEqual(raw, expected);
	// parents created with encrypted names under plain root
	const names = (id: string): string[] => { const i = d.items.find((x) => x.id === id); return i ? [...names(i.parents[0]!), i.name] : []; };
	assert.deepEqual(names(e.id), ['encrypted', 'enc_Obsidian', 'enc_a', 'enc_b.md']);
	assert.equal(e.size, data.length);
	assert.deepEqual(await d.fs.read('a/b.md'), data);
});

test('large file uses resumable session + PUT', async () => {
	const seen: RequestUrlParam[] = [];
	const req: Request = async (p) => {
		seen.push(p);
		if (p.url.includes('oauth2')) return tokenOk();
		if (p.url.includes('uploadType=resumable')) return res(200, {}, { location: 'https://up/session' });
		return res(200, { id: 'F', modifiedTime: '2026-01-01T00:00:00Z', size: '6000000' });
	};
	const drive = new DriveClient(req, new GoogleAuth(req, 'c', 's', 'r'), noSleep);
	const f = await drive.upload(new Uint8Array(6_000_000), 0, { id: 'F' });
	assert.equal(f.id, 'F');
	assert.equal(seen[1]!.method, 'PATCH');
	assert.equal(seen[2]!.url, 'https://up/session');
	assert.equal((seen[2]!.body as ArrayBuffer).byteLength, 6_000_000);
});

test('retries 429 with backoff, then succeeds', async () => {
	const statuses = [429, 403, 200];
	const req: Request = async (p) => p.url.includes('oauth2') ? tokenOk()
		: statuses[0] === 403 ? (statuses.shift(), res(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }))
		: res(statuses.shift()!, { files: [] });
	const sleeps: number[] = [];
	const drive = new DriveClient(req, new GoogleAuth(req, 'c', 's', 'r'), async (ms) => { sleeps.push(ms); });
	assert.deepEqual(await drive.list('root'), []);
	assert.deepEqual(sleeps, [1000, 2000]);
	const forbidden: Request = async (p) => p.url.includes('oauth2') ? tokenOk() : res(403, { error: { message: 'nope', errors: [{ reason: 'forbidden' }] } });
	await assert.rejects(new DriveClient(forbidden, new GoogleAuth(forbidden, 'c', 's', 'r'), noSleep).list('root'), /403: nope/);
});

test('401 triggers exactly one refresh + retry', async () => {
	let refreshes = 0;
	let apiStatus = [401, 200];
	const req: Request = async (p) => {
		if (p.url.includes('oauth2')) { refreshes++; return tokenOk(); }
		return res(apiStatus.shift() ?? 401, { files: [] });
	};
	const drive = new DriveClient(req, new GoogleAuth(req, 'c', 's', 'r'), noSleep);
	await drive.list('root');
	assert.equal(refreshes, 2);
	apiStatus = [401, 401];
	refreshes = 0;
	await assert.rejects(drive.list('root'), /401/);
	assert.equal(refreshes, 1);
});

test('device flow: pending → slow_down → success; access_denied', async () => {
	const login = { userCode: 'U', verificationUrl: 'v', deviceCode: 'D', interval: 5, expiresIn: 1800 };
	const replies = [res(428, { error: 'authorization_pending' }), res(403, { error: 'slow_down' }), res(200, { refresh_token: 'RT', access_token: 'x' })];
	const bodies: string[] = [];
	const req: Request = async (p) => { bodies.push(p.body as string); return replies.shift()!; };
	const sleeps: number[] = [];
	assert.equal(await pollDeviceLogin(req, 'cid', 'sec', login, undefined, async (ms) => { sleeps.push(ms); }), 'RT');
	assert.deepEqual(sleeps, [5000, 5000, 10000]);
	assert.match(bodies[0]!, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
	const denied: Request = async () => res(403, { error: 'access_denied' });
	await assert.rejects(pollDeviceLogin(denied, 'c', 's', login, undefined, noSleep), /access denied/);
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(pollDeviceLogin(denied, 'c', 's', login, ac.signal, noSleep), /cancelled/);
});

test('list() throws when a name fails to decrypt', async () => {
	const d = fakeDrive();
	const vault = d.mkdir('enc_Obsidian', d.mkdir('encrypted', 'root'));
	d.add({ name: 'enc_ok.md', parents: [vault], mimeType: 'text/plain', modifiedTime: '2026-01-01T00:00:00Z' });
	d.add({ name: 'plain.md', parents: [d.mkdir('enc_sub', vault)], mimeType: 'text/plain', modifiedTime: '2026-01-01T00:00:00Z' });
	await assert.rejects(d.fs.list(), /can't decrypt names/);
});

test('list(): missing root → throws; missing vault folder → empty; duplicates → newest + warning; Google Docs skipped', async () => {
	const d = fakeDrive();
	await assert.rejects(d.fs.list(), /"encrypted" not found/);
	const root = d.mkdir('encrypted', 'root');
	assert.equal((await d.fs.list()).files.size, 0);
	const vault = d.mkdir('enc_Obsidian', root);
	const sub = d.mkdir('enc_dir', vault);
	d.add({ name: 'enc_n.md', parents: [sub], mimeType: 'text/plain', modifiedTime: '2026-01-01T00:00:00.000Z', data: new Uint8Array(10) });
	const newer = d.add({ name: 'enc_n.md', parents: [sub], mimeType: 'text/plain', modifiedTime: '2026-02-01T00:00:00.000Z', data: new Uint8Array(14) });
	d.add({ name: 'doc', parents: [vault], mimeType: 'application/vnd.google-apps.document', modifiedTime: '' });
	const { files, warnings } = await d.fs.list();
	assert.deepEqual([...files.keys()], ['dir/n.md']);
	assert.deepEqual(files.get('dir/n.md'), { id: newer.id, md5: `md5-${newer.id}`, mtime: Date.parse('2026-02-01T00:00:00.000Z'), size: 10 });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /rclone dedupe/);
	// NFD and NFC spellings of one name collapse to the NFC path → duplicate, newest wins
	d.add({ name: 'enc_й.md'.normalize('NFD'), parents: [vault], mimeType: 'text/plain', modifiedTime: '2026-03-01T00:00:00.000Z' });
	const nfc = d.add({ name: 'enc_й.md', parents: [vault], mimeType: 'text/plain', modifiedTime: '2026-04-01T00:00:00.000Z' });
	const again = await d.fs.list();
	assert.equal(again.files.get('й.md')?.id, nfc.id);
	assert.equal(again.warnings.length, 2);
});

test('trash moves into <trashDir>/<date>/<folder>/<path>, all encrypted', async () => {
	const d = fakeDrive();
	const e = await d.fs.write('x/y.md', new Uint8Array([1]), 0);
	await d.fs.list();
	await d.fs.trash('x/y.md');
	const dt = new Date();
	const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
	const names = (id: string): string[] => { const i = d.items.find((x) => x.id === id); return i ? [...names(i.parents[0]!), i.name] : []; };
	assert.deepEqual(names(e.id), ['encrypted', 'enc__deleted', `enc_${day}`, 'enc_Obsidian', 'enc_x', 'enc_y.md']);
	assert.equal((await d.fs.list()).files.size, 0);
	assert.equal(d.items.length, 8); // nothing deleted: encrypted, Obsidian, x, y.md, _deleted, day, Obsidian, x
});

test('trashing the same path twice in a day keeps both (time suffix on the second)', async () => {
	const d = fakeDrive();
	const first = await d.fs.write('x/y.md', new Uint8Array([1]), 0);
	await d.fs.list();
	await d.fs.trash('x/y.md');
	const second = await d.fs.write('x/y.md', new Uint8Array([2]), 0);
	await d.fs.list();
	await d.fs.trash('x/y.md');
	const a = d.items.find((i) => i.id === first.id)!;
	const b = d.items.find((i) => i.id === second.id)!;
	assert.equal(a.parents[0], b.parents[0]);
	assert.equal(a.name, 'enc_y.md');
	assert.match(b.name, /^enc_y \d{6}\.md$/);
});

test('NFD-stored names (rclone on macOS): listed as NFC; stat/write/new files reuse them', async () => {
	const d = fakeDrive();
	const vault = d.mkdir('enc_Obsidian', d.mkdir('encrypted', 'root'));
	const dir = d.mkdir('enc_Заметки'.normalize('NFD'), vault);
	const file = d.add({ name: 'enc_й.md'.normalize('NFD'), parents: [dir], mimeType: 'text/plain', modifiedTime: '2026-01-01T00:00:00.000Z', data: new Uint8Array(5) });
	const { files } = await d.fs.list();
	assert.deepEqual([...files.keys()], ['Заметки/й.md']);
	assert.equal((await d.fs.stat('Заметки/й.md'))?.id, file.id);
	const count = d.items.length;
	assert.equal((await d.fs.write('Заметки/й.md', new Uint8Array([1]), 0)).id, file.id); // updated in place
	await d.fs.write('Заметки/new.md', new Uint8Array([1]), 0);
	assert.equal(d.items.length, count + 1); // no NFC twin folder
	assert.equal(d.items.at(-1)!.parents[0], dir);
	d.items.splice(d.items.indexOf(file), 1); // deleted by someone else
	assert.equal(await d.fs.stat('Заметки/й.md'), undefined);
});

test('wrong key: non-empty crypt root with nothing decryptable → throws; empty root → ok', async () => {
	const d = fakeDrive();
	const root = d.mkdir('encrypted', 'root');
	assert.equal((await d.fs.list()).files.size, 0);
	d.mkdir('XYZ', root); // e.g. another folder encrypted with the real key
	await assert.rejects(d.fs.list(), /crypt root — wrong password/);
	d.mkdir('enc_Other', root); // one decryptable sibling is enough
	assert.equal((await d.fs.list()).files.size, 0);
});

test('file found by name (not in listing) is cached: write updates it, no twin', async () => {
	const d = fakeDrive();
	const vault = d.mkdir('enc_Obsidian', d.mkdir('encrypted', 'root'));
	await d.fs.list();
	const late = d.add({ name: 'enc_a.md', parents: [vault], mimeType: 'text/plain', modifiedTime: '2026-01-01T00:00:00.000Z' }); // another device
	assert.equal((await d.fs.stat('a.md'))?.id, late.id);
	const count = d.items.length;
	assert.equal((await d.fs.write('a.md', new Uint8Array([1]), 0)).id, late.id);
	assert.equal(d.items.length, count);
});

test('folder with stray slashes has no empty-named level', async () => {
	const d = fakeDrive('/Obsidian//');
	await d.fs.write('a.md', new Uint8Array([1]), 0);
	assert.deepEqual(d.items.map((i) => i.name), ['encrypted', 'enc_Obsidian', 'enc_a.md']);
});

test('duplicates with equal modifiedTime: larger id wins, in list() and findChild()', async () => {
	const d = fakeDrive();
	const vault = d.mkdir('enc_Obsidian', d.mkdir('encrypted', 'root'));
	const t = '2026-01-01T00:00:00.000Z';
	const a = d.add({ name: 'enc_n.md', parents: [vault], mimeType: 'text/plain', modifiedTime: t });
	const b = d.add({ name: 'enc_n.md', parents: [vault], mimeType: 'text/plain', modifiedTime: t });
	const win = a.id > b.id ? a : b;
	assert.equal((await d.fs.list()).files.get('n.md')?.id, win.id);
	assert.equal((await d.drive.findChild(vault, 'enc_n.md', false))?.id, win.id);
	d.items.reverse(); // order Drive returns them in must not matter
	assert.equal((await d.fs.list()).files.get('n.md')?.id, win.id);
	assert.equal((await d.drive.findChild(vault, 'enc_n.md', false))?.id, win.id);
});
