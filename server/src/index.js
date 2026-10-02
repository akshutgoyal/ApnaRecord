// Must be first: loads server/.env before any other module reads process.env.
import { corsOrigins } from './config/env.js';
import express from 'express';
import cors from 'cors';
import apiRoutes from './routes/apiRoutes.js';
import { connectDB } from './config/db.js';
import { warmStats } from './controllers/statsController.js';
import { dripperStatus } from './services/dripper.js';
import { startIndexScheduler } from './services/indexScheduler.js';

const app = express();
const PORT = process.env.PORT || 5000;

// CORS IS AN ALLOWLIST, NOT A FORMALITY.
//
// This used to be a bare `cors()`, which sets `Access-Control-Allow-Origin: *` —
// every page on the internet could call this API from a user's browser. Nothing
// here relies on cookies, so it was never a session-riding hole, but it is a free
// invitation to enumerate endpoints and to burn the rate limits of whoever is
// looking at the site.
//
// A disallowed origin is now REFUSED with 403 rather than merely answered without
// the CORS headers. The difference matters: without the headers the browser hides
// the response, but the request still ran — the rate limiter still counted, the
// database still answered, and a side effect would still have happened. A refusal
// means it did not run at all.
const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

const allowedOrigins = corsOrigins.length > 0 ? corsOrigins : DEFAULT_DEV_ORIGINS;

// Every signing proof this API accepts travels in a header, so the preflight has to
// name them or the browser will refuse to send them.
const ALLOWED_HEADERS = [
  'Content-Type',
  'x-apnarecord-viewer',
  'x-apnarecord-issued-at',
  'x-apnarecord-nonce',
  'x-apnarecord-signature',
  'x-apnarecord-timestamp',
];

app.use((req, res, next) => {
  const origin = req.get('origin');
  // No Origin header at all means a same-origin navigation, curl, or another
  // server. CORS is a browser control and does not apply, so it is allowed — this
  // is also what keeps the test suite and the indexer working.
  if (origin && !allowedOrigins.includes(origin)) {
    // Log BOTH sides, quoted. A CORS rejection is otherwise undebuggable from outside:
    // the browser reports a network error, the API reports 403, and the one thing you
    // need — what the server has configured versus what actually arrived — is invisible.
    // It cost three round trips of guessing at a trailing slash when the difference could
    // have been printed. JSON.stringify is doing real work here: it shows a trailing
    // space, a pasted quote or a slash that an exact comparison will not forgive.
    console.warn(
      `[CORS] refused origin ${JSON.stringify(origin)} — configured: ` +
        `${allowedOrigins.map((o) => JSON.stringify(o)).join(', ') || '(none)'}`
    );
    return res.status(403).json({
      error: 'OriginNotAllowed',
      message: `Origin ${origin} may not call this API.`,
    });
  }
  return next();
});

app.use(
  cors({
    origin: allowedOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ALLOWED_HEADERS,
    maxAge: 600,
  })
);
// Record payloads are base64 ciphertext, so the default 100kb limit is far too
// small. The route itself enforces a 20 MB ceiling per record.
app.use(express.json({ limit: '30mb' }));

app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.json({
    name: 'ApnaRecord API',
    tagline:
      'Patient-owned medical records on-chain. The server serves ciphertext and asks the contract for permission.',
    version: '1.0.0',
    docs: {
      health: '/api/health',
      chainStatus: '/api/chain/status',
      identities: '/api/chain/identities',
      permissions: '/api/chain/permissions/:address',
      events: '/api/chain/events',
      records: '/api/records',
      releaseFile: '/api/records/:tokenId/file?viewer=0x…  (consent-gated)',
      audit: '/api/audit/:tokenId',
      verify: 'POST /api/verify { tokenId, fileHash }',
      createWallet: 'POST /api/wallet/enrol  (sealed blob only — the server cannot open it)',
      unlockBlob: '/api/wallet/:address',
      dripper: '/api/dripper',
    },
    custody: {
      signingKeys: 'The server holds none. Every write is signed in the browser.',
      recordBytes: 'Stored as ciphertext the server cannot read without a sealed key.',
      walletKeys:
        'Created in the browser and sealed with the user’s recovery code. The server stores ciphertext it cannot open.',
    },
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'NotFound', message: `No route for ${req.method} ${req.path}` });
});

app.use((error, req, res, next) => {
  console.error('[Server] Unhandled error:', error);
  res.status(500).json({ error: 'InternalError', message: error.message });
});

async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log('');
    console.log('  ApnaRecord API');
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  → health      http://localhost:${PORT}/api/health`);
    console.log(`  → chain       http://localhost:${PORT}/api/chain/status`);
    console.log('');
    console.log(`  contract      ${process.env.CONTRACT_ADDRESS || '(CONTRACT_ADDRESS not set)'}`);
    console.log(`  rpc           ${process.env.RPC_URL || '(RPC_URL not set)'}`);
    console.log(
      `  master key    ${process.env.MASTER_KEY ? 'set' : 'MISSING — record uploads will fail'}`
    );
    console.log('');
  });

  // Warm the dashboard aggregates in the background. Assembling them costs several
  // RPC round-trips (about six seconds cold), and the first thing anyone opening
  // the app sees is a dashboard — a blank one is a bad way to start.
  //
  // Deliberately not awaited: startup must not depend on the RPC being reachable,
  // and the API is fully usable without this succeeding.
  warmStats().then((result) => {
    if (result.ok) {
      console.log(
        `[Stats] Dashboard cache warmed — ${result.totals.records} record(s), ${result.totals.identities} identities.`
      );
    } else {
      console.warn(`[Stats] Could not warm the dashboard cache: ${result.message}`);
      console.warn('        Dashboards will still load, just slowly on first open.');
    }
  });

  // Keep the cache current on a timer. Until now this was `npm run index`, which meant
  // the cache refreshed only when somebody remembered — and a dashboard showing
  // yesterday's world looks exactly like one showing today's.
  startIndexScheduler();

  // Report the gas float on the banner. It decides whether anyone can create a
  // wallet at all, so it belongs somewhere visible rather than in a log someone
  // reads only after the first enrolment has already failed.
  dripperStatus()
    .then((status) => {
      if (!status.enabled) {
        console.warn(`[Dripper] Disabled — ${status.reason}`);
        console.warn('          Wallets can still be created; they just cannot be funded.');
        return;
      }
      console.log(
        `  dripper       ${status.balanceEth} ETH · ${status.enrolmentsRemaining} enrolment(s) affordable`
      );
      if (status.low) {
        console.warn(
          `[Dripper] LOW WATER — below ${status.lowWaterEth} ETH. Top it up before the next demo.`
        );
      }
    })
    .catch((error) => {
      // ethers puts the useful text in shortMessage; `message` is often empty for
      // network failures, which produced a log line that said nothing at all.
      const detail = error?.shortMessage || error?.message || error?.code || 'unknown error';
      console.warn(`[Dripper] Could not read the float: ${detail}`);
    });
}

startServer();
