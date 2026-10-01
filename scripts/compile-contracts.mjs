// COMPILE THE CONTRACTS.
//
//   npm run compile:contracts
//
// Two contracts, compiled SEPARATELY, because `settings.evmVersion` is global to a solc
// invocation — one call cannot target Shanghai for one file and Cancun for another. The
// two have genuinely different requirements:
//
//   ApnaRecordAccount.sol   no imports    -> shanghai
//   ApnaRecord.sol          OpenZeppelin  -> cancun (OpenZeppelin uses `mcopy`)
//
// Targeting Cancun for the account bought nothing and cost two things: the bytecode
// refuses to run on any EVM that predates it — including the in-process one the tests
// use — and it narrowed where the account could ever be deployed. An `mcopy` opcode
// presented as an invalid opcode is a revert with no data, which reads as an
// unexplained failure rather than a version mismatch.
//
// That is also why each artifact records the evmVersion it was actually built with.
// An earlier version of this script hard-coded `'cancun'` into the account's artifact
// while compiling it with `'shanghai'` — a lie in a committed file whose entire purpose
// is to let someone check the bytecode against its source.
//
// The output is committed. Deploying should never require a Solidity compiler at
// runtime, and the artifact is what makes the deployed bytecode auditable against the
// source it came from.
//
// ApnaRecord is still deployed from Remix, not from its artifact — the artifact exists
// so the contract is VERIFIED to compile here, and so a change that does not compile is
// caught before it reaches a deploy cycle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const contractsDir = path.join(root, 'contracts');
const artifactsDir = path.join(contractsDir, 'artifacts');

/**
 * Resolve an OpenZeppelin import out of node_modules.
 *
 * Without this the compiler reports "Source not found" for every import, which looks
 * like a broken contract rather than a missing resolver.
 */
function findImports(importPath) {
  try {
    return { contents: fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8') };
  } catch (error) {
    return { error: `Could not resolve ${importPath}: ${error.message}` };
  }
}

function compile({ source, evmVersion }) {
  const input = {
    language: 'Solidity',
    sources: { [source]: { content: fs.readFileSync(path.join(contractsDir, source), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Pinned, so the same source produces the same bytecode.
      evmVersion,
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const diagnostics = output.errors || [];
  const errors = diagnostics.filter((entry) => entry.severity === 'error');

  for (const entry of diagnostics.filter((e) => e.severity === 'warning')) {
    console.warn(`  warning  ${entry.formattedMessage.trim()}`);
  }

  if (errors.length > 0) {
    for (const entry of errors) console.error(entry.formattedMessage);
    console.error(`\n  ${source} failed to compile.\n`);
    process.exit(1);
  }

  return output.contracts[source][source.replace(/\.sol$/, '')];
}

const CONTRACTS = [
  { source: 'ApnaRecordAccount.sol', evmVersion: 'shanghai' },
  { source: 'ApnaRecord.sol', evmVersion: 'cancun' },
];

console.log('\n  Compiling contracts\n');
fs.mkdirSync(artifactsDir, { recursive: true });

for (const { source, evmVersion } of CONTRACTS) {
  const contractName = source.replace(/\.sol$/, '');
  const compiled = compile({ source, evmVersion });

  const artifact = {
    contractName,
    compiler: solc.version(),
    // Recorded so a reader can confirm the artifact matches the source without having
    // to trust that someone recompiled it — and recorded truthfully, from the same
    // variable that drove the compile rather than a copy of what it was meant to be.
    source,
    evmVersion,
    optimizerRuns: 200,
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
  };

  const outPath = path.join(artifactsDir, `${contractName}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const size = (artifact.deployedBytecode.length - 2) / 2;
  console.log(
    `  ${contractName.padEnd(22)} ${String(size).padStart(5)} bytes  ${evmVersion.padEnd(9)} ${outPath}`
  );
}

console.log(`\n  Done. Compiler ${solc.version()}\n`);
