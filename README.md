# Solidity Forge 0.3.0

Solidity Forge is a stateless MCP service for compiling and testing Solidity and TypeScript smart-contract projects. The free-tier architecture uses a Cloudflare Worker as the lightweight MCP/API gateway and GitHub Actions as the disposable test runner.

## Test engines

- Solidity: Foundry `forge test` (unit, fuzz, and invariant tests) using Foundry's local EVM/REVM.
- TypeScript: Hardhat tests on Hardhat's local in-process EVM; also supports npm test, Mocha, Vitest, and Jest.
- Each request is dispatched to a fresh GitHub-hosted Ubuntu VM. The project is executed inside a resource-limited Docker container with no host mounts except its temporary workspace. No API keys or GitHub tokens are passed into the container.

## Architecture

```text
ChatGPT / MCP client
       |
       v
Cloudflare Worker (/mcp)
       |  stores source privately in Worker KV
       |  dispatches opaque job ID only
       v
GitHub Actions (fresh hosted VM per run)
       |
       v
Docker container (resource-limited, unprivileged)
       |
       +-- Foundry / REVM
       +-- Hardhat / local EVM
       |
       v
Cloudflare Worker (private result callback)
```

## One-time setup

1. Create a Cloudflare KV namespace named `SOLIDITY_FORGE_JOBS`.
2. Put its namespace ID into `wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`.
3. Install dependencies and deploy:
   - `npm install`
   - `npx wrangler login`
   - `npx wrangler deploy`
4. Set Worker secrets:
   - `npx wrangler secret put SOLIDITY_FORGE_TOKEN` — bearer token used by the MCP client.
   - `npx wrangler secret put FORGE_CALLBACK_TOKEN` — separate random token shared with the GitHub Actions repository secret.
   - `npx wrangler secret put GITHUB_TOKEN` — fine-grained GitHub PAT with Actions: write for this repository only.
   - `npx wrangler secret put GITHUB_OWNER` — GitHub owner.
   - `npx wrangler secret put GITHUB_REPO` — repository name.
5. In GitHub repository Settings → Secrets and variables → Actions:
   - Add secret `FORGE_CALLBACK_TOKEN` with the same value used in the Worker.
   - Add variable `FORGE_WORKER_URL` with the deployed Worker base URL.
   - Enable GitHub Actions for the repository.
6. The workflow file `.github/workflows/forge-runner.yml` must exist on the default branch. The GitHub repository must be public to use standard hosted runners without Actions compute charges.

## MCP endpoint

- URL: `https://<worker-host>/mcp`
- Authentication: `Authorization: Bearer <SOLIDITY_FORGE_TOKEN>`
- Health: `GET /health`

Tools:
- `run_solidity_tests` — queues a Foundry job and returns a `job_id`.
- `run_typescript_tests` — queues a TypeScript job and returns a `job_id`.
- `get_test_result` — polls the job result by `job_id`.

Jobs and results expire from KV after one hour. The workflow retries initial KV reads to account for cross-region KV propagation. The MCP caller should poll every few seconds until status is `completed`.

## Input limits and security

- Up to 80 files, 128 KiB per file, 256 KiB total. The small payload cap is intentional to keep Worker request parsing within the Free plan CPU budget; omit a large package-lock.json and let the isolated runner install from package.json.
- Environment files, common private-key file extensions, `.git`, `.github`, and `node_modules` paths are rejected.
- Only fixed test commands are accepted; no arbitrary shell command is exposed.
- The workflow dispatch contains only an opaque random job ID. Project source and test results are held in the Worker KV namespace, not embedded in public workflow inputs.
- The container has CPU, memory, process, filesystem, and privilege restrictions. It receives no GitHub token or Worker callback secret.
- Dependencies and compiler downloads require outbound network access from the isolated container. Do not submit private keys, API credentials, wallet seed phrases, or other secrets in project files or source code.
- A Docker container is defense-in-depth, not a substitute for a dedicated hardened multi-tenant sandbox. Treat submitted code as untrusted and keep the GitHub repository dedicated to this runner.

## Free-tier notes

GitHub standard hosted runners are free for public repositories. Cloudflare Workers Free currently allows 100,000 requests/day and 10 ms CPU per request; KV Free allows 100,000 reads/day and 1,000 writes plus 1,000 deletes/day. The 256 KiB input cap helps keep the gateway within its CPU allowance. This setup is designed for low-volume personal testing, not guaranteed unlimited production traffic.

## Current verification status

The migration source and workflow are committed to the repository, but deployment and end-to-end execution still require the one-time Cloudflare and GitHub secrets/KV setup. Do not treat the service as live until a real Foundry and Hardhat job completes successfully.
