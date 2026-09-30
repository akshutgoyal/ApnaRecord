// A tiny assertion harness, shared by the suites.
//
// Deliberately not a framework. The suites are run directly with `node` so they work in
// a fresh clone with no test dependency to install, and so a failure can be read without
// a reporter getting between you and the message.
//
// Every assertion takes a `detail` argument, and every caller is expected to pass the
// value it actually saw. A bare "expected true" tells you nothing at 2am.

const results = { passed: 0, failed: 0 };
let section = '';

export function group(name) {
  section = name;
  console.log(`\n${name}`);
}

export function check(name, condition, detail = '') {
  if (condition) {
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    results.failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Assert that `fn` throws, and hand back the error so its message can be inspected. */
export function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

export function report() {
  const { passed, failed } = results;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0 && section) console.log(`(last section: ${section})`);
  process.exit(failed === 0 ? 0 : 1);
}
