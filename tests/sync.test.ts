import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, plan } from '../src/sync.ts';
import type { Action, ApplyHooks, Plan } from '../src/sync.ts';
import type { BaseEntry, LocalEntry, LocalFs, RemoteEntry, RemoteFs } from '../src/types.ts';

const OPTS = { minDeleteCount: 10, maxDeletePct: 20 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// ---------- in-memory fakes ----------
type File = { data: Uint8Array; mtime: number; md5: string };

class FakeLocal implements LocalFs {
	files = new Map<string, File>();
	failWrite = new Set<string>();
	put(p: string, s: string, mtime = 1) { this.files.set(p, { data: enc(s), mtime, md5: '' }); }
	text(p: string) { const f = this.files.get(p); return f && dec(f.data); }
	async list() {
		return new Map<string, LocalEntry>([...this.files].map(([p, f]) => [p, { mtime: f.mtime, size: f.data.length }]));
	}
	async stat(p: string) { const f = this.files.get(p); return f && { mtime: f.mtime, size: f.data.length }; }
	async read(p: string) {
		const f = this.files.get(p);
		if (!f) throw new Error(`no local ${p}`);
		return f.data;
	}
	async write(p: string, data: Uint8Array, mtime: number) {
		if (this.failWrite.has(p)) throw new Error('disk full');
		this.files.set(p, { data, mtime, md5: '' });
		return { mtime, size: data.length };
	}
	async trash(p: string) { this.files.delete(p); }
}

let md5Counter = 0;
class FakeRemote implements RemoteFs {
	files = new Map<string, File>();
	put(p: string, s: string, mtime = 1) { const f = { data: enc(s), mtime, md5: `m${++md5Counter}` }; this.files.set(p, f); return f.md5; }
	text(p: string) { const f = this.files.get(p); return f && dec(f.data); }
	entry(p: string, f: File): RemoteEntry { return { id: p, md5: f.md5, mtime: f.mtime, size: f.data.length }; }
	async list() {
		return { files: new Map([...this.files].map(([p, f]) => [p, this.entry(p, f)])), warnings: [] };
	}
	async stat(p: string) { const f = this.files.get(p); return f && this.entry(p, f); }
	async read(p: string) {
		const f = this.files.get(p);
		if (!f) throw new Error(`no remote ${p}`);
		return f.data;
	}
	async write(p: string, data: Uint8Array, mtime: number) {
		const f = { data, mtime, md5: `m${++md5Counter}` }; // new md5 on every upload, like crypt's random nonce
		this.files.set(p, f);
		return this.entry(p, f);
	}
	async trash(p: string) { this.files.delete(p); }
}

function hooks(saves: Map<string, BaseEntry>[] = [], order: Action[] = []): ApplyHooks {
	return {
		deviceName: 'Mac',
		now: () => new Date(2026, 9, 12, 21, 30),
		saveBase: async (b) => { saves.push(new Map(b)); },
		onProgress: (_d, _t, a) => { order.push(a); },
	};
}

async function syncOnce(l: FakeLocal, r: FakeRemote, base: Map<string, BaseEntry>, h = hooks()) {
	const p = plan(await l.list(), (await r.list()).files, base, OPTS);
	const res = await apply(p, l, r, base, h);
	return { p, res };
}

async function assertInSync(l: FakeLocal, r: FakeRemote, base: Map<string, BaseEntry>) {
	const p = plan(await l.list(), (await r.list()).files, base, OPTS);
	assert.deepEqual(p.actions, []);
	for (const [path] of l.files) assert.equal(l.text(path), r.text(path), path);
}

// ---------- decision table ----------
const L = (mtime: number, size = 5): LocalEntry => ({ mtime, size });
const R = (md5: string): RemoteEntry => ({ id: 'x', md5, mtime: 1, size: 5 });
const B = (mtime: number, md5: string, size = 5): BaseEntry => ({ mtime, size, md5 });

const rows: [string, LocalEntry | undefined, RemoteEntry | undefined, BaseEntry | undefined, Action['type'] | undefined][] = [
	['unchanged / unchanged', L(1), R('a'), B(1, 'a'), undefined],
	['local changed (mtime) / unchanged', L(2), R('a'), B(1, 'a'), 'upload'],
	['local changed (size only) / unchanged', L(1, 6), R('a'), B(1, 'a'), 'upload'],
	['local new / none', L(1), undefined, undefined, 'upload'],
	['unchanged / remote changed', L(1), R('b'), B(1, 'a'), 'download'],
	['none / remote new', undefined, R('a'), undefined, 'download'],
	['changed / changed', L(2), R('b'), B(1, 'a'), 'conflict'],
	['deleted / unchanged', undefined, R('a'), B(1, 'a'), 'trashRemote'],
	['unchanged / deleted', L(1), undefined, B(1, 'a'), 'trashLocal'],
	['deleted / changed → restore', undefined, R('b'), B(1, 'a'), 'download'],
	['changed / deleted → restore', L(2), undefined, B(1, 'a'), 'upload'],
	['new / new (no base)', L(1), R('a'), undefined, 'conflict'],
	['deleted / deleted', undefined, undefined, B(1, 'a'), 'forget'],
];
for (const [name, l, r, b, want] of rows) {
	test(`table: ${name} → ${want ?? 'nothing'}`, () => {
		const m = <T>(v: T | undefined) => new Map<string, T>(v ? [['n.md', v]] : []);
		// an unrelated in-sync file keeps remote non-empty so guard 1 never fires here
		const local = m(l).set('keep.md', L(1));
		const remote = m(r).set('keep.md', R('k'));
		const base = m(b).set('keep.md', B(1, 'k'));
		const p = plan(local, remote, base, OPTS);
		assert.equal(p.blocked, undefined);
		assert.deepEqual(p.actions, want ? [{ type: want, path: 'n.md' }] : []);
	});
}

// ---------- guards ----------
test('guard: remote empty with non-empty base → blocked, actions still listed', () => {
	const p = plan(new Map([['a.md', L(1)]]), new Map(), new Map([['a.md', B(1, 'a')]]), OPTS);
	assert.match(p.blocked ?? '', /Reset sync state/);
	assert.deepEqual(p.actions, [{ type: 'trashLocal', path: 'a.md' }]);
});

test('guard: remote empty with empty base → first sync, not blocked', () => {
	const p = plan(new Map([['a.md', L(1)]]), new Map(), new Map(), OPTS);
	assert.equal(p.blocked, undefined);
	assert.deepEqual(p.actions, [{ type: 'upload', path: 'a.md' }]);
});

function massDelete(baseSize: number, deleted: number) {
	const local = new Map<string, LocalEntry>(), remote = new Map<string, RemoteEntry>(), base = new Map<string, BaseEntry>();
	for (let i = 0; i < baseSize; i++) {
		const p = `f${i}.md`;
		base.set(p, B(1, 'a'));
		local.set(p, L(1));
		if (i >= deleted) remote.set(p, R('a')); // first `deleted` files gone remotely → trashLocal
	}
	return plan(local, remote, base, OPTS);
}

test('guard: mass delete at 20% of 100 → allowed, 21 → blocked', () => {
	assert.equal(massDelete(100, 20).blocked, undefined);
	const p = massDelete(100, 21);
	assert.match(p.blocked ?? '', /delete 21 files .*limit 20/);
	assert.equal(p.actions.length, 21);
});

test('guard: mass delete min count 10 wins on small base', () => {
	assert.equal(massDelete(20, 10).blocked, undefined);
	assert.match(massDelete(20, 11).blocked ?? '', /limit 10/);
});

test('guard: first sync (empty base) never trashes, overlaps become conflicts', () => {
	const p = plan(new Map([['a.md', L(1)], ['b.md', L(1)]]), new Map([['b.md', R('b')], ['c.md', R('c')]]), new Map(), OPTS);
	assert.equal(p.blocked, undefined);
	assert.deepEqual(p.actions, [
		{ type: 'upload', path: 'a.md' },
		{ type: 'conflict', path: 'b.md' },
		{ type: 'download', path: 'c.md' },
	]);
});

test('guard: case collision → skipped with warning, not blocked', () => {
	const p = plan(new Map([['Notes/A.md', L(1)], ['x.md', L(1)]]), new Map([['notes/a.md', R('a')]]), new Map(), OPTS);
	assert.equal(p.blocked, undefined);
	assert.deepEqual(p.actions, [{ type: 'upload', path: 'x.md' }]);
	assert.equal(p.warnings.length, 1);
	assert.match(p.warnings[0] ?? '', /Notes\/A\.md, notes\/a\.md/);
});

// ---------- apply ----------
test('apply: blocked plan throws and touches nothing', async () => {
	const l = new FakeLocal();
	const saves: Map<string, BaseEntry>[] = [];
	const p: Plan = { actions: [{ type: 'trashLocal', path: 'a.md' }], blocked: 'nope', warnings: [] };
	l.put('a.md', 'x');
	await assert.rejects(apply(p, l, new FakeRemote(), new Map(), hooks(saves)), /blocked/);
	assert.ok(l.files.has('a.md'));
	assert.equal(saves.length, 0);
});

test('apply: conflict keeps both versions on both sides', async () => {
	const l = new FakeLocal(), r = new FakeRemote(), base = new Map<string, BaseEntry>();
	l.put('dir/note.md', 'local text', 5);
	r.put('dir/note.md', 'remote text', 7);
	const copy = 'dir/note (conflict Mac 2026-10-12 2130).md';
	const { res } = await syncOnce(l, r, base);
	assert.deepEqual(res, { done: 1, conflicts: [copy], errors: [] });
	assert.equal(l.text('dir/note.md'), 'local text');
	assert.equal(r.text('dir/note.md'), 'local text');
	assert.equal(l.text(copy), 'remote text');
	assert.equal(r.text(copy), 'remote text');
	await assertInSync(l, r, base);
});

test('apply: conflict name never overwrites an existing file', async () => {
	const l = new FakeLocal(), r = new FakeRemote(), base = new Map<string, BaseEntry>();
	l.put('README', 'L');
	r.put('README', 'R');
	l.put('README (conflict Mac 2026-10-12 2130)', 'older local copy');
	r.put('README (conflict Mac 2026-10-12 2130) 2', 'older remote copy');
	const p: Plan = { actions: [{ type: 'conflict', path: 'README' }], warnings: [] };
	const res = await apply(p, l, r, base, hooks());
	assert.deepEqual(res.conflicts, ['README (conflict Mac 2026-10-12 2130) 3']);
	assert.equal(l.text('README (conflict Mac 2026-10-12 2130)'), 'older local copy');
	assert.equal(r.text('README (conflict Mac 2026-10-12 2130) 2'), 'older remote copy');
	assert.equal(l.text('README (conflict Mac 2026-10-12 2130) 3'), 'R');
});

test('apply: equal-content conflict only records base', async () => {
	const l = new FakeLocal(), r = new FakeRemote(), base = new Map<string, BaseEntry>();
	l.put('a.md', 'same');
	const md5 = r.put('a.md', 'same');
	const { res } = await syncOnce(l, r, base);
	assert.deepEqual(res, { done: 1, conflicts: [], errors: [] });
	assert.equal(l.files.size, 1);
	assert.equal(r.files.size, 1);
	assert.deepEqual(base.get('a.md'), { mtime: 1, size: 4, md5 });
	await assertInSync(l, r, base);
});

test('apply: upload race (remote changed after plan) → conflict, both survive', async () => {
	const l = new FakeLocal(), r = new FakeRemote();
	l.put('a.md', 'my edit', 2);
	const old = r.put('a.md', 'v1');
	const base = new Map([['a.md', B(1, old, 2)]]);
	const p = plan(await l.list(), (await r.list()).files, base, OPTS);
	assert.deepEqual(p.actions, [{ type: 'upload', path: 'a.md' }]);
	r.put('a.md', 'other device edit'); // lands between plan and apply
	const res = await apply(p, l, r, base, hooks());
	assert.equal(res.conflicts.length, 1);
	assert.equal(r.text('a.md'), 'my edit');
	assert.equal(l.text(res.conflicts[0] ?? ''), 'other device edit');
	assert.equal(r.text(res.conflicts[0] ?? ''), 'other device edit');
	await assertInSync(l, r, base);
});

test('apply: local edit after plan is not overwritten by download / trashLocal', async () => {
	const l = new FakeLocal(), r = new FakeRemote();
	l.put('d.md', 'v1');
	l.put('t.md', 'v1');
	const md5 = r.put('d.md', 'v1');
	const base = new Map([['d.md', B(1, md5, 2)], ['t.md', B(1, 'gone', 2)]]);
	r.put('d.md', 'remote v2');
	const p = plan(await l.list(), (await r.list()).files, base, OPTS);
	assert.deepEqual(p.actions.map((a) => a.type), ['download', 'trashLocal']);
	l.put('d.md', 'local v2', 9); // user edits during sync
	l.put('t.md', 'local v2', 9);
	const res = await apply(p, l, r, base, hooks());
	assert.equal(l.text('d.md'), 'local v2');
	assert.equal(l.text(res.conflicts[0] ?? ''), 'remote v2');
	assert.equal(l.text('t.md'), 'local v2');
	assert.deepEqual(res.errors.map((e) => e.path), ['t.md']);
	assert.deepEqual(base.get('t.md'), B(1, 'gone', 2));
});

test('apply: one failing action does not stop others; its base is untouched', async () => {
	const l = new FakeLocal(), r = new FakeRemote(), base = new Map<string, BaseEntry>();
	r.put('a.md', 'A');
	r.put('bad.md', 'B');
	r.put('c.md', 'C');
	l.failWrite.add('bad.md');
	const { res } = await syncOnce(l, r, base);
	assert.equal(res.done, 2);
	assert.deepEqual(res.errors, [{ path: 'bad.md', error: 'disk full' }]);
	assert.equal(l.text('a.md'), 'A');
	assert.equal(l.text('c.md'), 'C');
	assert.ok(!base.has('bad.md'));
	assert.ok(base.has('a.md') && base.has('c.md'));
});

test('apply: saveBase after every action; deletes run last', async () => {
	const l = new FakeLocal(), r = new FakeRemote(), base = new Map<string, BaseEntry>();
	// in sync: keep, gone-local, gone-remote
	for (const p of ['keep.md', 'gl.md', 'gr.md']) {
		l.put(p, p);
		base.set(p, { mtime: 1, size: p.length, md5: r.put(p, p) });
	}
	l.files.delete('gl.md');
	r.files.delete('gr.md');
	l.put('new.md', 'n');
	r.put('down.md', 'd');
	const saves: Map<string, BaseEntry>[] = [], order: Action[] = [];
	const { p, res } = await syncOnce(l, r, base, hooks(saves, order));
	assert.equal(p.actions.length, 4);
	assert.equal(res.done, 4);
	assert.equal(saves.length, 4);
	assert.deepEqual(order.map((a) => a.type).slice(2).sort(), ['trashLocal', 'trashRemote']);
	assert.deepEqual([...(saves.at(-1)?.keys() ?? [])].sort(), ['down.md', 'keep.md', 'new.md']);
	assert.ok(!l.files.has('gr.md') && !r.files.has('gl.md'));
	await assertInSync(l, r, base);
});
