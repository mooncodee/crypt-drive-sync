import { Modal, Notice, Platform, Plugin, Setting, getLanguage, normalizePath, requestUrl, setIcon, setTooltip } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { Crypt } from './crypt.ts';
import { CryptDriveFs, DriveClient, GoogleAuth, RootMissingError, parseRefreshToken, pollDeviceLogin, startDeviceLogin } from './drive.ts';
import type { Request } from './drive.ts';
import { T, setLanguage } from './i18n.ts';
import { CryptDriveSyncSettingTab, DEFAULTS } from './settings.ts';
import type { Settings } from './settings.ts';
import { apply, plan } from './sync.ts';
import type { Action, Plan } from './sync.ts';
import type { BaseEntry, LocalEntry, LocalFs, RemoteEntry } from './types.ts';
import { SetupWizard } from './wizard.ts';

// Secrets live in Obsidian's SecretStorage: per device, never in the vault.
// Keys are namespaced per vault (see sid()): SecretStorage is app-wide, and each vault may use its own password/sign-in.
const TOKEN_ID = 'token';
export const PASSWORD_ID = 'password';
export const SALT_ID = 'salt';
export const CLIENT_SECRET_ID = 'client-secret';
// Built-in OAuth client (identifies the app, not the user), baked in at build time from google-client.json
// (see esbuild.config.mjs); empty if built without it. Installed-app client secrets aren't confidential.
declare const GOOGLE_CLIENT: { id: string; secret: string };
const MIN_DELETE_COUNT = 10;
const req = requestUrl as unknown as Request;

export default class CryptDriveSync extends Plugin {
	settings: Settings = { ...DEFAULTS };
	lastResult = '';
	private base = new Map<string, BaseEntry>();
	private running = false;
	private lastSyncAt = 0;
	private logLines: string[] = [];
	private status?: { el: HTMLElement; icon: HTMLElement; text: HTMLElement };
	private crypt?: { key: string; crypt: Crypt };
	private editTimer = 0;
	private editedDuringSync = false;
	private createRoot = false; // user confirmed creating a missing crypt root (this session)

