// Three-way sync: plan() is pure, apply() does the I/O.
import { T } from './i18n.ts';
import type { BaseEntry, LocalEntry, LocalFs, RemoteEntry, RemoteFs } from './types.ts';

export type Action =
	| { type: 'upload'; path: string }
	| { type: 'download'; path: string }
	| { type: 'conflict'; path: string } // both changed (or both new w/o base): resolve during apply
	| { type: 'trashRemote'; path: string }
	| { type: 'trashLocal'; path: string }
	| { type: 'forget'; path: string }; // deleted on both sides → drop from base

export interface PlanOptions { minDeleteCount: number; maxDeletePct: number } // defaults 10 / 20
export interface Plan { actions: Action[]; blocked?: string; warnings: string[] }

const changed = (l: LocalEntry, b: BaseEntry) => l.mtime !== b.mtime || l.size !== b.size;

function decide(l?: LocalEntry, r?: RemoteEntry, b?: BaseEntry): Action['type'] | undefined {
	// No base (first sync or new on both): never trash, both present → conflict (apply compares bytes).
	if (!b) return l && r ? 'conflict' : l ? 'upload' : r ? 'download' : undefined;
	const lc = l && changed(l, b);
	const rc = r && r.md5 !== b.md5;
	if (l && r) return lc && rc ? 'conflict' : lc ? 'upload' : rc ? 'download' : undefined;
	if (l) return lc ? 'upload' : 'trashLocal'; // remote deleted: changed local wins (restore)
	if (r) return rc ? 'download' : 'trashRemote'; // local deleted: changed remote wins (restore)
	return 'forget';
}

export function plan(
	local: Map<string, LocalEntry>,
	remote: Map<string, RemoteEntry>,
	base: Map<string, BaseEntry>,
	opts: PlanOptions,
): Plan {
	const warnings: string[] = [];

	// A.md vs a.md: one file on macOS/iOS, two on Drive → leave them alone.
	const byLower = new Map<string, Set<string>>();
	for (const p of [...local.keys(), ...remote.keys()]) {
		const k = p.toLowerCase();
		byLower.set(k, (byLower.get(k) ?? new Set<string>()).add(p));
	}
	const skip = new Set<string>();
	for (const group of byLower.values()) {
		if (group.size < 2) continue;
		for (const p of group) skip.add(p);
		warnings.push(T.caseCollision([...group].join(', ')));
	}

	const actions: Action[] = [];
	for (const path of new Set([...local.keys(), ...remote.keys(), ...base.keys()])) {
		if (skip.has(path)) continue;
		const type = decide(local.get(path), remote.get(path), base.get(path));
		if (type) actions.push({ type, path });
	}

	let blocked: string | undefined;
	const deletes = actions.filter((a) => a.type === 'trashRemote' || a.type === 'trashLocal').length;
	const limit = Math.max(opts.minDeleteCount, (opts.maxDeletePct / 100) * base.size);
	if (remote.size === 0 && base.size > 0) {
		blocked = T.blockedRemoteEmpty;
	} else if (deletes > limit) {
		blocked = T.blockedMassDelete(deletes, Math.floor(limit));
	}
	return { actions, blocked, warnings };
}

export interface ApplyHooks {
	deviceName: string; // for conflict file names
	now: () => Date;
	saveBase: (base: Map<string, BaseEntry>) => Promise<void>; // called after EVERY applied action
	onProgress?: (done: number, total: number, action: Action) => void;
	log?: (msg: string) => void;
}
export interface ApplyResult { done: number; conflicts: string[]; errors: { path: string; error: string }[] }

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const pad = (n: number) => String(n).padStart(2, '0');

