// WHERE THE VERIFICATION CODE IS ACTUALLY SENT.
//
// One interface, three implementations. The default is `mock`, which prints the code to
// the server log and returns it to the browser — so enrolment works with no account with
// any provider, no DNS records, and no credentials, and the whole flow is demonstrable
// today. Swapping to a real relay is an env change, not a code change.
//
// WHY A RELAY RATHER THAN SMTP STRAIGHT FROM THE SERVER. A verification code sent from a
// shared host's mail server lands in spam more often than not, and a code nobody can find
// is indistinguishable from a server that is broken. A relay that is authenticated for the
// sending domain — SPF, DKIM and DMARC published — is what makes the difference between
// this working and merely appearing to.
//
// What that requires, and it is setup rather than code:
//
//   1. SPF, DKIM and DMARC records on the sending domain.
//   2. The domain verified at the relay, and a From address on it.
//   3. EMAIL_FROM set to that address, so the envelope matches the records.
//
// Miss any of the three and the failure is silent: codes arrive in spam, or nowhere.

const PROVIDER = () => (process.env.EMAIL_PROVIDER || 'mock').toLowerCase();

export function emailProviderName() {
  return PROVIDER();
}

/** True when codes will not reach a real inbox. Used to warn on the banner. */
export function isMockProvider() {
  return PROVIDER() === 'mock';
}

function fromAddress() {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error(
      'EMAIL_FROM is not set. It must be an address on the domain you have verified with ' +
        'the relay — otherwise your messages fail the domain checks and land in spam.'
    );
  }
  return from;
}

/**
 * Split "Name <email@domain>" into { name, email }.
 * Resend accepts the display-name form as-is; Brevo needs the two parts
 * separately, and rejects a display name inside `sender.email`.
 */
function splitFrom(from) {
  const match = /^\s*(.*?)\s*<\s*([^<>\s@]+@[^<>\s]+)\s*>\s*$/.exec(from);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, '');
    return { name: name || undefined, email: match[2].trim() };
  }
  return { name: undefined, email: from.trim() };
}

function bodyFor(code) {
  return (
    `Your ApnaRecord verification code is ${code}.\n\n` +
    'It expires in five minutes. If you did not ask for it, you can ignore this message — ' +
    'nobody can use the code without it, and it is the only thing this email is for.\n'
  );
}

async function sendWithMock(email, code) {
  // Loud on purpose. A silent mock in production means users wait forever for a code that
  // was only ever written to a log nobody reads.
  console.log('');
  console.log('  ┌─ Verification code (mock sender — no email was sent) ─────');
  console.log(`  │  to    ${email}`);
  console.log(`  │  code  ${code}`);
  console.log('  └───────────────────────────────────────────────────────────');
  console.log('');
  return { delivered: true, provider: 'mock' };
}

async function sendWithResend(email, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set.');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress(),
      to: [email],
      subject: `ApnaRecord verification code`,
      text: bodyFor(code),
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend refused the message (${response.status}): ${await response.text()}`);
  }
  return { delivered: true, provider: 'resend' };
}

async function sendWithBrevo(email, code) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY is not set.');

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: (() => {
        const { name, email } = splitFrom(fromAddress());
        return name ? { name, email } : { email };
      })(),
      to: [{ email }],
      subject: 'ApnaRecord verification code',
      textContent: bodyFor(code),
    }),
  });

  if (!response.ok) {
    throw new Error(`Brevo refused the message (${response.status}): ${await response.text()}`);
  }
  return { delivered: true, provider: 'brevo' };
}

/**
 * Send a verification code.
 *
 * Throws on failure so the caller can tell the user the code did not go out, rather than
 * leaving them waiting for an email that was never accepted. A swallowed send failure is
 * indistinguishable from a slow inbox and wastes the user's time twice.
 */
export async function sendCodeByEmail(email, code) {
  switch (PROVIDER()) {
    case 'mock':
      return sendWithMock(email, code);
    case 'resend':
      return sendWithResend(email, code);
    case 'brevo':
      return sendWithBrevo(email, code);
    default:
      throw new Error(`EMAIL_PROVIDER="${PROVIDER()}" is not one of mock, resend or brevo.`);
  }
}