	async onload() {
		setLanguage(getLanguage());
		this.lastResult = T.never;
		this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
		if (!this.settings.folder) this.settings.folder = this.app.vault.getName();
		this.base = await this.loadBase();
		this.addSettingTab(new CryptDriveSyncSettingTab(this));

		this.addRibbonIcon('refresh-cw', T.ribbon, () => void this.sync());
		if (!Platform.isMobile) {
			// Status bar (desktop only): lock icon + "Crypt ✓ 10:29"; click = sync now.
			const el = this.addStatusBarItem();
			el.addClass('mod-clickable', 'cds-status');
			const icon = el.createSpan({ cls: 'cds-status-icon' });
			setIcon(icon, 'lock');
			this.status = { el, icon, text: el.createSpan() };
			this.setStatus(T.statusIdle, T.statusTip(this.lastResult));
			this.registerDomEvent(el, 'click', () => void this.sync());
		}
		this.addCommand({ id: 'sync-now', name: T.cmdSync, callback: () => void this.sync() });
		this.addCommand({ id: 'show-plan', name: T.cmdPlan, callback: () => void this.sync({ dryRun: true }) });
		this.addCommand({ id: 'show-log', name: T.cmdLog, callback: () => this.openLog() });
		this.addCommand({ id: 'reset-state', name: T.cmdReset, callback: () => void this.resetState(true) });
		this.addCommand({ id: 'setup', name: T.cmdWizard, callback: () => this.openWizard() });
		this.addCommand({ id: 'forget-device', name: T.forgetName, callback: () => void this.forgetDevice() });

		// Triggers: start, interval, after edits, returning to the app (iOS suspends us in background).
		this.app.workspace.onLayoutReady(() => {
			if (!this.ready()) {
				if (!this.settings.wizardDone) this.openWizard(); // first run: guide instead of failing silently
			} else if (this.settings.syncOnStart) void this.sync({ quiet: true });
			const onEdit = () => {
				if (!this.settings.afterEditSec) return;
				if (this.running) {
					this.editedDuringSync = true; // our own writes land here too; costs one extra no-op sync
					return;
				}
				window.clearTimeout(this.editTimer);
				this.editTimer = window.setTimeout(() => void this.sync({ quiet: true }), this.settings.afterEditSec * 1000);
			};
			for (const ev of ['create', 'modify', 'delete', 'rename'] as const) this.registerEvent(this.app.vault.on(ev as 'create', onEdit));
		});
		this.registerInterval(window.setInterval(() => {
			const min = this.settings.intervalMin;
			if (min > 0 && Date.now() - this.lastSyncAt >= min * 60_000) void this.sync({ quiet: true });
		}, 60_000));
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible' && Date.now() - this.lastSyncAt > 60_000) void this.sync({ quiet: true });
		});
	}

	onunload() {
		window.clearTimeout(this.editTimer);
	}

	// ---------- sync ----------

	async sync(opts: { quiet?: boolean; dryRun?: boolean } = {}): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.editedDuringSync = false;
		this.setStatus(T.statusRunning, T.statusTip(this.lastResult), true);
		const base = this.base; // resetState() swaps the map; a sync still holding the old one must not save it
		let again = false;
		try {
			const remote = await this.remote(!opts.quiet); // background triggers stay silent until set up
			if (!remote) return;
			const local = new VaultFs(this.app);
			const [l, r] = await Promise.all([local.list(), remote.list()]);
			const warnings = [...r.warnings, ...this.filter(l, r.files)];
			const opts1 = { minDeleteCount: MIN_DELETE_COUNT, maxDeletePct: this.settings.maxDeletePct };
			let p = plan(l, r.files, base, opts1);
			p.warnings.unshift(...warnings);
			p.warnings.forEach((w) => this.log(`⚠ ${w}`));

			if (opts.dryRun) {
				await new PlanModal(this.app, p, false).ask();
				return;
			}
			if (p.blocked || (this.settings.confirmPlan && p.actions.length)) {
				const remoteGone = r.files.size === 0 && base.size > 0;
				if (!(await new PlanModal(this.app, p, !remoteGone).ask())) {
					this.finish(p.blocked ? T.stopped(p.blocked) : T.cancelled, true);
					return;
				}
				p = { ...plan(l, r.files, base, { minDeleteCount: Infinity, maxDeletePct: 100 }), warnings: p.warnings };
			}
			if (!p.actions.length) {
				this.finish(T.noChanges, !opts.quiet);
				return;
			}

			const res = await apply(p, local, remote, base, {
				deviceName: this.settings.deviceName || this.defaultDeviceName(),
				now: () => new Date(),
				saveBase: async () => {
					if (base !== this.base) throw new Error(T.staleSettings);
					await this.saveBase();
				},
				onProgress: (done, total) => this.setStatus(`${T.statusRunning} ${done}/${total}`, T.statusTip(this.lastResult), true),
				log: (m) => this.log(m),
			});
			const n = (t: Action['type']) => p.actions.filter((a) => a.type === t).length;
			const parts = T.summary(n('upload'), n('download'));
			if (n('trashRemote') + n('trashLocal')) parts.push(T.sumTrashed(n('trashRemote') + n('trashLocal')));
			if (res.conflicts.length) parts.push(T.sumConflicts(res.conflicts.length));
			if (res.errors.length) parts.push(T.sumErrors(res.errors.length));
			this.finish(parts.join(', '), true);
		} catch (e) {
			if (e instanceof RootMissingError && !opts.dryRun && (await this.askCreateRoot())) again = true;
			else this.finish(T.error(humanError(e)), true, true);
		} finally {
			this.running = false;
			if (again) void this.sync(opts);
			if (this.editedDuringSync && this.settings.afterEditSec) {
				window.clearTimeout(this.editTimer);
				this.editTimer = window.setTimeout(() => void this.sync({ quiet: true }), this.settings.afterEditSec * 1000);
			}
		}
	}

	/**
	 * Excludes, dotfiles and size limit. A path skipped on EITHER side is dropped from BOTH,
	 * so it becomes `forget` (never a trash): a file that outgrew the limit must not be deleted elsewhere.
	 */
	private filter(l: Map<string, LocalEntry>, r: Map<string, RemoteEntry>): string[] {
		const ex = globs(this.settings.exclude);
		const max = this.settings.maxFileMb * 1024 * 1024;
		const warnings: string[] = [];
		for (const path of new Set([...l.keys(), ...r.keys()])) {
			const big = (l.get(path)?.size ?? 0) > max || (r.get(path)?.size ?? 0) > max;
			if (path.split('/').some((seg) => seg.startsWith('.')) || ex.some((g) => g.test(path)) || big) {
				l.delete(path);
				r.delete(path);
				if (big) warnings.push(T.tooBig(this.settings.maxFileMb, path));
			}
		}
		return warnings;
	}

	private finish(msg: string, notify: boolean, failed = false) {
		this.lastSyncAt = Date.now();
		this.lastResult = `${new Date().toLocaleString()}: ${msg}`;
		this.log(msg);
		if (failed) console.error(`crypt-drive-sync: ${msg}`);
		this.setStatus(failed ? T.statusError : T.statusOk(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), T.statusTip(this.lastResult));
		if (notify) new Notice(`${T.noticePrefix}: ${msg}`);
	}

	private setStatus(text: string, tip: string, running = false) {
		if (!this.status) return;
		this.status.text.setText(text);
		this.status.el.toggleClass('is-running', running);
		setTooltip(this.status.el, tip, { placement: 'top' });
	}

	log(msg: string) {
		this.logLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
		if (this.logLines.length > 500) this.logLines.shift();
	}

	// ---------- remote, secrets, state ----------

	/** SecretStorage id for this vault on this device (lowercase, digits, dashes). */
	private sid(key: string): string {
		return `crypt-drive-sync-${this.deviceId()}-${key}`;
	}

	secret(key: string): string {
		const v = this.app.secretStorage.getSecret(this.sid(key));
		if (v !== null) return v;
		// ponytail: pre-release builds used global ids; copy once. Drop after 1.0.
		const old = this.app.secretStorage.getSecret(`crypt-drive-sync-${key}`) ?? '';
		if (old) this.storeSecret(key, old);
		return old;
	}

	private storeSecret(key: string, value: string) {
		this.app.secretStorage.setSecret(this.sid(key), value);
	}

	/** Password/salt changed → different remote keys → forget sync state. */
	async setSecret(key: string, value: string): Promise<void> {
		this.storeSecret(key, value);
		if (key === PASSWORD_ID || key === SALT_ID) await this.resetState();
	}

	private async getCrypt(): Promise<Crypt | undefined> {
		const password = this.secret(PASSWORD_ID);
		if (!password) return undefined;
		const salt = this.secret(SALT_ID);
		const key = JSON.stringify([password, salt, this.settings.dirNameEncrypt]);
		if (this.crypt?.key !== key) this.crypt = { key, crypt: await Crypt.create({ password, salt, dirNameEncrypt: this.settings.dirNameEncrypt }) };
		return this.crypt.crypt;
	}

	ready(): boolean {
		return this.hasClient() && this.isLoggedIn() && !!this.secret(PASSWORD_ID);
	}

	hasBuiltinClient(): boolean {
		return !!GOOGLE_CLIENT.id;
	}

	hasClient(): boolean {
		const c = this.client();
		return !!c.id && !!c.secret;
	}

	/** Own OAuth client. A new client ID invalidates the sign-in (tokens belong to a client). Empty secret = keep. */
	async setClient(id: string, secret: string): Promise<void> {
		if (id !== this.settings.clientId) {
			this.settings.clientId = id;
			await this.saveData(this.settings);
			this.logout();
		}
		if (secret) this.storeSecret(CLIENT_SECRET_ID, secret);
	}

	private async remote(report = true): Promise<CryptDriveFs | undefined> {
		const s = this.settings;
		const missing = !this.hasClient() ? T.needClient : !this.isLoggedIn() ? T.needLogin : !this.secret(PASSWORD_ID) ? T.needPassword : '';
		if (missing) {
			if (report) this.finish(T.notConfigured(missing), true);
			return undefined;
		}
		const c = this.client();
		const auth = new GoogleAuth(req, c.id, c.secret, this.secret(TOKEN_ID));
		const crypt = (await this.getCrypt())!;
		return new CryptDriveFs(new DriveClient(req, auth), crypt, { rootPath: s.rootPath, folder: s.folder, trashDir: s.trashDir, createRoot: this.createRoot, dirNameEncrypt: s.dirNameEncrypt }, (n) => Crypt.decryptedSize(n));
	}

	private client(): { id: string; secret: string } {
		const id = this.settings.clientId.trim();
		return id ? { id, secret: this.secret(CLIENT_SECRET_ID) } : GOOGLE_CLIENT;
	}

	isLoggedIn(): boolean {
		return !!this.secret(TOKEN_ID);
	}

	logout() {
		this.storeSecret(TOKEN_ID, '');
	}

	async login(): Promise<void> {
		const c = this.client();
		if (!this.hasClient()) {
			new Notice(T.noBuiltinClient);
			return;
		}
		const token = await new LoginModal(this.app, c.id, c.secret).ask();
		if (token) {
			this.storeSecret(TOKEN_ID, token);
			new Notice(T.googleConnected);
		}
	}

	/** First use without rclone: the crypt root doesn't exist yet. Creating it when rclone made one we can't see would fork the data. */
	private async askCreateRoot(): Promise<boolean> {
		const ok = await new ConfirmModal(this.app, T.rootTitle, T.rootText(this.settings.rootPath), T.create).ask();
		if (ok) this.createRoot = true;
		return ok;
	}

	/** Read-only check of sign-in + password against the cloud, in plain words. */
	async probe(): Promise<{ ok: boolean; text: string }> {
		try {
			const remote = await this.remote(false);
			if (!remote) return { ok: false, text: T.probeNeedSetup };
			const { files, warnings } = await remote.list();
			warnings.forEach((w) => this.log(`⚠ ${w}`));
			return { ok: true, text: files.size ? T.probeOkFiles(files.size) : T.probeOkEmpty };
		} catch (e) {
			if (e instanceof RootMissingError) return { ok: true, text: T.probeNoRoot(this.settings.rootPath) };
			return { ok: false, text: `✗ ${humanError(e)}` };
		}
	}

	async check(): Promise<void> {
		new Notice((await this.probe()).text);
	}

	openWizard(onDone: () => void = () => {}) {
		new SetupWizard(this, onDone).open();
	}

	/** Back to a fresh install on this device: secrets, settings and sync state. Notes and the cloud are untouched. */
	async forgetDevice(onDone: () => void = () => {}): Promise<void> {
		if (!(await new ConfirmModal(this.app, T.forgetName, T.forgetConfirm, T.forgetButton).ask())) return;
		for (const key of [TOKEN_ID, PASSWORD_ID, SALT_ID, CLIENT_SECRET_ID]) {
			this.storeSecret(key, '');
			this.app.secretStorage.setSecret(`crypt-drive-sync-${key}`, ''); // pre-release global id
		}
		this.settings = { ...DEFAULTS, folder: this.app.vault.getName() };
		await this.saveData(this.settings);
		await this.resetState();
		this.crypt = undefined;
		this.createRoot = false;
		this.lastResult = T.never;
		onDone();
		this.openWizard(onDone);
	}

	async markWizardDone(): Promise<void> {
		if (this.settings.wizardDone) return;
		this.settings.wizardDone = true;
		await this.saveData(this.settings);
	}

	/** Where the vault lives in Drive. A different place = a different remote → forget sync state. */
	async setLocation(rootPath: string, folder: string): Promise<void> {
		if (rootPath === this.settings.rootPath && folder === this.settings.folder) return;
		Object.assign(this.settings, { rootPath, folder });
		await this.saveData(this.settings);
		await this.resetState();
	}

	openLog() {
		new TextModal(this.app, T.logTitle, this.logLines.join('\n') || T.logEmpty).open();
	}

	async resetState(notify = false): Promise<void> {
		this.base = new Map();
		await this.saveBase();
		if (notify) new Notice(T.stateReset);
	}

	defaultDeviceName(): string {
		if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
		if (Platform.isAndroidApp) return 'Android';
		return Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows' : 'Linux';
	}

	// Sync state lives next to data.json, per device. ponytail: whole map rewritten after each action; fine for thousands of files.
	private get statePath() {
		return normalizePath(`${this.manifest.dir}/state.json`);
	}

	// state.json is bound to this device via localStorage: a plugin folder copied from another device
	// (e.g. installing via Finder) must not bring that device's base, or files missing here would be trashed everywhere.
	private deviceId(): string {
		let id = this.app.loadLocalStorage('crypt-drive-sync-device') as string | null;
		if (!id) {
			id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
			this.app.saveLocalStorage('crypt-drive-sync-device', id);
		}
		return id;
	}

	private async loadBase(): Promise<Map<string, BaseEntry>> {
		try {
			const st = JSON.parse(await this.app.vault.adapter.read(this.statePath)) as { device?: string; base?: Record<string, BaseEntry> };
			if (st.device === this.deviceId() && st.base) return new Map(Object.entries(st.base));
		} catch {
			// no state yet
		}
		return new Map();
	}

	private async saveBase(): Promise<void> {
		await this.app.vault.adapter.write(this.statePath, JSON.stringify({ device: this.deviceId(), base: Object.fromEntries(this.base) }));
	}
}

