---
name: solidity-forge-testing
description: Use when the user needs Solidity Foundry tests or TypeScript smart-contract tests executed in an isolated cloud EVM environment.
---

# Solidity Forge Testing

Use `run_solidity_tests` for Foundry projects and `run_typescript_tests` for TypeScript smart-contract test projects.

## Solidity

Pass project files as a `files` object keyed by relative path. Include Solidity sources, `test/*.t.sol`, and required library sources. User-supplied foundry.toml is ignored. Runner installs Foundry in a disposable Render Sandbox and runs `forge test`, including fuzz and invariant tests.

## TypeScript

Include package.json, optional lockfile, Hardhat configuration, Solidity sources, and tests. Supports npm test, Hardhat, Mocha, Vitest and Jest, plus ethers.js and viem.

## Safety

Never include .env, private keys, API tokens, or secrets. Test code runs inside an isolated disposable microVM. Report exact exit status and logs. A passing local EVM test is not a mainnet deployment or audit guarantee.