export async function apply(
	p: Plan,
	local: LocalFs,
	remote: RemoteFs,
	base: Map<string, BaseEntry>,
	hooks: ApplyHooks,
): Promise<ApplyResult> {
	if (p.blocked) throw new Error(`Sync blocked: ${p.blocked}`);
	const res: ApplyResult = { done: 0, conflicts: [], errors: [] };

	// Re-check each side right before touching it: the plan may be stale (edits during sync, other devices).
	const editedLocally = (l: LocalEntry | undefined, b: BaseEntry | undefined) => !!l && (!b || changed(l, b));

	const conflictName = async (path: string) => {
		const d = hooks.now();
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
		const slash = path.lastIndexOf('/') + 1;
		const dot = path.lastIndexOf('.');
		const cut = dot > slash ? dot : path.length; // ".hidden" / "README" → no extension
		const stem = `${path.slice(0, cut)} (${T.conflictWord} ${hooks.deviceName.replace(/\//g, '-')} ${stamp})`;
		for (let n = 1; ; n++) {
			const name = `${stem}${n > 1 ? ` ${n}` : ''}${path.slice(cut)}`;
			if (!(await local.stat(name)) && !(await remote.stat(name))) return name;
		}
	};

	const conflict = async (path: string) => {
		const l = await local.stat(path);
		const r = await remote.stat(path);
		if (!l || !r) throw new Error(T.errVanished);
		const ld = await local.read(path);
		const rd = await remote.read(path);
		if (sameBytes(ld, rd)) {
			base.set(path, { mtime: l.mtime, size: l.size, md5: r.md5 });
			return;
		}
		// Remote version → conflict copy on both sides, then local version over path. Both survive.
		const copy = await conflictName(path);
		const ce = await local.write(copy, rd, r.mtime);
		const cr = await remote.write(copy, rd, r.mtime);
		base.set(copy, { mtime: ce.mtime, size: ce.size, md5: cr.md5 });
		if ((await remote.stat(path))?.md5 !== r.md5) throw new Error(T.errChangedAgain);
		const w = await remote.write(path, ld, l.mtime);
		base.set(path, { mtime: l.mtime, size: l.size, md5: w.md5 });
		res.conflicts.push(copy);
		hooks.log?.(T.conflictLog(path, copy));
	};

	const run: Record<Action['type'], (path: string) => Promise<void>> = {
		upload: async (path) => {
			const l = await local.stat(path); // stat before read: a later edit only causes a re-upload
			if (!l) throw new Error(T.errLocalVanished);
			const r = await remote.stat(path);
			if (r && r.md5 !== base.get(path)?.md5) return conflict(path); // someone uploaded meanwhile
			const w = await remote.write(path, await local.read(path), l.mtime);
			base.set(path, { mtime: l.mtime, size: l.size, md5: w.md5 });
		},
		download: async (path) => {
			const r = await remote.stat(path);
			if (!r) throw new Error(T.errRemoteVanished);
			const data = await remote.read(path);
			if (editedLocally(await local.stat(path), base.get(path))) return conflict(path); // edited meanwhile
			const e = await local.write(path, data, r.mtime);
			base.set(path, { mtime: e.mtime, size: e.size, md5: r.md5 });
		},
		conflict,
		trashRemote: async (path) => {
			const r = await remote.stat(path);
			if (r && r.md5 !== base.get(path)?.md5) throw new Error(T.errRemoteChanged);
			if (r) await remote.trash(path);
			base.delete(path);
		},
		trashLocal: async (path) => {
			const l = await local.stat(path);
			if (editedLocally(l, base.get(path))) throw new Error(T.errLocalChanged);
			if (l) await local.trash(path);
			base.delete(path);
		},
		forget: async (path) => {
			base.delete(path);
		},
	};

	const isDelete = (a: Action) => a.type === 'trashRemote' || a.type === 'trashLocal' || a.type === 'forget';
	const queue = [...p.actions.filter((a) => !isDelete(a)), ...p.actions.filter(isDelete)];
	for (const [i, a] of queue.entries()) {
		try {
			await run[a.type](a.path);
			res.done++;
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			res.errors.push({ path: a.path, error });
			hooks.log?.(T.actionFailed(a.type, a.path, error));
		}
		await hooks.saveBase(base); // outside try: if state can't be saved, stop the whole sync
		hooks.onProgress?.(i + 1, queue.length, a);
	}
	return res;
}
