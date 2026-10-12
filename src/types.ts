// Shared contracts between crypt.ts, drive.ts, sync.ts and main.ts.
// Paths are vault-relative, "/"-separated, NFC-normalized plaintext.

export interface LocalEntry {
	mtime: number; // ms
	size: number; // bytes, plaintext
}

export interface RemoteEntry {
	id: string; // Drive file id
	md5: string; // Drive md5Checksum of the ciphertext; changes on every upload (random nonce)
	mtime: number; // ms, Drive modifiedTime
	size: number; // bytes, plaintext (decrypted size)
}

export interface BaseEntry {
	mtime: number; // local mtime after last sync
	size: number; // local size after last sync
	md5: string; // remote md5 after last sync
}

export interface LocalFs {
	list(): Promise<Map<string, LocalEntry>>;
	stat(path: string): Promise<LocalEntry | undefined>;
	read(path: string): Promise<Uint8Array>;
	/** Creates parent folders as needed; sets mtime. Returns the resulting local entry. */
	write(path: string, data: Uint8Array, mtime: number): Promise<LocalEntry>;
	/** Moves to trash (never hard-deletes). */
	trash(path: string): Promise<void>;
}

export interface RemoteFs {
	/** Throws if any name fails to decrypt (wrong password / foreign files). */
	list(): Promise<{ files: Map<string, RemoteEntry>; warnings: string[] }>;
	stat(path: string): Promise<RemoteEntry | undefined>;
	read(path: string): Promise<Uint8Array>;
	/** Creates or overwrites; creates parent folders as needed; sets modifiedTime = mtime. */
	write(path: string, data: Uint8Array, mtime: number): Promise<RemoteEntry>;
	/** Moves to <trashDir>/<YYYY-MM-DD>/<folder>/<path> inside the crypt root (never hard-deletes). */
	trash(path: string): Promise<void>;
}
