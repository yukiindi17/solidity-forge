const MAX_FILES = 80;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const JOB_TTL = 3600;
const OUTPUT_LIMIT = 30000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const text = (value, status = 200) => new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const bearer = (request, token) => Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;

function validateFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("files harus berupa object path -> isi file.");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw new Error("Jumlah file harus 1–80.");
  let total = 0;
  for (const [name, body] of entries) {
    const parts = name.split("/");
    if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") ||
        parts.some(p => !p || p === "." || p === ".." || [".git", ".github", ".env", "node_modules"].includes(p)) ||
        /(^|\/)(\.env(\..*)?|\.npmrc|id_rsa|id_ed25519|.*\.(pem|key|p12|keystore))$/i.test(name)) {
      throw new Error("Path tidak diizinkan: " + name);
    }
    if (typeof body !== "string") throw new Error("Isi file harus berupa teks: " + name);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_FILE_BYTES) throw new Error("File terlalu besar: " + name);
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Ukuran total proyek melebihi 4 MiB.");
  return entries;
}

function schema(kind) {
  const common = { files: { type: "object", additionalProperties: { type: "string" }, description: "Map path file ke isi teks. Sertakan semua source, test, konfigurasi, dan dependency yang diperlukan." } };
  if (kind === "solidity") return { type: "object", properties: {
    ...common,
    match: { type: "string", description: "Filter nama test Foundry opsional; hanya huruf, angka, titik, titik dua, garis bawah, dan tanda minus." },
    fuzz_runs: { type: "integer", minimum: 1, maximum: 10000, default: 256 },
    invariant_runs: { type: "integer", minimum: 1, maximum: 1000, default: 256 },
    invariant_depth: { type: "integer", minimum: 1, maximum: 1000, default: 64 }
  }, required: ["files"], additionalProperties: false };
  return { type: "object", properties: {
    ...common,
    test_command: { type: "string", enum: ["auto", "npm test", "npx hardhat test", "npx mocha", "npx vitest run", "npx jest"], default: "auto" },
    install: { type: "string", enum: ["auto", "npm ci", "npm install"], default: "auto" }
  }, required: ["files"], additionalProperties: false };
}

