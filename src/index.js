import http from 'node:http';
import path from 'node:path';
import { Render } from '@renderinc/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.SOLIDITY_FORGE_TOKEN;
const API_KEY = process.env.RENDER_API_KEY;
const WORKSPACE = process.env.RENDER_WORKSPACE_ID;
const MAX_FILES = 80, MAX_FILE = 512 * 1024, MAX_TOTAL = 4 * 1024 * 1024;
const TIMEOUT = 600, OUTPUT_LIMIT = 1_000_000;
const sandboxes = API_KEY && WORKSPACE ? new Render().sandboxes : null;
let imageCache, imagePromise;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";

function validate(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw Error('files harus berupa object path -> isi file.');
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw Error('Jumlah file harus 1–80.');
  let total = 0;
  for (const [name, body] of entries) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || path.posix.normalize(name) !== name || name.split('/').some(p => p === '.git' || p === '.npmrc' || p === '.env' || p.startsWith('.env.'))) throw Error('Path tidak aman: ' + name);
    if (typeof body !== 'string') throw Error('Isi file harus berupa teks: ' + name);
    const n = Buffer.byteLength(body);
    if (n > MAX_FILE) throw Error('File terlalu besar: ' + name);
    total += n;
  }
  if (total > MAX_TOTAL) throw Error('Ukuran total proyek melebihi 4 MiB.');
  return entries;
}

async function ensureImage() {
  if (process.env.RENDER_SANDBOX_BUILD_ID && process.env.RENDER_SANDBOX_GROUP_ID) return { buildId: process.env.RENDER_SANDBOX_BUILD_ID, groupId: process.env.RENDER_SANDBOX_GROUP_ID };
  if (imageCache) return imageCache;
  if (imagePromise) return imagePromise;
  imagePromise = (async () => {
    let seed;
    try {
      seed = await sandboxes.create({ timeoutSeconds: 120, networkPolicy: { type: 'deny-all' } });
      await sandboxes.waitUntilRunning(seed.id, { timeoutMs: 120000 });
      const groups = await sandboxes.listGroups();
      const group = groups.map(x => x.sandboxGroup).find(x => x?.id);
      if (!group) throw Error('Tidak menemukan Render Sandbox group.');
      const build = await sandboxes.builds.create({ sandboxGroupId: group.id, name: 'solidity-forge-node22', sourceImage: 'node:22-bookworm' });
      let current = build, end = Date.now() + 300000;
      while (!['succeeded','failed'].includes(current.status) && Date.now() < end) {
        await sleep(3000);
        current = await sandboxes.builds.get({ sandboxGroupId: group.id, buildId: build.id });
      }
      if (current.status !== 'succeeded') throw Error('Build sandbox gagal: ' + (current.failureReason || current.status));
      return imageCache = { buildId: build.id, groupId: group.id };
    } finally {
      if (seed?.id) try { await sandboxes.terminate(seed.id); } catch (e) { console.error('Seed cleanup:', e.message); }
    }
  })();
  try { return await imagePromise; } finally { imagePromise = undefined; }
}

async function run(files, kind, command, install) {
  if (!sandboxes) throw Error('Render Sandbox belum dikonfigurasi; set RENDER_API_KEY dan RENDER_WORKSPACE_ID.');
  const entries = validate(files);
  let sb, error, out = '', err = '', code, cleanup = 'not-created';
  try {
    const img = await ensureImage();
    sb = await sandboxes.create({
      sandboxGroupId: img.groupId, buildId: img.buildId, timeoutSeconds: TIMEOUT, idleTimeoutSeconds: 300,
      networkPolicy: { type: 'allow-list', rules: [
        {domain:'registry.npmjs.org'}, {domain:'npmjs.com'}, {domain:'foundry.paradigm.xyz'},
        {domain:'github.com'}, {domain:'objects.githubusercontent.com'}, {domain:'release-assets.githubusercontent.com'},
        {domain:'binaries.soliditylang.org'}
      ]}
    });
    cleanup = 'pending';
    await sandboxes.waitUntilRunning(sb.id, { timeoutMs: 120000 });
    await sandboxes.exec(sb.id, 'mkdir -p /workspace');
    for (const [name, body] of entries) {
      if (name === 'foundry.toml') continue;
      const dest = '/workspace/' + name;
      await sandboxes.exec(sb.id, 'mkdir -p ' + quote(path.posix.dirname(dest)));
      await sandboxes.upload(sb.id, dest, Buffer.from(body));
    }
    if (kind === 'solidity') await sandboxes.upload(sb.id, '/workspace/foundry.toml', Buffer.from('[profile.default]\nsrc = "src"\ntest = "test"\nlibs = ["lib"]\nffi = false\nfs_permissions = []\n'));
    const bootstrap = kind === 'solidity'
      ? 'curl -fsSL https://foundry.paradigm.xyz -o /tmp/foundry.sh && bash /tmp/foundry.sh && /root/.foundry/bin/foundryup && export PATH=/root/.foundry/bin:$PATH'
      : 'node --version && npm --version';
    const full = 'set -euo pipefail; cd /workspace; ' + bootstrap + '; ' + install + '; ' + command;
    for await (const ev of await sandboxes.exec(sb.id, 'bash -lc ' + quote(full))) {
      if (ev.type === 'output') {
        if (ev.stream === 'stderr') err = (err + ev.data).slice(-OUTPUT_LIMIT);
        else out = (out + ev.data).slice(-OUTPUT_LIMIT);
      } else if (ev.type === 'exit') code = ev.exit_code;
    }
    if (code === undefined) throw Error('Sandbox selesai tanpa exit event; hasil tidak dapat dipastikan.');
  } catch (e) { error = e; }
  finally {
    if (sb?.id) try { await sandboxes.terminate(sb.id); cleanup = 'terminated'; }
    catch (e) { cleanup = 'unconfirmed: ' + e.message; }
  }
  if (error) throw Error(error.message + (sb?.id ? ' (sandbox ' + sb.id + '; cleanup ' + cleanup + ')' : ''));
  return { passed: code === 0, exit_code: code, stdout: out, stderr: err, sandbox_id: sb.id, runtime: 'Render disposable Linux microVM', execution: kind === 'solidity' ? 'Foundry forge test / EVM (REVM)' : 'TypeScript test runner / local EVM when configured', cleanup };
}

