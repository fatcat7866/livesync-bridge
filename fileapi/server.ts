// File API over the Bridge's vault replica (fatcat fork).
//
// Runs as a separate process in the same container as the Bridge. It reads and
// writes the storage peers' directory directly; the Bridge's own watchers pick
// the changes up and carry them to the CouchDB peers, exactly like an edit made
// by any other program on that disk. Nothing here talks to CouchDB.
//
// Design rules (fatcat vault-mcp ⑤, 2026-11-05):
// - Writes go to a temp file on the same volume (outside the watched tree) and
//   are renamed into place, so a watcher never reads a half-written file.
// - Where the API may write is derived from the Bridge config: the storage peer
//   of group "all" and its `ignore` patterns, judged by the same function the
//   Bridge uses (ignorePatterns.ts). No hand-copied deny list.
// - Writes are refused (503) unless the Bridge heartbeat is fresh and ok
//   (fail-closed): a write the Bridge cannot carry would sit on this disk only.
// - Deleted files are copied to a trash directory first.

import { dirname, join, relative } from "@std/path";
import { expandIgnorePatterns, isIgnoredByPatterns } from "../ignorePatterns.ts";

export const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
export const HEALTH_MAX_AGE_MS_DEFAULT = 60_000;
export const SEARCH_LIMIT_MAX = 20;

export interface FileApiOptions {
    /** Absolute path of the storage peer's baseDir (the vault replica). */
    vaultDir: string;
    /** Temp directory on the same filesystem as vaultDir, outside it. */
    tmpDir: string;
    /** Where deleted files are copied to (outside vaultDir). */
    trashDir: string;
    /** Bridge heartbeat file written by main.ts ({ ts, ok, ... }). */
    healthFile: string;
    /** Bearer token. Unset/empty => every /v1 request is refused. */
    token: string | undefined;
    /** Ignore patterns of the group "all" storage peer, as configured. */
    ignore: string[];
    maxBytes?: number;
    healthMaxAgeMs?: number;
    /** Pause after creating a directory so the recursive watcher can add it. */
    newDirSettleMs?: number;
    now?: () => number;
    log?: (fields: Record<string, unknown>) => void;
}

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly extra?: Record<string, unknown>;
    constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

/** Pick the storage peer of group "all" from a Bridge config. Throws unless exactly one. */
export function policyFromConfig(config: unknown): { vaultDir: string; ignore: string[] } {
    const peers = (config as { peers?: unknown })?.peers;
    if (!Array.isArray(peers)) throw new Error("config has no peers");
    const storage = peers.filter((p) => p?.type === "storage" && (p.group ?? "") === "all");
    if (storage.length !== 1) {
        throw new Error(`expected exactly one storage peer in group "all", found ${storage.length}`);
    }
    const peer = storage[0];
    if (typeof peer.baseDir !== "string" || !peer.baseDir.startsWith("/")) {
        throw new Error(`storage peer "${peer.name}" baseDir must be absolute`);
    }
    const ignore = Array.isArray(peer.ignore) ? peer.ignore.filter((p: unknown) => typeof p === "string") : [];
    return { vaultDir: peer.baseDir.replace(/\/+$/, ""), ignore };
}

/**
 * Validate and normalise a vault-relative path from a request.
 * NFC; no absolute paths, backslashes, NUL, empty / "." / ".." segments.
 * `allowRoot` accepts "" (the vault root, for listing).
 */
export function normalizeApiPath(raw: unknown, allowRoot = false): string {
    if (typeof raw !== "string") throw new ApiError(400, "bad_path", "path is required");
    let p = raw.normalize("NFC");
    if (p.startsWith("./")) p = p.replace(/^(\.\/)+/, "");
    if (allowRoot && p === "") return "";
    if (p === "") throw new ApiError(400, "bad_path", "path is empty");
    if (p.startsWith("/")) throw new ApiError(400, "bad_path", "absolute paths are not allowed");
    if (p.includes("\\")) throw new ApiError(400, "bad_path", "backslashes are not allowed");
    if (p.includes("\0")) throw new ApiError(400, "bad_path", "NUL is not allowed");
    if (allowRoot) p = p.replace(/\/+$/, "");
    for (const seg of p.split("/")) {
        if (seg === "" || seg === "." || seg === "..") {
            throw new ApiError(400, "bad_path", `invalid path segment in "${raw}"`);
        }
    }
    return p;
}