async function dispatch(env, job) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  if (!env.GITHUB_TOKEN || !owner || !repo || !env.FORGE_CALLBACK_TOKEN || !env.WORKER_PUBLIC_URL) {
    throw new Error("Worker belum dikonfigurasi. Periksa GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, FORGE_CALLBACK_TOKEN, dan WORKER_PUBLIC_URL.");
  }
  await env.JOBS.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/forge-runner.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
      "user-agent": "Solidity-Forge"
    },
    body: JSON.stringify({ ref: env.WORKFLOW_REF || "main", inputs: { job_id: job.id } })
  });
  if (!response.ok) {
    await env.JOBS.delete(`job:${job.id}`);
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub Actions dispatch gagal (${response.status}): ${detail}`);
  }
}

async function submit(env, kind, args) {
  const entries = validateFiles(args.files);
  if (kind === "typescript" && !args.files["package.json"]) throw new Error("package.json wajib disertakan untuk TypeScript.");
  if (kind === "solidity" && args.match && !/^[A-Za-z0-9_:.\-]{1,120}$/.test(args.match)) throw new Error("Filter match hanya boleh berisi huruf, angka, _, -, titik, atau titik dua.");
  const job = {
    id: crypto.randomUUID(),
    kind,
    files: Object.fromEntries(entries),
    options: kind === "solidity" ? {
      match: args.match || "",
      fuzz_runs: clampInt(args.fuzz_runs, 256, 1, 10000),
      invariant_runs: clampInt(args.invariant_runs, 256, 1, 1000),
      invariant_depth: clampInt(args.invariant_depth, 64, 1, 1000)
    } : {
      test_command: ["auto", "npm test", "npx hardhat test", "npx mocha", "npx vitest run", "npx jest"].includes(args.test_command) ? (args.test_command || "auto") : "auto",
      install: ["auto", "npm ci", "npm install"].includes(args.install) ? (args.install || "auto") : "auto"
    },
    created_at: new Date().toISOString()
  };
  await dispatch(env, job);
  return { job_id: job.id, status: "queued", runner: "GitHub-hosted ephemeral VM", note: "Gunakan get_test_result dengan job_id ini untuk mengambil hasil." };
}
function clampInt(v, fallback, min, max) { return Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback; }

async function getResult(env, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("job_id tidak valid.");
  const result = await env.JOBS.get(`result:${id}`, "json");
  if (result) return result;
  const job = await env.JOBS.get(`job:${id}`, "json");
  if (!job) return { job_id: id, status: "expired_or_not_found", message: "Job tidak ditemukan atau masa simpan 1 jam telah berakhir." };
  return { job_id: id, status: "running_or_queued", created_at: job.created_at, message: "Tes masih berjalan. Coba get_test_result lagi beberapa saat." };
}

const TOOLS = [
  { name: "run_solidity_tests", description: "Kirim proyek Solidity ke runner GitHub yang baru untuk setiap job. Menjalankan Foundry unit, fuzz, dan invariant tests pada EVM lokal Foundry. Tool mengembalikan job_id; panggil get_test_result untuk hasil.", inputSchema: schema("solidity") },
  { name: "run_typescript_tests", description: "Kirim proyek TypeScript smart contract ke runner GitHub yang baru untuk setiap job. Mendukung Hardhat test (local Hardhat EVM), npm test, Mocha, Vitest, dan Jest. Tool mengembalikan job_id; panggil get_test_result untuk hasil.", inputSchema: schema("typescript") },
  { name: "get_test_result", description: "Ambil status dan hasil job Solidity Forge berdasarkan job_id.", inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false } }
];

async function mcp(request, env) {
  if (!bearer(request, env.SOLIDITY_FORGE_TOKEN)) return text("Unauthorized", 401);
  if (request.method !== "POST") return text("Method not allowed", 405);
  let body;
  try { body = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const id = body.id;
  const method = body.method;
  if (!method) return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } }, 400);
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: body.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "solidity-forge", version: "0.3.0" } };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      let data;
      if (name === "run_solidity_tests") data = await submit(env, "solidity", args);
      else if (name === "run_typescript_tests") data = await submit(env, "typescript", args);
      else if (name === "get_test_result") data = await getResult(env, args.job_id);
      else throw new Error("Tool tidak dikenal: " + name);
      result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
    } else {
      return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found" } }, 200);
    }
    if (id === undefined || id === null) return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (method === "tools/call") return json({ jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text: error.message }], isError: true } });
    return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: error.message } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, service: "solidity-forge", version: "0.3.0", runner: "github-actions" });
    if (url.pathname === "/mcp") return mcp(request, env);
    if (url.pathname.startsWith("/internal/jobs/") && request.method === "GET") {
      if (!bearer(request, env.FORGE_CALLBACK_TOKEN)) return text("Unauthorized", 401);
      const id = url.pathname.split("/").pop();
      const job = await env.JOBS.get(`job:${id}`);
      return job ? new Response(job, { headers: { "content-type": "application/json", "cache-control": "no-store" } }) : text("Not found", 404);
    }
    if (url.pathname.startsWith("/internal/results/") && request.method === "POST") {
      if (!bearer(request, env.FORGE_CALLBACK_TOKEN)) return text("Unauthorized", 401);
      const id = url.pathname.split("/").pop();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return text("Bad job id", 400);
      const job = await env.JOBS.get(`job:${id}`, "json");
      if (!job) return text("Job expired", 404);
      let result;
      try { result = await request.json(); } catch { return text("Invalid JSON", 400); }
      const safe = {
        job_id: id, status: "completed", passed: result.passed === true,
        exit_code: Number.isInteger(result.exit_code) ? result.exit_code : null,
        runtime: "GitHub-hosted ephemeral VM + isolated Docker container",
        engine: job.kind === "solidity" ? "Foundry EVM (REVM)" : "Hardhat local EVM / selected TypeScript test runner",
        output: String(result.output || "").slice(-OUTPUT_LIMIT),
        completed_at: new Date().toISOString()
      };
      await env.JOBS.put(`result:${id}`, JSON.stringify(safe), { expirationTtl: JOB_TTL });
      await env.JOBS.delete(`job:${id}`);
      return json({ accepted: true });
    }
    return text("Not found", 404);
  }
};
