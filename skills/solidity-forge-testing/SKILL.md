---
name: solidity-forge-testing
description: Use when the user needs Solidity Foundry tests or TypeScript smart-contract tests executed in a disposable isolated runner.
---

# Solidity Forge Testing

Use `run_solidity_tests` for Foundry projects and `run_typescript_tests` for TypeScript smart-contract projects. Both tools queue a fresh GitHub-hosted runner and return a `job_id`. Poll `get_test_result` until it returns `completed`.

## Solidity

Pass project files as a `files` object keyed by relative path. Include Solidity sources and `test/*.t.sol`. The runner supplies a restrictive `foundry.toml` and runs `forge test`, including fuzz and invariant tests, using Foundry's local EVM/REVM. Include any required library source files such as forge-std if your tests import them.

## TypeScript / Hardhat

Include `package.json`, optional `package-lock.json`, Hardhat configuration, Solidity sources, and tests. Hardhat tests execute against Hardhat's local in-process EVM. Also supports npm test, Mocha, Vitest, and Jest.

## Safety

Never include .env files, private keys, API tokens, wallet seed phrases, or other secrets. The project is stored temporarily in Cloudflare KV and then executed in a resource-limited Docker container on a fresh GitHub-hosted VM. No GitHub or Worker secrets are passed into the test container. The container has outbound network access for package and compiler downloads. A passing local EVM test is not a mainnet deployment or audit guarantee.
