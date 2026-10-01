// THE RPC PROXY.
//
// Without this the browser talks to a public node directly, and that node sees every
// user's IP sitting next to the addresses they read and the transactions they send.
// The chain was carefully built so that a record's owner cannot be identified from it
// — and then the transport handed the join back for free, because reading a balance
// reveals which addresses belong to one person.
//
// So chain access goes through here. It is a narrow passthrough rather than a general
// proxy: the method allowlist IS the security posture, and it is written out rather
// than inferred so that adding a method is a deliberate act.
//
// WHAT THIS DOES NOT DO. It hides the user's IP from the upstream node. It does not
// hide anything from this server, which sees the same reads and the same signed
// transactions. That is the honest limit of a relay, and it is still a real
// improvement: the operator of a shared public node learns nothing about who is
// looking at what.

import { getProvider } from '../services/chain.js';
import { noteHit } from '../lib/rateLimit.js';

/**
 * The methods the app actually uses, and nothing else.
 *
 * `eth_sendRawTransaction` is here on purpose — hiding the sender's IP is the point of
 * the whole file. That does make this a broadcast service for anyone who finds it, so
 * it is rate-limited below; the alternative is that writes advertise the user's IP.
 */
const ALLOWED_METHODS = new Set([
  // Handshake — ethers asks for these before it will talk at all.
  'eth_chainId',
  'net_version',
  // Reads
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  // Estimates, for building a transaction locally
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  // The one write, and the reason this exists
  'eth_sendRawTransaction',
]);

/** Cap on a single batched request. ethers batches; an unbounded batch is a free amplifier. */
const MAX_BATCH = 20;

function rpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

export async function rpcProxy(req, res) {
  const body = req.body;

  // ethers sends a batch as an array and a single call as an object; both are valid
  // JSON-RPC and the response shape has to match what was asked for.
  const single = !Array.isArray(body);
  const calls = single ? [body] : body;

  if (calls.length === 0 || calls.length > MAX_BATCH) {
    return res.status(400).json(rpcError(body?.id, -32600, `Expected 1..${MAX_BATCH} calls.`));
  }

  for (const call of calls) {
    if (typeof call?.method !== 'string' || !ALLOWED_METHODS.has(call.method)) {
      // Refused loudly rather than silently proxied. A method that is not on the list
      // is either a mistake or an attempt to use this as an open node.
      return res
        .status(400)
        .json(rpcError(call?.id, -32601, `Method not allowed through the relay: ${call?.method}`));
    }
  }

  const allowed = await noteHit('rpc', clientKey(req), 600, 60_000);
  if (!allowed) {
    return res.status(429).json(rpcError(calls[0]?.id, -32000, 'Too many requests. Slow down.'));
  }

  const provider = getProvider();
  const results = [];
  for (const call of calls) {
    try {
      const result = await provider.send(call.method, call.params || []);
      results.push({ jsonrpc: '2.0', id: call.id ?? null, result });
    } catch (error) {
      // The revert payload has to survive. A custom error is decoded on the client from
      // `error.data`, so dropping it would turn "PatientNotLinked" back into an
      // unexplained failure — the exact problem the custom errors exist to solve.
      const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
      results.push(
        rpcError(
          call.id,
          Number(error?.code) || -32000,
          error?.shortMessage || error?.message || 'RPC call failed',
          typeof data === 'string' ? data : undefined
        )
      );
    }
  }

  return res.json(single ? results[0] : results);
}

function clientKey(req) {
  // `req.ip` respects the `trust proxy` setting, which the app configures for the
  // reverse proxy it is deployed behind. Falling back keeps a direct run working.
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}
