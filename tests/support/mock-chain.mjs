// A minimal JSON-RPC node for testing the dripper without a real chain.
//
// It really decodes the signed transactions it is sent, so the nonce assertion in the
// suite means something: a mock that accepts anything cannot catch a nonce collision.
//
// BATCHES MATTER. ethers batches calls made in the same tick, so the body can be an
// array. A node that only understands single requests answers a batch with one
// mangled reply and no id, and every call fails with "missing response" — a harness
// bug that reads exactly like a product bug.

import http from 'node:http';
import { Transaction, formatEther, parseEther, Interface, id } from 'ethers';

const PORT = Number(process.env.MOCK_PORT) || 8545;
const DRIPPER = (process.env.MOCK_DRIPPER || '').toLowerCase();
// How many sends to accept but then report with a hash the client will reject.
let badHashSends = Number(process.env.MOCK_BAD_HASH_COUNT) || 0;

// Contract reads the server makes before it will store a record or verify a proof.
// Typed, so the mock can answer them with correctly encoded results instead of a bare
// `0x` — which ethers cannot decode, turning every read into a decode error and making
// the records endpoint impossible to test.
const READS = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function verifyRecord(uint256,bytes32) view returns (bool)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function canAccess(uint256,address) view returns (bool)',
  'function viewRecord(uint256) view returns (string)',
]);

const selector = (name) => READS.getFunction(name).selector.toLowerCase();

// How many records each address owns. Settable at runtime through the custom
// `mock_setRecordCount` method, because the rebind guard depends on a wallet holding
// records and no single fixed answer can test both the refusal and the allowance.
const recordCounts = new Map();

const balances = new Map();
const nonces = new Map();
// Sender -> every nonce it has ever used. The point of the whole suite.
const usedNonces = new Map();
const sent = [];

if (DRIPPER) balances.set(DRIPPER, parseEther(process.env.MOCK_FLOAT || '10'));

const hex = (value) => `0x${value.toString(16)}`;
const at = (address) => String(address || '').toLowerCase();