/**
 * LocalFs over the Vault API. Keys are NFC; macOS may hand us NFD paths, so keep the real path per key (files and folders).
 * mtime/size always come from adapter.stat — the same source in list(), stat() and after write(), so base converges
 * even if the vault cache lags or the OS ignores the requested mtime.
 */
class VaultFs implements LocalFs {
	private app: App;
	private real = new Map<string, string>(); // NFC path → real path (files and folders)

	constructor(app: App) {
		this.app = app;
	}

	private path(p: string): string {
		return this.real.get(p) ?? p;
	}

	async list(): Promise<Map<string, LocalEntry>> {
		const out = new Map<string, LocalEntry>();
		this.real.clear();
		for (const f of this.app.vault.getAllLoadedFiles()) if (f.path !== '/') this.real.set(f.path.normalize('NFC'), f.path);
		// ponytail: one adapter.stat per file per sync (~ms each on iOS); fine for thousands of notes.
		for (const f of this.app.vault.getFiles()) {
			const e = await this.stat(f.path.normalize('NFC'));
			if (e) out.set(f.path.normalize('NFC'), e);
		}
		return out;
	}

	async stat(path: string): Promise<LocalEntry | undefined> {
		const st = await this.app.vault.adapter.stat(this.path(path));
		return st?.type === 'file' ? { mtime: st.mtime, size: st.size } : undefined;
	}

