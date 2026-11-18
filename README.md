# Solidity Forge 0.2.0

Cloud MCP backend for Solidity Foundry testing and TypeScript smart-contract testing. Each test request runs inside a disposable Render Sandbox Linux microVM.

## MCP tools

- `run_solidity_tests`: Foundry unit, fuzz, and invariant tests on Foundry's local EVM/REVM.
- `run_typescript_tests`: TypeScript smart-contract tests using npm scripts, Hardhat, Mocha, Vitest, or Jest. Hardhat projects can deploy and interact with contracts on their in-process local EVM.

## Required service environment

- `SOLIDITY_FORGE_TOKEN`: bearer token for MCP endpoint.
- `RENDER_API_KEY`: Render API key used only by the MCP host to create/terminate sandboxes.
- `RENDER_WORKSPACE_ID`: Render workspace ID.
- Optional `RENDER_SANDBOX_GROUP_ID` and `RENDER_SANDBOX_BUILD_ID` pin a prebuilt sandbox image.

## Security

Caller-provided Foundry config is ignored and replaced with restrictive settings (`ffi=false`, no filesystem permissions, offline mode). Inputs are capped at 80 files, 512 KiB per file and 4 MiB total. Secrets and .env files are rejected. No API credentials are passed to guest code. Test code is untrusted and runs in disposable microVMs.

## Limitations

Include required dependencies such as forge-std in submitted Solidity files. TypeScript projects should include package.json, test configuration, contracts and tests; include package-lock.json for deterministic npm ci installs. This source is not production verified until deployed and integration-tested.