function handle(message) {
  switch (message.method) {
    // A test hook, not a chain method. Lets a suite say "this wallet owns two records"
    // without needing a real mint — which is what the rebind guard turns on.
    case 'mock_setRecordCount': {
      const [address, count] = message.params || [];
      recordCounts.set(String(address).toLowerCase(), Number(count));
      return true;
    }
    case 'eth_chainId':
      return hex(11155111);
    case 'net_version':
      return '11155111';
    case 'eth_blockNumber':
      return hex(1_000_000 + sent.length);
    case 'eth_getBalance':
      return hex(balances.get(at(message.params?.[0])) ?? 0n);
    case 'eth_getTransactionCount':
      return hex(nonces.get(at(message.params?.[0])) ?? 0);
    case 'eth_estimateGas':
      return hex(21000);
    case 'eth_gasPrice':
      return hex(2_000_000_000);
    case 'eth_maxPriorityFeePerGas':
      return hex(1_000_000_000);
    case 'eth_feeHistory':
      return {
        oldestBlock: hex(1_000_000),
        baseFeePerGas: [hex(1_000_000_000), hex(1_000_000_000)],
        gasUsedRatio: [0.5],
        reward: [[hex(1_000_000_000)]],
      };
    case 'eth_getBlockByNumber':
      // ethers parses a full block, so every field it expects must be present and
      // well-formed — a missing `difficulty` surfaces as BAD_DATA, not as a blank field.
      return {
        number: hex(1_000_000 + sent.length),
        hash: `0x${'ab'.repeat(32)}`,
        parentHash: `0x${'cd'.repeat(32)}`,
        nonce: '0x0000000000000000',
        sha3Uncles: `0x${'1d'.repeat(32)}`,
        logsBloom: `0x${'00'.repeat(256)}`,
        transactionsRoot: `0x${'56'.repeat(32)}`,
        stateRoot: `0x${'78'.repeat(32)}`,
        receiptsRoot: `0x${'90'.repeat(32)}`,
        miner: '0x0000000000000000000000000000000000000000',
        difficulty: '0x0',
        totalDifficulty: '0x0',
        extraData: '0x',
        size: hex(1000),
        gasLimit: hex(30_000_000),
        gasUsed: hex(21_000),
        baseFeePerGas: hex(1_000_000_000),
        timestamp: hex(Math.floor(Date.now() / 1000)),
        uncles: [],
        transactions: [],
      };
    case 'eth_call': {
      const call = message.params?.[0] || {};
      const data = String(call.data || '0x');
      const which = data.slice(0, 10).toLowerCase();

      // ownerOf on a token that does not exist REVERTS — that is how the server tells
      // "this token has an owner" from "this token is about to be minted". Answering
      // with zeros would claim every token is owned by address(0) and quietly send
      // every upload down the wrong branch.
      if (which === selector('ownerOf')) {
        return { __revert: 'ERC721NonexistentToken(uint256)' };
      }
      if (which === selector('nextTokenId')) {
        return READS.encodeFunctionResult('nextTokenId', [BigInt(process.env.MOCK_NEXT_TOKEN_ID || 1)]);
      }
      if (which === selector('hasRole')) {
        return READS.encodeFunctionResult('hasRole', [process.env.MOCK_IS_ADMIN === 'true']);
      }
      if (which === selector('verifyRecord')) {
        return READS.encodeFunctionResult('verifyRecord', [process.env.MOCK_VERIFY_RECORD !== 'false']);
      }
      if (which === selector('DEFAULT_ADMIN_ROLE')) {
        return READS.encodeFunctionResult('DEFAULT_ADMIN_ROLE', [id('DEFAULT_ADMIN_ROLE')]);
      }
      if (which === selector('canAccess')) {
        return READS.encodeFunctionResult('canAccess', [false]);
      }
      if (which === selector('balanceOf')) {
        const [owner] = READS.decodeFunctionData('balanceOf', data);
        return READS.encodeFunctionResult('balanceOf', [
          BigInt(recordCounts.get(String(owner).toLowerCase()) || 0),
        ]);
      }
      // Unknown call. Zeros of the right shape rather than a bare `0x`, so a read the
      // server does not expect still decodes instead of throwing.
      return `0x${'00'.repeat(32)}`;
    }
    case 'eth_sendRawTransaction': {
      const tx = Transaction.from(message.params[0]);
      const from = at(tx.from);
      const to = at(tx.to);
      sent.push({ from, to, value: tx.value.toString(), nonce: tx.nonce });

      const used = usedNonces.get(from) || new Set();
      // A REUSE is the failure that matters, and it is the only thing flagged here.
      //
      // An earlier version compared against the next expected number, which flagged
      // out-of-order arrival as a collision. Two servers racing produce nonces that
      // reach the node in any order, and that is fine — nonces exist to be ordered by
      // the chain, not by arrival. What is not fine is the same nonce twice, because
      // one transaction then replaces the other and a payment silently disappears.
      if (used.has(tx.nonce)) {
        console.log(`  !! NONCE REUSE from ${from}: ${tx.nonce} was already sent`);
      }
      used.add(tx.nonce);
      usedNonces.set(from, used);
      nonces.set(from, Math.max(nonces.get(from) ?? 0, tx.nonce + 1));

      balances.set(from, (balances.get(from) ?? 0n) - tx.value);
      balances.set(to, (balances.get(to) ?? 0n) + tx.value);
      console.log(`  drip ${formatEther(tx.value)} ETH → ${to}  nonce=${tx.nonce}`);

      // AMBIGUOUS FAILURE MODE.
      //
      // The node accepts the transaction — the nonce advances and the balances move —
      // but the reply is one the client rejects. This is the worst case for nonce
      // handling: the sender cannot tell whether its transaction landed, and a naive
      // re-read will hand back a nonce that has already been used.
      if (badHashSends > 0) {
        badHashSends -= 1;
        console.log('  !! accepted, but replying with a bad hash to force a client-side failure');
        return `0x${'00'.repeat(32)}`;
      }

      // Otherwise the REAL hash. ethers recomputes it locally and refuses a response
      // whose hash disagrees, so a made-up value makes every send look like it failed.
      return tx.hash;
    }
    default:
      return '0x';
  }
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    // A revert has to come back as a JSON-RPC error, not as a result, or ethers will
    // happily decode it as data and the caller will never see an exception.
    const respond = (message) => {
      const result = handle(message);
      if (result && typeof result === 'object' && result.__revert) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: 3, message: `execution reverted: ${result.__revert}` },
        };
      }
      return { jsonrpc: '2.0', id: message.id, result };
    };

    const body = Array.isArray(parsed) ? parsed.map(respond) : respond(parsed);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock chain on http://127.0.0.1:${PORT}  dripper=${DRIPPER || '(none)'}`);
});