	private file(path: string): TFile | null {
		return this.app.vault.getFileByPath(this.path(path));
	}

	async read(path: string): Promise<Uint8Array> {
		const f = this.file(path);
		if (!f) throw new Error(`not on this device: ${path}`);
		return new Uint8Array(await this.app.vault.readBinary(f));
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<LocalEntry> {
		const buf = data.slice().buffer;
		const f = this.file(path);
		if (f) await this.app.vault.modifyBinary(f, buf, { mtime });
		else {
			const segs = path.split('/');
			let dir = '';
			for (let i = 1; i < segs.length; i++) {
				const key = segs.slice(0, i).join('/');
				const real = this.real.get(key) ?? (dir ? `${dir}/${segs[i - 1]!}` : segs[i - 1]!);
				if (!this.app.vault.getFolderByPath(real)) await this.app.vault.createFolder(real);
				this.real.set(key, real);
				dir = real;
			}
			const real = dir ? `${dir}/${segs[segs.length - 1]!}` : path;
			await this.app.vault.createBinary(real, buf, { mtime });
			this.real.set(path, real);
		}
		const st = await this.stat(path);
		if (!st) throw new Error(`write failed: ${path}`);
		return st;
	}

	async trash(path: string): Promise<void> {
		const f = this.file(path);
		// Obeys Obsidian's "Deleted files" setting. Safety net is remote: the deleting device already moved
		// the cloud copy to <trashDir>/<date>/, and Drive keeps revisions for 30 days.
		if (f) await this.app.fileManager.trashFile(f);
	}
}

/** Engine/Google errors → what the user should do, in their language. Unknown errors pass through. */
export function humanError(e: unknown): string {
	const m = e instanceof Error ? e.message : String(e);
	const rules: [RegExp, string][] = [
		[/can't decrypt names/, T.errWrongPassword],
		[/login expired or revoked/, T.errLoginExpired],
		[/access denied/, T.errAccessDenied],
		[/code expired/, T.errCodeExpired],
		[/Google Drive 403/, T.errForbidden],
		[/Google Drive 5\d\d|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|offline|timed out/i, T.errOffline],
	];
	return rules.find(([re]) => re.test(m))?.[1] ?? m;
}

/** `*` = anything but `/`, `**` = anything, `?` = one char. A pattern matches the path or any folder prefix. */
export function globs(text: string): RegExp[] {
	return text.split('\n').map((s) => s.trim()).filter(Boolean).map((g) => {
		const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
		return new RegExp(`^${re}(/|$)`);
	});
}

class TextModal extends Modal {
	constructor(app: App, title: string, text: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('pre', { text, cls: 'cds-pre' });
	}
}

class ConfirmModal extends Modal {
	private ok = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, title: string, text: string, button: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('p', { text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(button).setCta().onClick(() => { this.ok = true; this.close(); }))
			.addButton((b) => b.setButtonText(T.cancel).onClick(() => this.close()));
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => { this.resolve = resolve; this.open(); });
	}

	onClose() {
		this.resolve?.(this.ok);
	}
}


/** Shows the plan; resolves true if the user applies it. */
class PlanModal extends Modal {
	private result = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, p: Plan, canApply: boolean) {
		super(app);
		this.setTitle(T.planTitle);
		const el = this.contentEl;
		if (p.blocked) el.createEl('p', { text: T.stopped(p.blocked), cls: 'mod-warning' });
		for (const w of p.warnings) el.createEl('p', { text: `⚠ ${w}` });
		if (!p.actions.length) el.createEl('p', { text: T.planNothing });
		for (const type of Object.keys(T.actions) as Action['type'][]) {
			const paths = p.actions.filter((a) => a.type === type).map((a) => a.path);
			if (!paths.length) continue;
			const d = el.createEl('details');
			d.createEl('summary', { text: `${T.actions[type]}: ${paths.length}` });
			d.createEl('pre', { text: paths.slice(0, 500).join('\n') + (paths.length > 500 ? `\n${T.more(paths.length - 500)}` : ''), cls: 'cds-pre' });
		}
		const s = new Setting(el);
		if (canApply && p.actions.length) s.addButton((b) => b.setButtonText(T.planApply).setDestructive().setCta().onClick(() => { this.result = true; this.close(); }));
		s.addButton((b) => b.setButtonText(canApply ? T.cancel : T.close).onClick(() => this.close()));
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => { this.resolve = resolve; this.open(); });
	}

	onClose() {
		this.resolve?.(this.result);
	}
}