/** Git blob SHA-1 of the bytes (same value GitHub reports as a file sha). */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const buf = new Uint8Array(header.byteLength + bytes.byteLength);
    buf.set(header, 0);
    buf.set(bytes, header.byteLength);
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
    const ea = new TextEncoder().encode(a);
    const eb = new TextEncoder().encode(b);
    let diff = ea.byteLength ^ eb.byteLength;
    const n = Math.max(ea.byteLength, eb.byteLength);
    for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
    return diff === 0;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFileApi(opts: FileApiOptions) {
    const vaultDir = opts.vaultDir.replace(/\/+$/, "");
    const patterns = expandIgnorePatterns(opts.ignore);
    const maxBytes = opts.maxBytes ?? MAX_BYTES_DEFAULT;
    const healthMaxAgeMs = opts.healthMaxAgeMs ?? HEALTH_MAX_AGE_MS_DEFAULT;
    const settleMs = opts.newDirSettleMs ?? 300;
    const now = opts.now ?? Date.now;
    const log = opts.log ?? ((f) => console.log(JSON.stringify(f)));
    const locks = new Map<string, Promise<unknown>>();

    const isBlocked = (rel: string) => isIgnoredByPatterns(rel, patterns);

    function assertAllowed(rel: string) {
        if (rel && isBlocked(rel)) {
            throw new ApiError(403, "forbidden_path", `path is outside the synchronised vault: ${rel}`);
        }
    }

    async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = locks.get(key) ?? Promise.resolve();
        const run = prev.catch(() => undefined).then(fn);
        const tail = run.catch(() => undefined);
        locks.set(key, tail);
        try {
            return await run;
        } finally {
            if (locks.get(key) === tail) locks.delete(key);
        }
    }

    /** Bridge heartbeat. Returns null when healthy, else a reason. */
    async function bridgeProblem(): Promise<string | null> {
        let text: string;
        try {
            text = await Deno.readTextFile(opts.healthFile);
        } catch {
            return "heartbeat file missing";
        }
        let h: { ts?: unknown; ok?: unknown };
        try {
            h = JSON.parse(text);
        } catch {
            return "heartbeat unreadable";
        }
        if (typeof h.ts !== "number") return "heartbeat has no timestamp";
        const age = now() - h.ts;
        if (age > healthMaxAgeMs) return `heartbeat stale (${Math.round(age / 1000)}s old)`;
        if (h.ok !== true) return "bridge reports not ok";
        return null;
    }

    async function assertBridgeHealthy() {
        const problem = await bridgeProblem();
        if (problem) throw new ApiError(503, "bridge_unhealthy", `writes refused: ${problem}`);
    }

    async function lstatOrNull(p: string): Promise<Deno.FileInfo | null> {
        try {
            return await Deno.lstat(p);
        } catch (e) {
            if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory) return null;
            throw e;
        }
    }

    /**
     * Resolve a normalised (NFC) path to the entry on disk. Each segment is tried
     * as-is, then by NFC comparison against the directory listing (the replica can
     * hold NFD names written by the Bridge). Symlinks are refused.
     * Returns the existing prefix and the remaining (missing) segments.
     */
    async function resolve(rel: string): Promise<{ abs: string; missing: string[]; info: Deno.FileInfo | null }> {
        let cur = vaultDir;
        let info: Deno.FileInfo | null = await lstatOrNull(cur);
        if (!info?.isDirectory) throw new ApiError(503, "replica_missing", "vault replica directory is missing");
        const segs = rel === "" ? [] : rel.split("/");
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            let next = join(cur, seg);
            let st = await lstatOrNull(next);
            if (!st && info?.isDirectory) {
                for await (const ent of Deno.readDir(cur)) {
                    if (ent.name.normalize("NFC") === seg) {
                        next = join(cur, ent.name);
                        st = await lstatOrNull(next);
                        break;
                    }
                }
            }
            if (!st) return { abs: cur, missing: segs.slice(i), info: null };
            if (st.isSymlink) throw new ApiError(400, "bad_path", "symbolic links are not followed");
            if (!st.isDirectory && i < segs.length - 1) {
                throw new ApiError(400, "bad_path", `not a directory: ${segs.slice(0, i + 1).join("/")}`);
            }
            cur = next;
            info = st;
        }
        return { abs: cur, missing: [], info };
    }

    async function readExisting(rel: string) {
        const r = await resolve(rel);
        if (r.missing.length > 0 || !r.info) return null;
        if (!r.info.isFile) throw new ApiError(400, "not_a_file", `not a file: ${rel}`);
        if (r.info.size > maxBytes) throw new ApiError(413, "too_large", `file is larger than ${maxBytes} bytes`);
        const bytes = await Deno.readFile(r.abs);
        return { abs: r.abs, bytes, info: r.info, sha: await gitBlobSha(bytes) };
    }

    function decodeText(bytes: Uint8Array): string {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            throw new ApiError(415, "not_text", "file is not UTF-8 text");
        }
    }

    // ─── operations ───────────────────────────────────────────────────────

    async function readFile(rawPath: unknown) {
        const rel = normalizeApiPath(rawPath);
        assertAllowed(rel);
        const f = await readExisting(rel);
        if (!f) throw new ApiError(404, "not_found", `not found: ${rel}`);
        return { path: rel, sha: f.sha, size: f.bytes.byteLength, mtime: f.info.mtime?.getTime() ?? null, text: decodeText(f.bytes) };
    }

    async function writeFile(body: { path?: unknown; text?: unknown; mode?: unknown; expectedSha?: unknown }) {
        const rel = normalizeApiPath(body.path);
        assertAllowed(rel);
        if (typeof body.text !== "string") throw new ApiError(400, "bad_request", "text must be a string");
        const mode = body.mode ?? "overwrite";
        if (mode !== "create" && mode !== "overwrite") throw new ApiError(400, "bad_request", "mode must be create or overwrite");
        const expectedSha = body.expectedSha === undefined || body.expectedSha === null || body.expectedSha === ""
            ? undefined
            : String(body.expectedSha);
        const bytes = new TextEncoder().encode(body.text);
        if (bytes.byteLength > maxBytes) throw new ApiError(413, "too_large", `content is larger than ${maxBytes} bytes`);
        await assertBridgeHealthy();

        return await withLock(rel, async () => {
            const existing = await readExisting(rel);
            if (existing && mode === "create") {
                throw new ApiError(409, "conflict", `already exists: ${rel}`, { reason: "exists", currentSha: existing.sha });
            }
            if (expectedSha && !existing) {
                throw new ApiError(409, "conflict", `expectedSha given but the file does not exist: ${rel}`, { reason: "missing" });
            }
            if (expectedSha && existing && existing.sha !== expectedSha) {
                throw new ApiError(409, "conflict", `expectedSha mismatch: current is ${existing.sha}`, {
                    reason: "sha_mismatch",
                    currentSha: existing.sha,
                });
            }
            const sha = await gitBlobSha(bytes);
            if (existing && existing.sha === sha) {
                return { path: rel, sha, created: false, unchanged: true };
            }
            let target: string;
            if (existing) {
                target = existing.abs;
            } else {
                const r = await resolve(rel);
                if (r.info && !r.info.isDirectory) throw new ApiError(400, "bad_path", `parent is not a directory: ${rel}`);
                let dir = r.abs;
                for (const seg of r.missing.slice(0, -1)) {
                    dir = join(dir, seg);
                    await Deno.mkdir(dir);
                }
                // A directory created just now may not be watched yet (the recursive
                // watcher adds it on its own create event). Give it a moment before the
                // file lands, or the file's event can be missed.
                if (r.missing.length > 1) await sleep(settleMs);
                target = join(dir, r.missing[r.missing.length - 1]);
            }
            const tmp = join(opts.tmpDir, `${crypto.randomUUID()}.tmp`);
            try {
                await Deno.writeFile(tmp, bytes);
                await Deno.rename(tmp, target);
            } catch (e) {
                await Deno.remove(tmp).catch(() => undefined);
                throw e;
            }
            return { path: rel, sha, created: !existing, unchanged: false };
        });
    }

    async function deleteFile(rawPath: unknown, rawExpected: unknown) {
        const rel = normalizeApiPath(rawPath);
        assertAllowed(rel);
        const expectedSha = typeof rawExpected === "string" && rawExpected !== "" ? rawExpected : undefined;
        await assertBridgeHealthy();
        return await withLock(rel, async () => {
            const existing = await readExisting(rel);
            if (!existing) throw new ApiError(404, "not_found", `not found: ${rel}`);
            if (expectedSha && existing.sha !== expectedSha) {
                throw new ApiError(409, "conflict", `expectedSha mismatch: current is ${existing.sha}`, {
                    reason: "sha_mismatch",
                    currentSha: existing.sha,
                });
            }
            const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
            const trashed = join(opts.trashDir, stamp, rel);
            await Deno.mkdir(dirname(trashed), { recursive: true });
            await Deno.writeFile(trashed, existing.bytes);
            await Deno.remove(existing.abs);
            return { path: rel, sha: existing.sha, trashedTo: relative(opts.trashDir, trashed) };
        });
    }

    async function listDir(rawPath: unknown) {
        const rel = normalizeApiPath(rawPath ?? "", true);
        assertAllowed(rel);
        const r = await resolve(rel);
        if (r.missing.length > 0 || !r.info) throw new ApiError(404, "not_found", `not found: ${rel || "(root)"}`);
        if (!r.info.isDirectory) throw new ApiError(400, "not_a_directory", `not a directory: ${rel}`);
        const entries: { name: string; path: string; type: "file" | "dir"; size: number }[] = [];
        for await (const ent of Deno.readDir(r.abs)) {
            const name = ent.name.normalize("NFC");
            const childRel = rel ? `${rel}/${name}` : name;
            if (isBlocked(childRel) || ent.isSymlink) continue;
            if (ent.isDirectory) {
                entries.push({ name, path: childRel, type: "dir", size: 0 });
            } else if (ent.isFile) {
                const st = await lstatOrNull(join(r.abs, ent.name));
                entries.push({ name, path: childRel, type: "file", size: st?.size ?? 0 });
            }
        }
        entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
        return { path: rel, entries };
    }

    async function search(rawQuery: unknown, rawPath: unknown, rawLimit: unknown) {
        if (typeof rawQuery !== "string" || rawQuery.trim() === "") throw new ApiError(400, "bad_request", "q is required");
        const query = rawQuery.normalize("NFC").trim();
        if (query.length > 200) throw new ApiError(400, "bad_request", "q is too long");
        const needle = query.toLowerCase();
        const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number.parseInt(String(rawLimit ?? SEARCH_LIMIT_MAX), 10) || SEARCH_LIMIT_MAX));
        const base = normalizeApiPath(rawPath ?? "", true);
        assertAllowed(base);
        const r = await resolve(base);
        if (r.missing.length > 0 || !r.info) throw new ApiError(404, "not_found", `not found: ${base || "(root)"}`);
        const hits: { path: string; name: string; snippets: string[] }[] = [];
        let truncated = false;

        const visit = async (abs: string, rel: string): Promise<boolean> => {
            const children: Deno.DirEntry[] = [];
            for await (const ent of Deno.readDir(abs)) children.push(ent);
            children.sort((a, b) => a.name.localeCompare(b.name));
            for (const ent of children) {
                const name = ent.name.normalize("NFC");
                const childRel = rel ? `${rel}/${name}` : name;
                if (isBlocked(childRel) || ent.isSymlink) continue;
                if (ent.isDirectory) {
                    if (!(await visit(join(abs, ent.name), childRel))) return false;
                } else if (ent.isFile && name.toLowerCase().endsWith(".md")) {
                    const childAbs = join(abs, ent.name);
                    const st = await lstatOrNull(childAbs);
                    if (!st || st.size > maxBytes) continue;
                    let text: string;
                    try {
                        text = decodeText(await Deno.readFile(childAbs)).normalize("NFC");
                    } catch {
                        continue;
                    }
                    const snippets = excerpts(text, needle);
                    const nameHit = childRel.toLowerCase().includes(needle);
                    if (snippets.length === 0 && !nameHit) continue;
                    if (hits.length >= limit) {
                        truncated = true;
                        return false;
                    }
                    hits.push({ path: childRel, name, snippets });
                }
            }
            return true;
        };
        if (r.info.isDirectory) await visit(r.abs, base);
        return { query, hits, truncated };
    }

    // ─── HTTP ─────────────────────────────────────────────────────────────

    async function route(req: Request, url: URL): Promise<Response> {
        if (url.pathname === "/health" && req.method === "GET") {
            const problem = await bridgeProblem();
            return json(200, { ok: problem === null, svc: "lsb-fileapi", bridge: problem ?? "ok", configured: !!opts.token });
        }
        if (!url.pathname.startsWith("/v1/")) throw new ApiError(404, "not_found", "unknown route");
        if (!opts.token) throw new ApiError(503, "not_configured", "file API token is not configured");
        const auth = req.headers.get("authorization") ?? "";
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        if (!m || !timingSafeEqual(m[1].trim(), opts.token)) throw new ApiError(401, "unauthorized", "bad or missing token");

        const q = url.searchParams;
        switch (`${req.method} ${url.pathname}`) {
            case "GET /v1/file":
                return json(200, await readFile(q.get("path")));
            case "PUT /v1/file": {
                const len = Number(req.headers.get("content-length") ?? "0");
                if (len > maxBytes * 2 + 65536) throw new ApiError(413, "too_large", "request body too large");
                let body: unknown;
                try {
                    body = await req.json();
                } catch {
                    throw new ApiError(400, "bad_request", "body must be JSON");
                }
                const result = await writeFile((body ?? {}) as Record<string, unknown>);
                return json(result.created ? 201 : 200, result);
            }
            case "DELETE /v1/file":
                return json(200, await deleteFile(q.get("path"), q.get("expectedSha")));
            case "GET /v1/list":
                return json(200, await listDir(q.get("path") ?? ""));
            case "GET /v1/search":
                return json(200, await search(q.get("q"), q.get("path") ?? "", q.get("limit")));
            default:
                throw new ApiError(405, "method_not_allowed", `${req.method} ${url.pathname}`);
        }
    }

    async function handle(req: Request): Promise<Response> {
        const started = now();
        const url = new URL(req.url);
        let res: Response;
        try {
            res = await route(req, url);
        } catch (e) {
            if (e instanceof ApiError) {
                res = json(e.status, { error: e.code, message: e.message, ...(e.extra ?? {}) });
            } else {
                console.error("[fileapi] internal error:", e);
                res = json(500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
            }
        }
        // Paths and queries are vault content: log the route and status only.
        log({ event: "fileapi", method: req.method, route: url.pathname, status: res.status, ms: now() - started });
        return res;
    }

    return { handle, bridgeProblem, isBlocked };
}

/** Up to 3 excerpts (≈60 chars of context each side) around case-insensitive matches. */
export function excerpts(text: string, needleLower: string, max = 3): string[] {
    const lower = text.toLowerCase();
    const out: string[] = [];
    let from = 0;
    while (out.length < max) {
        const i = lower.indexOf(needleLower, from);
        if (i < 0) break;
        const start = Math.max(0, i - 60);
        const end = Math.min(text.length, i + needleLower.length + 60);
        out.push((start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : ""));
        from = end;
    }
    return out;
}
