// COMPILE THE CONTRACTS WE DEPLOY OURSELVES.
//
//   npm run compile:contracts
//
// Only `ApnaRecordAccount.sol` is built here, and that is deliberate rather than an
// oversight. It has no imports, so a single-file compile needs no dependency graph and
// no remappings — which is the main reason it was written without OpenZeppelin.
//
// `ApnaRecord.sol` is NOT compiled here: it imports OpenZeppelin, was built in Remix
// (with the EVM version set to Cancun — see the note at the top of that file), and is
// already deployed. Only its ABI is mirrored into the server and client, and that
// mirroring is checked by hand when it changes.
//
// The output is committed. Deploying should never require a Solidity compiler at
// runtime, and the artifact is what makes the deployed bytecode auditable against the
// source it came from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const contractsDir = path.join(root, 'contracts');
const artifactsDir = path.join(contractsDir, 'artifacts');

const SOURCES = ['ApnaRecordAccount.sol'];

const sources = {};
for (const name of SOURCES) {
  sources[name] = { content: fs.readFileSync(path.join(contractsDir, name), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Pinned so the same source produces the same bytecode. The account is deployed by
    // the dripper from this exact artifact, and a silent compiler default change would
    // mean the committed bytecode no longer matches what a rebuild would produce.
    evmVersion: 'cancun',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
};

console.log('\n  Compiling contracts\n');

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const diagnostics = output.errors || [];
const errors = diagnostics.filter((entry) => entry.severity === 'error');

for (const entry of diagnostics.filter((e) => e.severity === 'warning')) {
  console.warn(`  warning  ${entry.formattedMessage.trim()}`);
}

if (errors.length > 0) {
  for (const entry of errors) console.error(entry.formattedMessage);
  console.error('\n  Compilation failed.\n');
  process.exit(1);
}

fs.mkdirSync(artifactsDir, { recursive: true });

for (const name of SOURCES) {
  const contractName = name.replace(/\.sol$/, '');
  const compiled = output.contracts[name][contractName];

  const artifact = {
    contractName,
    compiler: solc.version(),
    // Recorded so a reader can confirm the artifact matches the source without
    // having to trust that someone recompiled it.
    source: name,
    evmVersion: 'cancun',
    optimizerRuns: 200,
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
  };

  const outPath = path.join(artifactsDir, `${contractName}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const size = (artifact.deployedBytecode.length - 2) / 2;
  console.log(`  ${contractName.padEnd(22)} ${String(size).padStart(5)} bytes  ${outPath}`);
}

console.log(`\n  Done. Compiler ${solc.version()}\n`);
