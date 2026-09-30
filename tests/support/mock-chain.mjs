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
import { Transaction, formatEther, parseEther } from 'ethers';

const PORT = Number(process.env.MOCK_PORT) || 8545;
const DRIPPER = (process.env.MOCK_DRIPPER || '').toLowerCase();
// How many sends to accept but then report with a hash the client will reject.
let badHashSends = Number(process.env.MOCK_BAD_HASH_COUNT) || 0;

const balances = new Map();
const nonces = new Map();
const sent = [];

if (DRIPPER) balances.set(DRIPPER, parseEther(process.env.MOCK_FLOAT || '10'));

const hex = (value) => `0x${value.toString(16)}`;
const at = (address) => String(address || '').toLowerCase();

function handle(message) {
  switch (message.method) {
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
    case 'eth_call':
      // Contract reads are not what this stub is for. Hand back empty data rather than
      // inventing a plausible-looking answer.
      return '0x';
    case 'eth_sendRawTransaction': {
      const tx = Transaction.from(message.params[0]);
      const from = at(tx.from);
      const to = at(tx.to);
      sent.push({ from, to, value: tx.value.toString(), nonce: tx.nonce });

      // The nonce belongs to the SENDER. Checking the recipient's would make the
      // collision check in the suite pass no matter what the dripper did.
      const expected = nonces.get(from) ?? 0;
      if (tx.nonce !== expected) {
        console.log(`  !! NONCE COLLISION from ${from}: got ${tx.nonce}, expected ${expected}`);
      }
      nonces.set(from, tx.nonce + 1);

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

    const body = Array.isArray(parsed)
      ? parsed.map((message) => ({ jsonrpc: '2.0', id: message.id, result: handle(message) }))
      : { jsonrpc: '2.0', id: parsed.id, result: handle(parsed) };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock chain on http://127.0.0.1:${PORT}  dripper=${DRIPPER || '(none)'}`);
});
