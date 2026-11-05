import nodeAssert from "node:assert/strict";

const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown, msg?: string) => nodeAssert.deepStrictEqual(a, b, msg);
// deno-lint-ignore no-explicit-any
const assertThrows = (fn: () => unknown, cls: any = Error, _?: unknown, msg?: string) => nodeAssert.throws(fn, cls, msg);
import { join } from "@std/path";
import { ApiError, createFileApi, gitBlobSha, normalizeApiPath, policyFromConfig } from "./server.ts";

const TOKEN = "test-token-123";
const IGNORE = [".git/**", ".obsidian/**", ".claude/**", ".trash/**"];

async function setup(opts: { token?: string | null; health?: unknown; maxBytes?: number } = {}) {
    const root = await Deno.makeTempDir({ prefix: "fileapi-" });
    const vaultDir = join(root, "vault");
    const tmpDir = join(root, "tmp");
    const trashDir = join(root, "trash");
    const healthFile = join(root, "health.json");
    await Deno.mkdir(vaultDir);
    await Deno.mkdir(tmpDir);
    await Deno.mkdir(trashDir);
    let clock = 1_000_000;
    const writeHealth = async (h: unknown) => await Deno.writeTextFile(healthFile, JSON.stringify(h));
    await writeHealth(opts.health ?? { ts: clock, ok: true });
    const api = createFileApi({
        vaultDir,
        tmpDir,
        trashDir,
        healthFile,
        token: opts.token === null ? undefined : (opts.token ?? TOKEN),
        ignore: IGNORE,
        maxBytes: opts.maxBytes,
        newDirSettleMs: 0,
        now: () => clock,
        log: () => {},
    });
    const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
        const headers: Record<string, string> = {};
        if (token !== null) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        const res = await api.handle(
            new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
        );
        return { status: res.status, body: await res.json() };
    };
    const put = (path: string, text: string, extra: Record<string, unknown> = {}) =>
        call("PUT", "/v1/file", { path, text, ...extra });
    const read = (path: string) => call("GET", `/v1/file?path=${encodeURIComponent(path)}`);
    const del = (path: string, expectedSha?: string) =>
        call("DELETE", `/v1/file?path=${encodeURIComponent(path)}${expectedSha ? `&expectedSha=${expectedSha}` : ""}`);
    return {
        root, vaultDir, tmpDir, trashDir, healthFile, api, call, put, read, del, writeHealth,
        advance: (ms: number) => { clock += ms; },
        get clock() { return clock; },
        cleanup: () => Deno.remove(root, { recursive: true }),
    };
}

async function exists(p: string) {
    try {
        await Deno.lstat(p);
        return true;
    } catch {
        return false;
    }
}

// ─── pure helpers ─────────────────────────────────────────────────────────