/** Google device flow: show code + link, poll until approved. Fallback: paste a refresh token (e.g. from rclone). */
class LoginModal extends Modal {
	private abort = new AbortController();
	private token = '';
	private resolve?: (token: string) => void;
	private clientId: string;
	private clientSecret: string;

	constructor(app: App, clientId: string, clientSecret: string) {
		super(app);
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.setTitle(T.loginTitle);
	}

	ask(): Promise<string> {
		return new Promise((resolve) => { this.resolve = resolve; this.open(); });
	}

	async onOpen() {
		const el = this.contentEl;
		const status = el.createEl('p', { text: T.loginGettingCode });
		const code = el.createDiv({ cls: 'cds-code' });
		const buttons = new Setting(el);
		let pasted = '';
		new Setting(el).setName(T.loginPaste).setDesc(T.loginPasteDesc)
			.addText((t) => t.onChange((v) => { pasted = v; }))
			.addButton((b) => b.setButtonText(T.save).onClick(() => {
				this.token = parseRefreshToken(pasted);
				if (this.token) this.close();
			}));
		try {
			const login = await startDeviceLogin(req, this.clientId);
			status.setText(T.loginYourCode);
			code.setText(login.userCode);
			// One tap: copy + open in the same user gesture (iOS blocks clipboard/window.open outside a tap).
			buttons.addButton((b) => b.setButtonText(T.loginButton).setCta().onClick(() => {
				navigator.clipboard.writeText(login.userCode).catch(() => status.setText(T.loginCopyFailed));
				window.open(login.verificationUrl);
				status.setText(T.loginCopied);
			}));
			this.token = await pollDeviceLogin(req, this.clientId, this.clientSecret, login, this.abort.signal);
			this.close();
		} catch (e) {
			if (!this.abort.signal.aborted) status.setText(T.error(humanError(e)));
		}
	}

	onClose() {
		this.abort.abort();
		this.contentEl.empty();
		this.resolve?.(this.token);
	}
}
