/**
 * Health Controller
 *
 * Two depths, deliberately.
 *
 * `/api/health` is a liveness probe: cheap, no third parties, and it should not go red
 * because a node is slow. A health check that fails during someone else's outage trains
 * people to ignore it, and an ignored check is worse than none.
 *
 * `/api/health?deep=1` answers the question a demo actually cares about — is anything
 * about to break — and returns 503 when something is. The important one is the gas float:
 * a dripper that has quietly emptied is the failure that LOOKS like success, because
 * enrolments keep appearing to work while nobody can be funded. That was a log line
 * nobody reads; here it is a status code a monitor can alert on.
 */
export async function getHealth(req, res) {
  const base = {
    status: 'ok',
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  };

  if (!req.query.deep) {
    return res.status(200).json(base);
  }

  const checks = {};
  const problems = [];

  try {
    const { dripperStatus } = await import('../services/dripper.js');
    const dripper = await dripperStatus();
    checks.dripper = {
      enabled: dripper.enabled,
      low: dripper.low ?? null,
      balanceEth: dripper.balanceEth ?? null,
      enrolmentsRemaining: dripper.enrolmentsRemaining ?? null,
    };
    if (!dripper.enabled) {
      problems.push(
        `the dripper is disabled (${dripper.reason || 'no key'}) — enrolments cannot be funded`
      );
    } else if (dripper.low) {
      problems.push(`the gas float is low — ${dripper.balanceEth} ETH left`);
    }
  } catch (error) {
    checks.dripper = { error: error.message };
    problems.push('the dripper could not be read');
  }

  try {
    const { isDbReady } = await import('../models/index.js');
    checks.database = { ready: isDbReady() };
    if (!isDbReady()) problems.push('the database is not connected');
  } catch (error) {
    checks.database = { error: error.message };
    problems.push('the database could not be read');
  }

  try {
    const { status } = await import('../services/chain.js');
    const chain = await status();
    checks.chain = {
      contract: chain.contract,
      chainId: chain.chainId,
      blockNumber: chain.blockNumber,
    };
  } catch (error) {
    checks.chain = { error: error.message };
    problems.push('the chain is unreachable');
  }

  return res.status(problems.length ? 503 : 200).json({
    ...base,
    status: problems.length ? 'degraded' : 'ok',
    checks,
    problems,
  });
}
