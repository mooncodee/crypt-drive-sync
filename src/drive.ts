// Google Drive v3 + OAuth device flow over an injected `requestUrl` (no fetch, no Node: runs on mobile).
import type { RequestUrlParam } from 'obsidian';
import type { Crypt } from './crypt.ts';
import { T } from './i18n.ts';
import type { RemoteEntry, RemoteFs } from './types.ts';

export type Request = (p: RequestUrlParam) => Promise<{
	status: number; json: unknown; arrayBuffer: ArrayBuffer; text: string; headers: Record<string, string>;
}>;
type Res = Awaited<ReturnType<Request>>;
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));

const OAUTH = 'https://oauth2.googleapis.com';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json; charset=UTF-8';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime';
const MULTIPART_MAX = 5 * 1024 * 1024;

// Parse the body ourselves: Obsidian's `res.json` getter throws on non-JSON bodies.
// No runtime validation: T just names the fields we read; all optional where Google may omit them.
function body<T>(res: Res): T {
	try { return JSON.parse(res.text) as T; } catch { return {} as T; }
}
interface OAuthRes {
	error?: string; error_description?: string; refresh_token?: string; access_token?: string; expires_in?: number;
	user_code?: string; verification_url?: string; verification_uri?: string; device_code?: string; interval?: number;
}
interface ApiError { error?: { message?: string; errors?: { reason?: string }[] } }
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);

// ---------- auth ----------

export interface DeviceLogin { userCode: string; verificationUrl: string; deviceCode: string; interval: number; expiresIn: number }

/** Step 1: show `userCode` + `verificationUrl` to the user. The device/code endpoint takes no client_secret. */
export async function startDeviceLogin(req: Request, clientId: string): Promise<DeviceLogin> {
	const res = await req({ url: `${OAUTH}/device/code`, method: 'POST', contentType: FORM, body: form({ client_id: clientId, scope: SCOPE }), throw: false });
	const j = body<OAuthRes>(res);
	if (res.status !== 200) throw new Error(`Google login ${res.status}: ${j.error_description ?? j.error ?? res.text}`);
	return { userCode: j.user_code ?? '', verificationUrl: j.verification_url ?? j.verification_uri ?? '', deviceCode: j.device_code ?? '', interval: j.interval ?? 5, expiresIn: j.expires_in ?? 0 };
}