function makeServer() {
  const server = new McpServer({ name: 'solidity-forge', version: '0.2.0' });
  server.registerTool('run_solidity_tests', {
    title: 'Run Solidity Tests',
    description: 'Run Foundry unit, fuzz and invariant tests in a fresh disposable Render microVM using Foundry EVM/REVM. Supply src, test and dependency files; foundry.toml is replaced by a restrictive config.',
    inputSchema: {
      files: z.record(z.string(), z.string()),
      match: z.string().max(200).optional(),
      fuzz_runs: z.number().int().min(1).max(10000).default(256),
      invariant_runs: z.number().int().min(1).max(1000).default(256),
      invariant_depth: z.number().int().min(1).max(1000).default(64),
      verbosity: z.number().int().min(1).max(4).default(2)
    }
  }, async ({files, match, fuzz_runs, invariant_runs, invariant_depth, verbosity}) => {
    try {
      const filter = match ? ' --match-test ' + quote(match) : '';
      const cmd = 'export PATH=/root/.foundry/bin:$PATH; forge test --fuzz-runs ' + fuzz_runs + ' --invariant-runs ' + invariant_runs + ' --invariant-depth ' + invariant_depth + ' -' + 'v'.repeat(verbosity) + filter;
      const result = await run(files, 'solidity', cmd, 'true');
      return { content: [{type:'text', text:JSON.stringify(result,null,2)}], isError: !result.passed };
    } catch (e) { return {isError:true,content:[{type:'text',text:'Solidity test gagal: '+e.message}]}; }
  });
  server.registerTool('run_typescript_tests', {
    title: 'Run TypeScript Tests',
    description: 'Run TypeScript smart-contract tests in a disposable Render microVM. Supports npm scripts, Hardhat, Mocha, Vitest, Jest, ethers.js and viem. User test code runs inside the sandbox.',
    inputSchema: {
      files: z.record(z.string(), z.string()),
      test_command: z.enum(['auto','npm test','npx hardhat test','npx mocha','npx vitest run','npx jest']).default('auto'),
      install: z.enum(['auto','npm ci','npm install']).default('auto')
    }
  }, async ({files, test_command, install}) => {
    try {
      if (!files['package.json']) throw Error('package.json wajib disertakan.');
      const pkg = JSON.parse(files['package.json']);
      const cmd = test_command === 'auto' ? (pkg.scripts?.test ? 'npm test' : 'npx hardhat test') : test_command;
      const installer = install === 'auto' ? (files['package-lock.json'] ? 'npm ci' : 'npm install') : install;
      const result = await run(files, 'typescript', cmd, installer + ' --no-audit --no-fund');
      return {content:[{type:'text',text:JSON.stringify(result,null,2)}],isError:!result.passed};
    } catch(e) { return {isError:true,content:[{type:'text',text:'TypeScript test gagal: '+e.message}]}; }
  });
  return server;
}

const httpServer = http.createServer(async (req,res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({ok:true,service:'solidity-forge',version:'0.2.0',sandbox_configured:Boolean(sandboxes)}));
  }
  if (req.url !== '/mcp') { res.writeHead(404); return res.end('Not found'); }
  if (!TOKEN || req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('Unauthorized'); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method not allowed'); }
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on('close', () => { transport.close(); server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req,res); }
  catch(e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end('MCP request failed'); }
});
httpServer.listen(PORT,'0.0.0.0',()=>process.stderr.write('Solidity Forge listening on '+PORT+'\n'));
