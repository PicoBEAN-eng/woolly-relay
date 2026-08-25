"use strict";

import { Notice, normalizePath, requestUrl } from "obsidian";
import type Live from "./main";
import type { LoginManager } from "./LoginManager";

// Woolly fork (2026-08-24): one-way mirror of the read-only vault.
//
// The hub serves the non-interactive rooms (The Warehouse, WoollyWorkplace,
// ...) as a content-addressed mirror: GET /mirror/manifest (path -> sha256)
// + GET /mirror/blob/<hash>, gated on the PocketBase session token. This
// module pulls that mirror into the vault on startup, on login, and on a
// timer. It NEVER uploads — the hub is the source of truth and local edits
// to mirror files are overwritten when the hub's copy next changes.
//
// Deletion safety: we only ever delete paths recorded in our own state file
// (i.e. files this module wrote). Files a user created locally inside a
// mirror room are left alone. State lives beside the plugin
// (mirror-state.json), NOT in data.json — 8k+ entries would bloat every
// settings save.
//
// Design of record: hub vault note "The Drawing Board/Vault Sync Redesign —
// CRDT + Mirror.md". The interactive-room classifier lives hub-side only;
// this module has no folder-name semantics at all — it trusts the manifest.

type ManifestEntry = { h: string; s: number };
type Manifest = {
	v: number;
	generatedAt: number;
	files: Record<string, ManifestEntry>;
};
type MirrorState = { files: Record<string, string> }; // path -> hash we wrote

const PULL_INTERVAL_MS = 5 * 60_000;
const DOWNLOAD_CONCURRENCY = 6;
const STATE_SAVE_EVERY = 200; // mid-sync checkpoints so interrupts resume

export class MirrorSync {
	private plugin: Live;
	private loginManager: LoginManager;
	private baseUrl: string;
	private statePath: string;
	private state: MirrorState = { files: {} };
	private stateLoaded = false;
	private pulling = false;
	private destroyed = false;
	// Heartbeat: the device-truthful freshness signal (successor to the
	// hub's folder-rename heartbeat, which no sync fabric can carry).
	lastOkAt: number | null = null;
	lastError: string | null = null;

	constructor(plugin: Live, loginManager: LoginManager, baseUrl: string) {
		this.plugin = plugin;
		this.loginManager = loginManager;
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.statePath = normalizePath(
			`${this.plugin.manifest.dir}/mirror-state.json`,
		);
	}

	start() {
		this.plugin.registerInterval(
			window.setInterval(() => void this.pull("interval"), PULL_INTERVAL_MS),
		);
		this.plugin.register(
			this.loginManager.on(() => {
				if (this.loginManager.loggedIn) void this.pull("login");
			}),
		);
		void this.pull("startup");
	}

	destroy() {
		this.destroyed = true;
	}

	private get adapter() {
		return this.plugin.app.vault.adapter;
	}

	private authHeader(): string | null {
		const token = this.loginManager.pb?.authStore?.token;
		return token ? `Bearer ${token}` : null;
	}

