// Entry point of the file API process (see server.ts). Started next to the
// Bridge by deploy/fly/start.sh; refuses to start on a config it cannot read.
import { createFileApi, policyFromConfig } from "./server.ts";

const env = (k: string, d: string) => Deno.env.get(k) || d;
const configFile = env("LSB_CONFIG", "./dat/config.json");
const port = Number(env("LSB_FILEAPI_PORT", "8787"));
const tmpDir = env("LSB_FILEAPI_TMP", "/app/data/tmp");
const trashDir = env("LSB_FILEAPI_TRASH", "/app/data/mcp-trash");
const healthFile = env("LSB_HEALTH_FILE", "/tmp/lsb-health.json");
const token = Deno.env.get("LSB_FILEAPI_TOKEN")?.trim() || undefined;

const { vaultDir, ignore } = policyFromConfig(JSON.parse(await Deno.readTextFile(configFile)));
await Deno.mkdir(vaultDir, { recursive: true });
await Deno.mkdir(tmpDir, { recursive: true });
await Deno.mkdir(trashDir, { recursive: true });

// rename() is only atomic within one filesystem; a temp dir elsewhere would turn
// every write into copy+delete, which the watcher could observe half-done.
const [vs, ts] = [await Deno.stat(vaultDir), await Deno.stat(tmpDir)];
if (vs.dev !== ts.dev) {
    console.error(`[fileapi] ${tmpDir} and ${vaultDir} are on different filesystems; refusing to start`);
    Deno.exit(1);
}
const rel = (await Deno.realPath(tmpDir)) + "/";
if (rel.startsWith((await Deno.realPath(vaultDir)) + "/")) {
    console.error(`[fileapi] ${tmpDir} is inside the watched vault; refusing to start`);
    Deno.exit(1);
}
// Leftovers of an interrupted write.
for await (const ent of Deno.readDir(tmpDir)) {
    if (ent.isFile && ent.name.endsWith(".tmp")) await Deno.remove(`${tmpDir}/${ent.name}`).catch(() => undefined);
}

if (!token) console.error("[fileapi] LSB_FILEAPI_TOKEN is not set: every /v1 request will be refused");
const api = createFileApi({ vaultDir, tmpDir, trashDir, healthFile, token, ignore });
console.log(`[fileapi] listening on :${port} vault=${vaultDir} ignore=${ignore.length} patterns`);
Deno.serve({ port, hostname: "0.0.0.0", onListen: () => {} }, api.handle);
