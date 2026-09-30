// Must be first: loads server/.env before any other module reads process.env.
import './config/env.js';
import express from 'express';
import cors from 'cors';
import apiRoutes from './routes/apiRoutes.js';
import { connectDB } from './config/db.js';
import { warmStats } from './controllers/statsController.js';
import { dripperStatus } from './services/dripper.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
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
    console.log(`  rpc           ${process.env.SEPOLIA_RPC_URL || '(SEPOLIA_RPC_URL not set)'}`);
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