Deno.test("gitBlobSha matches git hash-object", async () => {
    // printf 'hello\n' | git hash-object --stdin
    assertEquals(await gitBlobSha(new TextEncoder().encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

Deno.test("normalizeApiPath rejects traversal, absolute, backslash, empty segments", () => {
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "a\\b", "a/", "x\0y"]) {
        assertThrows(() => normalizeApiPath(bad), ApiError, undefined, `should reject ${JSON.stringify(bad)}`);
    }
    assertEquals(normalizeApiPath("./a/b.md"), "a/b.md");
    assertEquals(normalizeApiPath("", true), "");
    assertEquals(normalizeApiPath("dir/", true), "dir");
    // NFD input becomes NFC
    assertEquals(normalizeApiPath("パ.md"), "パ.md");
});

Deno.test("policyFromConfig picks the group all storage peer and fails otherwise", () => {
    const conf = {
        peers: [
            { type: "couchdb", name: "db", group: "all" },
            { type: "storage", name: "vault-all", group: "all", baseDir: "/app/data/vault/", ignore: IGNORE },
            { type: "storage", name: "vault-share", group: "share", baseDir: "/app/data/vault/", ignore: ["!{a}"] },
        ],
    };
    assertEquals(policyFromConfig(conf), { vaultDir: "/app/data/vault", ignore: IGNORE });
    assertThrows(() => policyFromConfig({ peers: [conf.peers[2]] }));
    assertThrows(() => policyFromConfig({ peers: [conf.peers[1], conf.peers[1]] }));
    assertThrows(() => policyFromConfig({ peers: [{ ...conf.peers[1], baseDir: "vault/" }] }));
});

// ─── auth ─────────────────────────────────────────────────────────────────

Deno.test("no token configured: every /v1 request is refused", async () => {
    const t = await setup({ token: null });
    try {
        const r = await t.call("GET", "/v1/list?path=", undefined, "anything");
        assertEquals(r.status, 503);
        assertEquals(r.body.error, "not_configured");
    } finally {
        await t.cleanup();
    }
});

Deno.test("missing or wrong bearer token is 401", async () => {
    const t = await setup();
    try {
        assertEquals((await t.call("GET", "/v1/list?path=", undefined, null)).status, 401);
        assertEquals((await t.call("GET", "/v1/list?path=", undefined, "wrong")).status, 401);
        assertEquals((await t.call("GET", "/v1/list?path=", undefined, TOKEN + "x")).status, 401);
        assertEquals((await t.call("GET", "/v1/list?path=")).status, 200);
    } finally {
        await t.cleanup();
    }
});

Deno.test("/health needs no token and reports the bridge heartbeat", async () => {
    const t = await setup();
    try {
        const ok = await t.call("GET", "/health", undefined, null);
        assertEquals(ok.status, 200);
        assertEquals(ok.body.ok, true);
        t.advance(120_000);
        const stale = await t.call("GET", "/health", undefined, null);
        assertEquals(stale.body.ok, false);
    } finally {
        await t.cleanup();
    }
});

// ─── read / write ─────────────────────────────────────────────────────────

Deno.test("create writes via tmp+rename, returns the git blob sha, and refuses a second create", async () => {
    const t = await setup();
    try {
        const r = await t.put("000_inbox/new.md", "hello\n", { mode: "create" });
        assertEquals(r.status, 201);
        assertEquals(r.body.sha, "ce013625030ba8dba906f756967f9e9ca394464a");
        assertEquals(await Deno.readTextFile(join(t.vaultDir, "000_inbox/new.md")), "hello\n");
        assertEquals([...Deno.readDirSync(t.tmpDir)].length, 0, "no temp file left behind");
        const again = await t.put("000_inbox/new.md", "other", { mode: "create" });
        assertEquals(again.status, 409);
        assertEquals(again.body.reason, "exists");
        assertEquals(await Deno.readTextFile(join(t.vaultDir, "000_inbox/new.md")), "hello\n");
    } finally {
        await t.cleanup();
    }
});

Deno.test("overwrite: expectedSha mismatch is 409 and leaves the file; matching sha writes", async () => {
    const t = await setup();
    try {
        await t.put("a.md", "v1");
        const cur = await t.read("a.md");
        assertEquals(cur.status, 200);
        assertEquals(cur.body.text, "v1");
        const bad = await t.put("a.md", "v2", { expectedSha: "0".repeat(40) });
        assertEquals(bad.status, 409);
        assertEquals(bad.body.reason, "sha_mismatch");
        assertEquals(bad.body.currentSha, cur.body.sha);
        assertEquals(await Deno.readTextFile(join(t.vaultDir, "a.md")), "v1");
        const good = await t.put("a.md", "v2", { expectedSha: cur.body.sha });
        assertEquals(good.status, 200);
        assertEquals(good.body.created, false);
        assertEquals((await t.read("a.md")).body.text, "v2");
    } finally {
        await t.cleanup();
    }
});

Deno.test("overwrite with expectedSha on a missing file is 409 (missing), without it it creates", async () => {
    const t = await setup();
    try {
        const r = await t.put("gone.md", "x", { expectedSha: "1".repeat(40) });
        assertEquals(r.status, 409);
        assertEquals(r.body.reason, "missing");
        assert(!(await exists(join(t.vaultDir, "gone.md"))));
        assertEquals((await t.put("gone.md", "x")).status, 201);
    } finally {
        await t.cleanup();
    }
});

Deno.test("paths ignored by the group all peer are 403 for read, write, delete, list", async () => {
    const t = await setup();
    try {
        await Deno.mkdir(join(t.vaultDir, ".obsidian"));
        await Deno.writeTextFile(join(t.vaultDir, ".obsidian/app.json"), "{}");
        for (const p of [".obsidian/app.json", ".obsidian", ".git/config", ".claude/settings.json", ".trash/x.md"]) {
            assertEquals((await t.put(p, "x")).status, 403, `put ${p}`);
            assertEquals((await t.read(p)).status, 403, `read ${p}`);
            assertEquals((await t.del(p)).status, 403, `delete ${p}`);
        }
        assertEquals((await t.call("GET", "/v1/list?path=.obsidian")).status, 403);
        assertEquals(await Deno.readTextFile(join(t.vaultDir, ".obsidian/app.json")), "{}");
    } finally {
        await t.cleanup();
    }
});

Deno.test("bad paths are 400 and write nothing", async () => {
    const t = await setup();
    try {
        for (const p of ["../escape.md", "/abs.md", "a/../../b.md", "a\\b.md"]) {
            assertEquals((await t.put(p, "x")).status, 400, p);
        }
        assert(!(await exists(join(t.root, "escape.md"))));
    } finally {
        await t.cleanup();
    }
});

Deno.test("symlinks inside the vault are not followed", async () => {
    const t = await setup();
    try {
        await Deno.mkdir(join(t.root, "outside"));
        await Deno.symlink(join(t.root, "outside"), join(t.vaultDir, "link"));
        assertEquals((await t.put("link/x.md", "x")).status, 400);
        assert(!(await exists(join(t.root, "outside/x.md"))));
    } finally {
        await t.cleanup();
    }
});

Deno.test("content over the size limit is 413", async () => {
    const t = await setup({ maxBytes: 10 });
    try {
        assertEquals((await t.put("big.md", "12345678901")).status, 413);
        assert(!(await exists(join(t.vaultDir, "big.md"))));
        assertEquals((await t.put("ok.md", "1234567890")).status, 201);
    } finally {
        await t.cleanup();
    }
});

Deno.test("an NFD name on disk is found by its NFC path and overwritten in place", async () => {
    const t = await setup();
    try {
        const nfd = "パス.md"; // パス (NFD)
        await Deno.writeTextFile(join(t.vaultDir, nfd), "old");
        const r = await t.read("パス.md");
        assertEquals(r.status, 200);
        assertEquals(r.body.text, "old");
        assertEquals((await t.put("パス.md", "new", { expectedSha: r.body.sha })).status, 200);
        const names = [...Deno.readDirSync(t.vaultDir)].map((e) => e.name);
        assertEquals(names, [nfd], "no NFC twin created");
        assertEquals(await Deno.readTextFile(join(t.vaultDir, nfd)), "new");
    } finally {
        await t.cleanup();
    }
});

Deno.test("binary files are 415 on read", async () => {
    const t = await setup();
    try {
        await Deno.writeFile(join(t.vaultDir, "img.png"), new Uint8Array([0x89, 0x50, 0xff, 0xfe]));
        assertEquals((await t.read("img.png")).status, 415);
    } finally {
        await t.cleanup();
    }
});

// ─── fail-closed on bridge health ─────────────────────────────────────────

Deno.test("writes and deletes are 503 when the heartbeat is stale, not ok, or missing; reads still work", async () => {
    const t = await setup();
    try {
        await t.put("keep.md", "k");
        const sha = (await t.read("keep.md")).body.sha;
        const cases: [string, () => Promise<void>][] = [
            ["stale", async () => { await t.writeHealth({ ts: t.clock, ok: true }); t.advance(61_000); }],
            ["not ok", async () => { await t.writeHealth({ ts: t.clock, ok: false }); }],
            ["missing", async () => { await Deno.remove(t.healthFile); }],
            ["garbage", async () => { await Deno.writeTextFile(t.healthFile, "{not json"); }],
            ["no ts", async () => { await t.writeHealth({ ok: true }); }],
        ];
        for (const [name, arrange] of cases) {
            await arrange();
            const w = await t.put("blocked.md", "x");
            assertEquals(w.status, 503, `put when ${name}`);
            assertEquals(w.body.error, "bridge_unhealthy");
            assertEquals((await t.del("keep.md", sha)).status, 503, `delete when ${name}`);
            assertEquals((await t.read("keep.md")).status, 200, `read when ${name}`);
        }
        assert(!(await exists(join(t.vaultDir, "blocked.md"))));
        assert(await exists(join(t.vaultDir, "keep.md")));
        await t.writeHealth({ ts: t.clock, ok: true });
        assertEquals((await t.put("blocked.md", "x")).status, 201);
    } finally {
        await t.cleanup();
    }
});

// ─── delete ───────────────────────────────────────────────────────────────

Deno.test("delete copies to trash first; sha mismatch is 409; missing is 404", async () => {
    const t = await setup();
    try {
        await t.put("dir/note.md", "body");
        const sha = (await t.read("dir/note.md")).body.sha;
        assertEquals((await t.del("dir/note.md", "f".repeat(40))).status, 409);
        assert(await exists(join(t.vaultDir, "dir/note.md")));
        const r = await t.del("dir/note.md", sha);
        assertEquals(r.status, 200);
        assert(!(await exists(join(t.vaultDir, "dir/note.md"))));
        assertEquals(await Deno.readTextFile(join(t.trashDir, r.body.trashedTo)), "body");
        assert(r.body.trashedTo.endsWith("dir/note.md"));
        assertEquals((await t.del("dir/note.md")).status, 404);
    } finally {
        await t.cleanup();
    }
});

// ─── list / search ────────────────────────────────────────────────────────

Deno.test("list returns immediate children without ignored entries", async () => {
    const t = await setup();
    try {
        await Deno.mkdir(join(t.vaultDir, ".obsidian"));
        await Deno.mkdir(join(t.vaultDir, "10_dir"));
        await Deno.writeTextFile(join(t.vaultDir, "a.md"), "12345");
        const r = await t.call("GET", "/v1/list?path=");
        assertEquals(r.status, 200);
        assertEquals(r.body.entries, [
            { name: "10_dir", path: "10_dir", type: "dir", size: 0 },
            { name: "a.md", path: "a.md", type: "file", size: 5 },
        ]);
        assertEquals((await t.call("GET", "/v1/list?path=nope")).status, 404);
    } finally {
        await t.cleanup();
    }
});

Deno.test("search: .md only, case-insensitive, excerpts, skips ignored dirs, at most 20", async () => {
    const t = await setup();
    try {
        await Deno.mkdir(join(t.vaultDir, ".obsidian"));
        await Deno.writeTextFile(join(t.vaultDir, ".obsidian/x.md"), "Needle in config");
        await Deno.writeTextFile(join(t.vaultDir, "data.txt"), "needle in txt");
        await Deno.mkdir(join(t.vaultDir, "notes"));
        for (let i = 0; i < 25; i++) {
            await Deno.writeTextFile(join(t.vaultDir, `notes/n${String(i).padStart(2, "0")}.md`), `line\nthe NEEDLE here ${i}\n`);
        }
        await Deno.writeTextFile(join(t.vaultDir, "notes/zz-other.md"), "nothing");
        const r = await t.call("GET", "/v1/search?q=needle");
        assertEquals(r.status, 200);
        assertEquals(r.body.hits.length, 20);
        assertEquals(r.body.truncated, true);
        assert(r.body.hits.every((h: { path: string }) => h.path.startsWith("notes/") && h.path.endsWith(".md")));
        assert(r.body.hits[0].snippets[0].includes("NEEDLE"));
        const scoped = await t.call("GET", "/v1/search?q=nothing&path=notes");
        assertEquals(scoped.body.hits.map((h: { path: string }) => h.path), ["notes/zz-other.md"]);
        assertEquals((await t.call("GET", "/v1/search?q=")).status, 400);
    } finally {
        await t.cleanup();
    }
});

Deno.test("concurrent writes to one path with the same expectedSha: exactly one wins", async () => {
    const t = await setup();
    try {
        await t.put("race.md", "base");
        const sha = (await t.read("race.md")).body.sha;
        const results = await Promise.all(
            Array.from({ length: 5 }, (_, i) => t.put("race.md", `writer ${i}`, { expectedSha: sha })),
        );
        assertEquals(results.filter((r) => r.status === 200).length, 1);
        assertEquals(results.filter((r) => r.status === 409).length, 4);
    } finally {
        await t.cleanup();
    }
});