/** Step 2: poll until the user approves. Returns the refresh token. Abort via `signal`. */
export async function pollDeviceLogin(req: Request, clientId: string, clientSecret: string, login: DeviceLogin, signal?: AbortSignal, sleep = realSleep): Promise<string> {
	let interval = login.interval;
	for (;;) {
		await sleep(interval * 1000);
		if (signal?.aborted) throw new Error('Login cancelled');
		const res = await req({
			url: `${OAUTH}/token`, method: 'POST', contentType: FORM, throw: false,
			body: form({ client_id: clientId, client_secret: clientSecret, device_code: login.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
		});
		const j = body<OAuthRes>(res);
		if (res.status === 200 && j.refresh_token) return j.refresh_token;
		if (j.error === 'authorization_pending') continue;
		if (j.error === 'slow_down') { interval += 5; continue; }
		if (j.error === 'access_denied') throw new Error('Google login: access denied');
		if (j.error === 'expired_token') throw new Error('Google login: code expired, start again');
		throw new Error(`Google login ${res.status}: ${j.error_description ?? j.error ?? res.text}`);
	}
}

/** Accepts a bare refresh token or rclone's token JSON (`{"access_token":…,"refresh_token":…}` from `rclone config show`). */
export function parseRefreshToken(s: string): string {
	try { return (JSON.parse(s) as OAuthRes).refresh_token ?? ''; } catch { return s.trim(); }
}

/** Holds the refresh token; access token lives only in memory. Same class for device-flow and pasted-rclone-token logins. */
export class GoogleAuth {
	private req: Request;
	private clientId: string;
	private clientSecret: string;
	private refreshToken: string;
	private access?: { token: string; until: number };

	constructor(req: Request, clientId: string, clientSecret: string, refreshToken: string) {
		this.req = req; this.clientId = clientId; this.clientSecret = clientSecret; this.refreshToken = refreshToken;
	}

	async token(): Promise<string> {
		if (!this.access || Date.now() > this.access.until - 60_000) {
			const res = await this.req({
				url: `${OAUTH}/token`, method: 'POST', contentType: FORM, throw: false,
				body: form({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken, grant_type: 'refresh_token' }),
			});
			const j = body<OAuthRes>(res);
			if (res.status !== 200) {
				throw new Error(j.error === 'invalid_grant' ? 'Google: login expired or revoked, log in again' : `Google token ${res.status}: ${j.error_description ?? j.error ?? res.text}`);
			}
			this.access = { token: j.access_token ?? '', until: Date.now() + (j.expires_in ?? 3600) * 1000 };
		}
		return this.access.token;
	}

	invalidate(): void { this.access = undefined; }
}

// ---------- Drive ----------

export interface DriveFile { id: string; name: string; mimeType: string; size?: string; md5Checksum?: string; modifiedTime: string }

// Ties on modifiedTime → larger id, so every device picks the same duplicate.
const newer = (a: { mtime: number; id: string }, b: { mtime: number; id: string }) => a.mtime > b.mtime || (a.mtime === b.mtime && a.id > b.id);
const newest = (fs: DriveFile[]) => fs.reduce<DriveFile | undefined>((a, f) =>
	(!a || newer({ mtime: Date.parse(f.modifiedTime), id: f.id }, { mtime: Date.parse(a.modifiedTime), id: a.id }) ? f : a), undefined);

function multipart(meta: object, data: Uint8Array, boundary: string): ArrayBuffer {
	const te = new TextEncoder();
	const head = te.encode(`--${boundary}\r\nContent-Type: ${JSON_TYPE}\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
	const tail = te.encode(`\r\n--${boundary}--\r\n`);
	const out = new Uint8Array(head.length + data.length + tail.length);
	out.set(head);
	out.set(data, head.length);
	out.set(tail, head.length + data.length);
	return out.buffer;
}

export class DriveClient {
	private req: Request;
	private auth: GoogleAuth;
	private sleep: Sleep;

	constructor(req: Request, auth: GoogleAuth, sleep = realSleep) {
		this.req = req; this.auth = auth; this.sleep = sleep;
	}

	/** Authorized request: one token refresh on 401, backoff 1-16 s on 429 / 5xx / 403 rate limits. */
	async call(p: RequestUrlParam): Promise<Res> {
		let refreshed = false;
		for (let retries = 0; ;) {
			const res = await this.req({ ...p, headers: { ...p.headers, Authorization: `Bearer ${await this.auth.token()}` }, throw: false });
			if (res.status >= 200 && res.status < 300) return res;
			if (res.status === 401 && !refreshed) { refreshed = true; this.auth.invalidate(); continue; }
			const e = body<ApiError>(res).error;
			const reason = e?.errors?.[0]?.reason;
			const rate = res.status === 429 || res.status >= 500 || (res.status === 403 && (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded'));
			if (rate && retries < 5) { await this.sleep(1000 * 2 ** retries++); continue; }
			throw Object.assign(new Error(`Google Drive ${res.status}: ${e?.message ?? res.text}`), { status: res.status });
		}
	}

	/** Children of a folder (`'root'` = My Drive), optionally filtered by exact name and folder/non-folder. */
	async list(parent: string, name?: string, folder?: boolean): Promise<DriveFile[]> {
		let q = `'${esc(parent)}' in parents and trashed=false`;
		if (name !== undefined) q += ` and name='${esc(name)}'`;
		if (folder !== undefined) q += ` and mimeType${folder ? '=' : '!='}'${FOLDER}'`;
		const out: DriveFile[] = [];
		let pageToken = '';
		do {
			const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000' });
			if (pageToken) params.set('pageToken', pageToken);
			const j = body<{ files?: DriveFile[]; nextPageToken?: string }>(await this.call({ url: `${API}/files?${params}` }));
			out.push(...(j.files ?? []));
			pageToken = j.nextPageToken ?? '';
		} while (pageToken);
		return out;
	}

	/** Newest child with that name (Drive allows duplicates). */
	async findChild(parent: string, name: string, folder: boolean): Promise<DriveFile | undefined> {
		return newest(await this.list(parent, name, folder));
	}

	async mkdir(parent: string, name: string): Promise<string> {
		const res = await this.call({ url: `${API}/files?fields=id`, method: 'POST', contentType: JSON_TYPE, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
		return body<{ id: string }>(res).id;
	}

	/** Creates (`{parent, name}`) or overwrites (`{id}`) a file; sets modifiedTime. */
	async upload(data: Uint8Array, mtime: number, target: { id: string } | { parent: string; name: string }): Promise<DriveFile> {
		const modifiedTime = new Date(mtime).toISOString();
		const [url, method, meta] = 'id' in target
			? [`${UPLOAD}/files/${target.id}`, 'PATCH', { modifiedTime }]
			: [`${UPLOAD}/files`, 'POST', { name: target.name, parents: [target.parent], modifiedTime }];
		if (data.byteLength <= MULTIPART_MAX) {
			const boundary = `cds${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
			const res = await this.call({ url: `${url}?uploadType=multipart&fields=${FIELDS}`, method, contentType: `multipart/related; boundary=${boundary}`, body: multipart(meta, data, boundary) });
			return body<DriveFile>(res);
		}
		const init = await this.call({ url: `${url}?uploadType=resumable&fields=${FIELDS}`, method, contentType: JSON_TYPE, body: JSON.stringify(meta) });
		const loc = Object.entries(init.headers).find(([k]) => k.toLowerCase() === 'location')?.[1];
		if (!loc) throw new Error('Google Drive: resumable upload returned no Location');
		// ponytail: a retried PUT reuses the session; if Google rejects it the sync errors and the next run re-uploads. Add chunked resume if big files flake.
		return body<DriveFile>(await this.call({ url: loc, method: 'PUT', contentType: 'application/octet-stream', body: buf(data) }));
	}

	/** Metadata by id; undefined if deleted. */
	async get(id: string): Promise<(DriveFile & { parents: string[]; trashed: boolean }) | undefined> {
		try {
			return body<DriveFile & { parents: string[]; trashed: boolean }>(await this.call({ url: `${API}/files/${id}?fields=${FIELDS},parents,trashed` }));
		} catch (e) {
			if ((e as { status?: number }).status === 404) return undefined;
			throw e;
		}
	}

	async download(id: string): Promise<Uint8Array> {
		return new Uint8Array((await this.call({ url: `${API}/files/${id}?alt=media` })).arrayBuffer);
	}

	/** Moves to another folder, optionally renaming in the same request. */
	async move(id: string, from: string, to: string, name?: string): Promise<void> {
		await this.call({ url: `${API}/files/${id}?addParents=${to}&removeParents=${from}&fields=id`, method: 'PATCH', contentType: JSON_TYPE, body: JSON.stringify(name ? { name } : {}) });
	}
}

// ---------- RemoteFs over rclone crypt ----------

/** The crypt root isn't visible: wrong path, or created by another OAuth client (drive.file sees only this app's files). */
export class RootMissingError extends Error {
	constructor(root: string) {
		super(T.rootMissing(root));
	}
}

export interface CryptDriveConfig {
	rootPath: string; // plain Drive path of the crypt root, e.g. "encrypted" (rclone: crypt remote = drive:encrypted)
	folder: string; // plaintext path inside the crypt, e.g. "Obsidian"
	trashDir: string; // plaintext, sibling of `folder`, e.g. "_deleted"
	createRoot?: boolean; // user confirmed: a missing root may be created (first use without rclone)
	dirNameEncrypt?: boolean; // false → folder names are plain, so the root check below can't apply
}

type CryptLike = Pick<Crypt, 'encryptPath' | 'decryptPath' | 'encryptData' | 'decryptData'>;

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local, like `date +%F`
}

/**
 * Plaintext vault paths in, encrypted names on Drive. Names go through `crypt.encryptPath`/`decryptPath`
 * on whole paths only, so `dirNameEncrypt` is handled by Crypt. Caches are per sync: reset by `list()`.
 * `decryptedSize` = `Crypt.decryptedSize` (injected so tests don't load real crypto).
 */
export class CryptDriveFs implements RemoteFs {
	private drive: DriveClient;
	private crypt: CryptLike;
	private cfg: CryptDriveConfig;
	private decryptedSize: (encSize: number) => number;
	private dirs = new Map<string, string>(); // Drive path of names from My Drive → folder id
	private files = new Map<string, { id: string; parent: string }>(); // plaintext vault path → ids
	private listed = false; // after list(), `files` is complete: missing = new file

	constructor(drive: DriveClient, crypt: CryptLike, cfg: CryptDriveConfig, decryptedSize: (encSize: number) => number) {
		const norm = (p: string) => p.split('/').filter(Boolean).join('/');
		this.drive = drive; this.crypt = crypt; this.decryptedSize = decryptedSize;
		this.cfg = { rootPath: norm(cfg.rootPath), folder: norm(cfg.folder), trashDir: norm(cfg.trashDir) };
	}

	async list(): Promise<{ files: Map<string, RemoteEntry>; warnings: string[] }> {
		this.dirs.clear(); this.files.clear(); this.listed = false;
		const files = new Map<string, RemoteEntry>();
		const warnings: string[] = [];
		const root = this.cfg.rootPath.split('/').filter(Boolean);
		// drive.file sees only this Cloud project's files: a missing root means wrong path or wrong OAuth client.
		// Don't silently create a second root folder.
		const rootId = await this.dirId(root, false);
		if (!rootId) {
			if (this.cfg.createRoot) return { files: new Map(), warnings: [] }; // write() creates it
			throw new RootMissingError(this.cfg.rootPath);
		}
		// Wrong key → the vault folder's encrypted name differs → "not found" → we'd upload everything into a
		// parallel folder. So: a non-empty crypt root where nothing decrypts is a wrong key, not a fresh setup.
		// With plain folder names (dirNameEncrypt=false) a wrong key is still caught in walk() on the first file name.
		const children = this.cfg.dirNameEncrypt === false ? [] : await this.drive.list(rootId);
		if (children.length && !children.some((c) => { try { this.crypt.decryptPath(c.name); return true; } catch { return false; } })) {
			throw new Error("can't decrypt names in the crypt root — wrong password, salt or folder-name encryption setting");
		}
		const top = this.loc('_').dir; // encryptPath treats the last segment as a file name; a dummy one leaves the folder segments right
		const id = await this.dirId(top, false);
		if (id) await this.walk(id, '', [], files, warnings);
		this.listed = true;
		return { files, warnings };
	}

	// ponytail: sequential walk, one request per folder; parallelize or use the Changes API if big vaults list slowly.
	// `chain` = folder ids from the vault folder down to `id`.
	private async walk(id: string, encRel: string, chain: string[], out: Map<string, RemoteEntry>, warnings: string[]): Promise<void> {
		for (const f of await this.drive.list(id)) {
			const rel = encRel ? `${encRel}/${f.name}` : f.name;
			if (f.mimeType === FOLDER) {
				await this.walk(f.id, rel, [...chain, f.id], out, warnings);
				continue;
			}
			if (f.mimeType.startsWith('application/vnd.google-apps.')) continue; // Google Docs etc. have no bytes
			let path: string;
			// NFC: rclone on macOS may have stored NFD names; NFD+NFC twins collapse into a duplicate below.
			try { path = this.crypt.decryptPath(rel).normalize('NFC'); } catch {
				throw new Error("can't decrypt names — wrong password or foreign files in folder");
			}
			// Cache folder ids under the canonical (NFC re-encrypted) names, so dirId() finds NFD-stored folders
			// too. Empty folders aren't cached; an NFD one gets an NFC twin on write, which rclone merges.
			const dir = this.loc(path).dir;
			chain.forEach((cid, i) => this.dirs.set(dir.slice(0, dir.length - chain.length + i + 1).join('/'), cid));
			const e = this.entry(f);
			const old = out.get(path);
			if (old) {
				warnings.push(T.duplicate(path));
				if (!newer(e, old)) continue;
			}
			out.set(path, e);
			this.files.set(path, { id: f.id, parent: id });
		}
	}

	async stat(path: string): Promise<RemoteEntry | undefined> {
		const f = (await this.find(path))?.f;
		return f && this.entry(f);
	}

	async read(path: string): Promise<Uint8Array> {
		const id = (this.files.get(path) ?? (await this.find(path)))?.id;
		if (!id) throw new Error(`Not on Drive: ${path}`);
		return this.crypt.decryptData(await this.drive.download(id));
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<RemoteEntry> {
		const { dir, name } = this.loc(path);
		const parent = (await this.dirId(dir, true))!;
		const id = this.files.get(path)?.id ?? (this.listed ? undefined : (await this.drive.findChild(parent, name, false))?.id);
		const f = await this.drive.upload(this.crypt.encryptData(data), mtime, id ? { id } : { parent, name });
		this.files.set(path, { id: f.id, parent });
		return this.entry(f);
	}

	async trash(path: string): Promise<void> {
		const known = this.files.get(path) ?? (await this.find(path));
		if (!known) return; // already gone
		const prefix = `${this.cfg.trashDir}/${today()}/${this.cfg.folder}`;
		const target = this.loc(path, prefix);
		const to = (await this.dirId(target.dir, true))!;
		// Same path trashed twice in a day: keep both, the later one gets a time suffix ("note 153012.md").
		let name: string | undefined;
		if (await this.drive.findChild(to, target.name, false)) {
			const d = new Date();
			const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
			const slash = path.lastIndexOf('/') + 1;
			const dot = path.lastIndexOf('.');
			const cut = dot > slash ? dot : path.length;
			name = this.loc(`${path.slice(0, cut)} ${t}${path.slice(cut)}`, prefix).name;
		}
		await this.drive.move(known.id, known.parent, to, name);
		this.files.delete(path);
	}

	/** Drive location of a plaintext path under `prefix` (default: the vault folder). */
	private loc(path: string, prefix = this.cfg.folder): { dir: string[]; name: string } {
		const enc = this.crypt.encryptPath(`${prefix}/${path}`).split('/');
		return { dir: [...this.cfg.rootPath.split('/').filter(Boolean), ...enc.slice(0, -1)], name: enc[enc.length - 1]! };
	}

	private async find(path: string): Promise<{ id: string; parent: string; f: DriveFile } | undefined> {
		// Known from list(): look up by id, since the stored name may be NFD and wouldn't match encryptPath's NFC name.
		const known = this.files.get(path);
		if (known) {
			const f = await this.drive.get(known.id);
			if (f && !f.trashed && f.parents.includes(known.parent)) return { ...known, f };
			this.files.delete(path); // deleted, or moved/trashed by another device
		}
		const { dir, name } = this.loc(path);
		const parent = await this.dirId(dir, false);
		const f = parent ? await this.drive.findChild(parent, name, false) : undefined;
		if (!parent || !f) return undefined;
		this.files.set(path, { id: f.id, parent }); // so a following write() updates it instead of adding a twin
		return { id: f.id, parent, f };
	}

	/** Walks names from My Drive root, creating missing folders if asked. */
	private async dirId(names: string[], create: boolean): Promise<string | undefined> {
		let id = 'root';
		for (let i = 0; i < names.length; i++) {
			const key = names.slice(0, i + 1).join('/');
			let next = this.dirs.get(key) ?? (await this.drive.findChild(id, names[i]!, true))?.id;
			if (!next) {
				if (!create) return undefined;
				next = await this.drive.mkdir(id, names[i]!);
			}
			this.dirs.set(key, next);
			id = next;
		}
		return id;
	}

	private entry(f: DriveFile): RemoteEntry {
		return { id: f.id, md5: f.md5Checksum ?? '', mtime: Date.parse(f.modifiedTime), size: this.decryptedSize(Number(f.size ?? 0)) };
	}
}