	private async loadState() {
		try {
			const raw = await this.adapter.read(this.statePath);
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed.files === "object") this.state = parsed;
		} catch {
			/* first run */
		}
		this.stateLoaded = true;
	}

	private async saveState() {
		try {
			await this.adapter.write(this.statePath, JSON.stringify(this.state));
		} catch (e) {
			console.warn("[mirror] state save failed", e);
		}
	}

	// Reject traversal, empty segments, and dot-entries — the manifest comes
	// from our own hub, but a sync layer must never be one bad path away from
	// writing outside the vault.
	private safePath(p: string): boolean {
		if (!p || p.includes("\\") || p.includes("\0")) return false;
		return !p
			.split("/")
			.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."));
	}

	private async ensureParent(path: string) {
		const segs = path.split("/");
		segs.pop();
		let acc = "";
		for (const seg of segs) {
			acc = acc ? `${acc}/${seg}` : seg;
			if (!(await this.adapter.exists(acc))) {
				try {
					await this.adapter.mkdir(acc);
				} catch {
					/* concurrent create */
				}
			}
		}
	}

	private async download(path: string, hash: string, auth: string) {
		const res = await requestUrl({
			url: `${this.baseUrl}/mirror/blob/${hash}`,
			headers: { Authorization: auth },
			throw: false,
		});
		if (res.status === 409) return false; // disk moved on hub; next beat corrects
		if (res.status !== 200) {
			throw new Error(`blob ${hash.slice(0, 8)} for ${path}: ${res.status}`);
		}
		await this.ensureParent(path);
		await this.adapter.writeBinary(normalizePath(path), res.arrayBuffer);
		this.state.files[path] = hash;
		return true;
	}

	async pull(reason: string) {
		if (this.pulling || this.destroyed) return;
		const auth = this.authHeader();
		if (!auth || !this.loginManager.loggedIn) return;
		this.pulling = true;
		try {
			if (!this.stateLoaded) await this.loadState();
			const res = await requestUrl({
				url: `${this.baseUrl}/mirror/manifest`,
				headers: { Authorization: auth },
				throw: false,
			});
			if (res.status !== 200) {
				this.lastError = `manifest ${res.status}`;
				console.warn(`[mirror] manifest ${res.status} (${reason})`);
				return;
			}
			const manifest = res.json as Manifest;
			if (!manifest || manifest.v !== 1 || !manifest.files) return;
			// A good manifest IS the heartbeat: hub reachable + authed,
			// even when there's nothing new to pull.
			this.lastOkAt = Date.now();
			this.lastError = null;

			const wanted = Object.entries(manifest.files).filter(([p]) =>
				this.safePath(p),
			);
			const toFetch: Array<[string, string]> = [];
			for (const [path, meta] of wanted) {
				// vault index lookup is synchronous and cheap; a tracked file
				// the user deleted locally re-downloads (hub is truth).
				const exists =
					this.plugin.app.vault.getAbstractFileByPath(
						normalizePath(path),
					) !== null;
				if (this.state.files[path] === meta.h && exists) continue;
				toFetch.push([path, meta.h]);
			}
			const manifestSet = new Set(wanted.map(([p]) => p));
			const toDelete = Object.keys(this.state.files).filter(
				(p) => !manifestSet.has(p),
			);

			if (toFetch.length === 0 && toDelete.length === 0) return;
			const big = toFetch.length > 50;
			if (big) {
				new Notice(
					`Woolly mirror: syncing ${toFetch.length} files…`,
					8000,
				);
			}

			let done = 0;
			let failed = 0;
			let sinceSave = 0;
			const queue = [...toFetch];
			const worker = async () => {
				for (;;) {
					const item = queue.shift();
					if (!item || this.destroyed) return;
					try {
						await this.download(item[0], item[1], auth);
					} catch (e) {
						failed++;
						console.warn("[mirror]", e);
						continue;
					}
					done++;
					if (++sinceSave >= STATE_SAVE_EVERY) {
						sinceSave = 0;
						await this.saveState();
					}
				}
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) },
					worker,
				),
			);

			for (const path of toDelete) {
				try {
					const norm = normalizePath(path);
					if (await this.adapter.exists(norm)) {
						await this.adapter.remove(norm);
					}
				} catch (e) {
					console.warn("[mirror] delete failed", path, e);
				}
				delete this.state.files[path];
			}

			await this.saveState();
			console.log(
				`[mirror] ${done} updated, ${toDelete.length} deleted` +
					(failed ? `, ${failed} failed` : "") +
					` (${reason})`,
			);
			if (big) {
				new Notice(
					failed
						? `Woolly mirror: synced ${done}, ${failed} failed (retries on next pull)`
						: `Woolly mirror: synced ${done} files`,
				);
			}
		} catch (e) {
			// offline or tunnel down: quiet — the interval retries.
			this.lastError = e instanceof Error ? e.message : String(e);
			console.warn(`[mirror] pull failed (${reason})`, e);
		} finally {
			this.pulling = false;
		}
	}

	// One-line status for the status bar. Freshness thresholds sit just
	// above the pull cadence: <7 min = healthy, beyond that = stale.
	statusLine(): string {
		if (this.pulling) return "Woolly ⟳ syncing";
		if (!this.loginManager.loggedIn) return "Woolly — signed out";
		if (this.lastOkAt === null) {
			return this.lastError ? `Woolly ✗ ${this.lastError}` : "Woolly …";
		}
		const mins = Math.round((Date.now() - this.lastOkAt) / 60_000);
		const age = mins < 1 ? "now" : `${mins}m`;
		if (this.lastError) return `Woolly ✗ ${age} (${this.lastError})`;
		return mins >= 7 ? `Woolly ⚠ ${age}` : `Woolly ✓ ${age}`;
	}

	statusDetail(): string {
		const files = Object.keys(this.state.files).length;
		const last = this.lastOkAt
			? new Date(this.lastOkAt).toLocaleTimeString()
			: "never";
		return (
			`Woolly mirror — ${files} files tracked\n` +
			`Last successful pull: ${last}` +
			(this.lastError ? `\nLast error: ${this.lastError}` : "")
		);
	}
}
