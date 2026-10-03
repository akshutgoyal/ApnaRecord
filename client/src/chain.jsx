// The heart of the client. Every wallet and contract call goes through here, so
// no page ever touches ethers directly and a contract change touches one file.
//
// Two rules this file exists to enforce:
//
//   1. ROLE STATE IS READ FROM THE CHAIN, never from the URL or localStorage.
//      The badge and the page body therefore read the same source and cannot
//      contradict each other — a bug this project has hit before.
//
//   2. RE-READ WHENEVER IT COULD HAVE CHANGED. Switching MetaMask accounts,
//      changing network, returning to the tab, or just time passing all
//      trigger a refresh, so nothing needs a manual page reload.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { BrowserProvider, Contract, Interface, getAddress, isAddress } from 'ethers';
import { ABI, ACCOUNT_ABI, CONTRACT_ADDRESS, CHAIN_ID } from './contract';
import { chainPermissions, recordsByOwner, setProofSigner } from './services/api';
import { DEMO_ACCOUNTS } from './config/demoAccounts';
import {
  getLocalProvider,
  getLocalSigner,
  hasSession,
  sessionAddress,
  clearSession,
  restoreSession,
  unlockSession,
} from './lib/session';
import { readProofHeaders } from './lib/readProof';
import { ensureGas } from './lib/gas';

const CONTRACT_INTERFACE = new Interface(ABI);

/**
 * Decode a contract custom error from whichever shape ethers handed us.
 *
 * Exported because callers other than `describeError` need to ask *which* revert this
 * was, and a second implementation that matches on message text is how you get one that
 * never matches: the friendly wording ("Already registered") is what we render, while the
 * error itself carries a selector. That mistake made the admin console refuse to write a
 * label for an identity that already existed, which is precisely the case that needs one.
 */
export function contractError(error) {
  const candidates = [
    error?.data,
    error?.revert?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.value,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.startsWith('0x')) continue;
    try {
      const parsed = CONTRACT_INTERFACE.parseError(candidate);
      if (parsed) return parsed;
    } catch {
      /* not one of ours */
    }
  }
  return null;
}
const POLL_MS = 12_000;

// Demo mode: a walletless walkthrough. The persona key survives reloads within
// the tab (sessionStorage, never localStorage) so a refresh keeps you in demo
// but a new tab starts clean.
const DEMO_KEY = 'apnarecord-demo-role';

/** Demo persona address for a role key (admin/doctor/auditor/patient). */
export function demoAddressFor(role) {
  return DEMO_ACCOUNTS.find((entry) => entry.role === role)?.address || null;
}

export const hasWallet = () => typeof window !== 'undefined' && Boolean(window.ethereum);

/** Plain-English titles for the named refusals our API returns. */
const API_TITLES = {
  AccessDenied: 'Access denied by the contract',
  Expired: 'Consent window has closed',
  NotAuthorized: 'Not authorised by the contract',
  RecordNotFound: 'No such record',
  BlobMissing: 'Record bytes are not on this server',
  PayloadTooLarge: 'That file is larger than this server accepts',
  StorageFailed: 'The record could not be stored',
  SignatureRequired: 'A wallet signature is required',
  SignatureInvalid: 'That signature was not accepted',
  DatabaseUnavailable: 'The display-name database is offline',
  StatsUnavailable: 'Dashboard data is unavailable',
  ChainUnavailable: 'Chain unreachable',
  BadRequest: 'Invalid request',
};

/** Turn an ethers throw — or one of our backend's refusals — into something a person can act on. */
export function describeError(error) {
  if (!error) return { title: 'Something went wrong', detail: 'No further detail.' };

  if (error.code === 'ACTION_REJECTED' || error.code === 4001) {
    return { title: 'Rejected in wallet', detail: 'You cancelled the request in MetaMask.' };
  }
  if (error.code === 'API_DOWN') {
    return { title: 'Backend unreachable', detail: error.message };
  }
  // The one write failure a person can actually do something about, and the one
  // they would least understand from a raw ethers message.
  if (error.code === 'INSUFFICIENT_FUNDS') {
    return {
      title: 'This wallet has run out of test ETH',
      detail:
        'Every write costs a little gas. Press “Top up test ETH” on the Access page and try again.',
    };
  }

  // A refusal from our own API. These carry named codes that are more useful than
  // anything we could infer, and they distinguish cases the chain cannot: the
  // difference between "you may not read this" and "nobody agreed to the model
  // seeing it" is the whole point of the two AI gates.
  if (error.payload) {
    return {
      title: API_TITLES[error.code] || error.code || 'Request refused',
      detail: error.message,
      code: error.code,
      payload: error.payload,
    };
  }

  const decoded = contractError(error);
  if (decoded) return namedError(decoded);

  return {
    title: 'Transaction failed',
    detail: error.shortMessage || error.reason || error.message || 'Unknown error.',
  };
}

function namedError(parsed) {
  switch (parsed.name) {
    case 'AccessControlUnauthorizedAccount':
      return {
        title: 'Not your role',
        detail:
          'The contract refused: this wallet does not hold the role that function requires. ' +
          'The website did not block it — the contract did.',
        code: parsed.name,
      };
    case 'AccessDenied':
      return {
        title: 'Access denied by the contract',
        detail: 'The record owner has not granted this wallet access.',
        code: parsed.name,
      };
    case 'Expired':
      return {
        title: 'Consent window has closed',
        detail: 'The grant was time-boxed, and the contract no longer authorises this read.',
        code: parsed.name,
      };
    case 'NotAuthorized':
      return {
        title: 'Not authorised',
        detail:
          'The contract refused this call. For a record, that usually means you are not the owner.',
        code: parsed.name,
      };
    case 'RecordNotFound':
      return { title: 'No such record', detail: 'That token ID does not exist.', code: parsed.name };
    case 'IdentityNotFound':
      return {
        title: 'Identity not registered',
        detail: 'The patient must have a registered identity before a record can be minted to them.',
        code: parsed.name,
      };
    case 'IdentityExists':
      return { title: 'Already registered', detail: 'That wallet already has an identity.', code: parsed.name };
    case 'LinkNotRequested':
      return {
        title: 'That link is already approved',
        detail:
          'There is no pending request left to accept. The link list is mirrored from the chain ' +
          'by a background job that runs about once a minute, so a first click that looked like ' +
          'it did nothing has very likely already succeeded. Reload to see the current state ' +
          'rather than clicking again.',
        code: parsed.name,
      };
    case 'PatientNotLinked':
      return {
        title: 'This hospital is not linked to that patient',
        detail:
          'A record can only be minted for a patient who has approved the hospital. Ask the ' +
          'patient to approve the link first.',
        code: parsed.name,
      };
    case 'ERC721NonexistentToken':
      return { title: 'Record does not exist', detail: 'That token has been revoked.', code: parsed.name };
    default:
      return { title: parsed.name, detail: 'The contract rejected the call.', code: parsed.name };
  }
}

const ChainContext = createContext(null);

export function ChainProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [availableAccounts, setAvailableAccounts] = useState([]);
  const [chainId, setChainId] = useState(null);
  const [roles, setRoles] = useState({ admin: false, manager: false, auditor: false, hospital: false });
  const [identity, setIdentity] = useState({ label: '', active: false, facility: null });
  const [did, setDid] = useState('');
  const [ownedRecords, setOwnedRecords] = useState([]);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [readReady, setReadReady] = useState(false);
  // True once the first attempt to resolve a session has finished — whether that
  // ended with an account, a persona, or nothing at all. Gate components wait for
  // this instead of guessing from transient flags, so a deep link is not bounced
  // to /access while the session is still settling.
  const [bootstrapped, setBootstrapped] = useState(false);
  // The stored session arrives wrapped, so it cannot be read synchronously. Nothing
  // may conclude "nobody is signed in" until this flips.
  const [sessionRestored, setSessionRestored] = useState(false);
  // A stored session that needs the device secret before it can be used.
  //
  // This is a third state, and the reason it is tracked explicitly is that conflating
  // it with "nobody is signed in" is what sends a returning user to the sign-up page on
  // a device that already holds their wallet. The address is known; the key is not.
  const [locked, setLocked] = useState(false);
  const [lockedAddress, setLockedAddress] = useState(null);
  // The address of a wallet created here and unlocked with a recovery code, as
  // opposed to one that arrived through an extension. Tracked as state, not just
  // read from storage, so the gate can distinguish "nothing can resolve this" from
  // "a session is about to".
  const [localSession, setLocalSession] = useState(() => sessionAddress());
  // Null normally; the role key while demoing a persona (admin/doctor/auditor/patient).
  const [demoRole, setDemoRole] = useState(() => {
    try {
      const saved = sessionStorage.getItem(DEMO_KEY);
      return saved || null;
    } catch {
      return null;
    }
  });

  // The demo role is mirrored into a ref because `refresh` has to see the NEW
  // role synchronously. Reading the state variable would close over the previous
  // render's value, so entering demo mode would set the role and then refresh
  // with "no role" — which is exactly the bug this ref exists to prevent.
  const demoRoleRef = useRef(demoRole);

  const providerRef = useRef(null);
  const accountRef = useRef(null);

  const getReadProvider = useCallback(() => {
    // A demo persona reads through the server's RPC proxy, never through an
    // extension. This is the same reasoning as the role read above: the persona is
    // not a wallet account, so `window.ethereum` has nothing to say about it — and
    // if the extension happens to sit on another chain, every read silently returns
    // the wrong answer rather than failing loudly.
    //
    // `getLocalProvider()` is the server-backed JSON-RPC provider, so this also means
    // demo reads do not leak the viewer's IP to a public node. See session.js.
    if (demoRoleRef.current) return getLocalProvider();
    // A wallet we created for the user needs no extension, so it takes priority
    // when one is unlocked. This one line is what lets every existing read path in
    // the app run without MetaMask ever being installed.
    if (hasSession()) return getLocalProvider();
    if (!hasWallet()) return null;
    if (!providerRef.current) providerRef.current = new BrowserProvider(window.ethereum);
    return providerRef.current;
  }, []);

  /**
   * The signer for anything that writes.
   *
   * Two sources, one interface: a locally-created wallet that was unlocked with a
   * recovery code, or the extension if one is present. Pages never learn which —
   * `writeAs` and `signMessage` are the only consumers.
   */
  const getSigner = useCallback(async () => {
    const local = getLocalSigner();
    if (local) return local;
    const provider = getReadProvider();
    if (!provider) throw new Error('No wallet available. Create one or connect an extension.');
    return provider.getSigner();
  }, [getReadProvider]);

  /**
   * Let the API module sign for itself.
   *
   * It holds no key, and threading a wallet through every call site that reads a list
   * would touch a dozen components. So the getter is registered once, and the module asks
   * for it only when a request must prove who is asking.
   *
   * Nothing signs until a gated read happens, and the token it buys is cached for its
   * ten-minute life — so this costs one prompt per wallet per ten minutes, not one per
   * page load.
   */
  useEffect(() => {
    setProofSigner(getSigner);
    return () => setProofSigner(null);
  }, [getSigner]);

  // No eager clear here.
  //
  // This used to call clearReadToken() on every `account` change -- but `account` starts
  // null and becomes an address on connect, so it fired on every mount and wiped the
  // sessionStorage token that had just survived the navigation. The point of that token
  // is that a route change costs no prompt.
  //
  // It was also redundant. authHeaders() reads the cached entry's own `address` and
  // refuses it unless it matches the signer in hand, so a different wallet cannot inherit
  // one regardless. The check lives where the token is used, which is the only place it
  // can be trusted.

  /** A contract for reads: no signer, so MetaMask never prompts. */
  const readContract = useCallback(async () => {
    const provider = getReadProvider();
    if (!provider) return null;
    return new Contract(CONTRACT_ADDRESS, ABI, provider);
  }, [getReadProvider]);

  /**
   * Send a call to ApnaRecord. This is how every write is made.
   *
   * THERE ARE TWO KINDS OF OWNER, AND THEY NEED DIFFERENT PATHS. A wallet created here
   * owns its records through an ACCOUNT, so the call has to be wrapped in
   * `account.execute(...)`: `msg.sender` at ApnaRecord must be the account, and the
   * signing key owns nothing — calling directly reverts. A demo persona or a connected
   * browser wallet owns records as itself and calls directly.
   *
   * That split is what makes the account additive rather than a migration. It is also
   * the source of the only real subtlety here: getting it wrong produces a revert on
   * every write, which reads as a permissions bug rather than as the wrong call path.
   *
   * Wrapping has a second effect worth naming, because it is the point of the account:
   * the key is bounded. It can reach an allowlisted target and nothing else, so a stolen
   * key cannot drain whatever else the address touches.
   */
  const writeAs = useCallback(
    async (functionName, args = [], overrides = {}) => {
      // A persona is a reading exercise, and it must not reach a signer at all.
      //
      // This guard is FIRST for a reason. A persona has no session, so it fell through to
      // the branch below, which asks `getSigner()` for one — and that returns the connected
      // browser wallet when there is no local key. So pressing a write button in the demo
      // did not merely fail: it signed and broadcast a REAL transaction from the visitor's
      // own account, spending their gas on a call the persona was never authorised to
      // make. Refusing at signing time was not enough, because the wrong signer was
      // available. The refusal has to happen before one is looked for.
      if (demoRoleRef.current) {
        throw new Error(
          'This is a demonstration. A persona holds no key, so nothing here can be signed — ' +
            'and your connected wallet must not sign it either, because that would spend your ' +
            'gas on a call this account was never authorised to make.'
        );
      }

      const account = sessionAddress();

      if (account) {
        const signer = getLocalSigner();
        if (!signer) {
          throw new Error('No account is unlocked, so there is nothing to sign with.');
        }

        // Top up the ACCOUNT before writing. Failing to top up must never block the
        // write — if it genuinely cannot pay, the transaction says so more precisely
        // than a warning could.
        try {
          await ensureGas(signer, account);
        } catch (error) {
          console.warn('[Gas] Top-up failed:', error.message);
        }

        const data = new Interface(ABI).encodeFunctionData(functionName, args);
        const vault = new Contract(account, ACCOUNT_ABI, signer);
        return vault.execute(CONTRACT_ADDRESS, overrides.value ?? 0, data);
      }

      // No account: a persona or a connected wallet, which owns records directly.
      const signer = await getSigner();
      const data = new Interface(ABI).encodeFunctionData(functionName, args);
      return signer.sendTransaction({ to: CONTRACT_ADDRESS, data, ...overrides });
    },
    [getLocalSigner, getSigner]
  );

  /**
   * Simulate a call without spending gas, along the same path `writeAs` would take.
   *
   * The two demo buttons that prove soulbound enforcement and role enforcement both work
   * by CALLING something that should revert. Simulating along the write path is what makes
   * those proofs honest — simulating the other path would prove something about a call the
   * user could never actually make.
   */
  const simulateAs = useCallback(
    async (functionName, args = []) => {
      const account = sessionAddress();
      const data = new Interface(ABI).encodeFunctionData(functionName, args);

      if (account) {
        const signer = getLocalSigner();
        if (!signer) {
          throw new Error('No account is unlocked, so there is nothing to sign with.');
        }
        const vault = new Contract(account, ACCOUNT_ABI, signer);
        return vault.execute.staticCall(CONTRACT_ADDRESS, 0, data);
      }

      const signer = await getSigner();
      const contract = new Contract(CONTRACT_ADDRESS, ABI, signer);
      return contract[functionName].staticCall(...args);
    },
    [getLocalSigner, getSigner]
  );

  /**
   * Sign a plain message with the connected wallet.
   *
   * Used to authorise the off-chain display profile. There is no session and no
   * password, so proving "this is the wallet that owns this address" has to be a
   * signature — which is stronger than a session anyway, since it cannot be
   * replayed to change somebody else's data.
   */
  const signMessage = useCallback(
    async (message) => {
      const signer = await getSigner();
      return signer.signMessage(message);
    },
    [getSigner]
  );

  /**
   * Sign proof that this wallet is the viewer asking for a record.
   *
   * The release endpoint requires it, because a `viewer` in a query string is just
   * a claim. Throws when there is no signer — a demo persona holds no key, so it
   * genuinely cannot prove anything, and the reader says so rather than pretending.
   */
  const signRead = useCallback(
    async (tokenId, viewer) => readProofHeaders(await getSigner(), { tokenId, viewer }),
    [getSigner]
  );

  /** Ask the server for more test ETH. Exposed so a user can press a button for it. */
  const topUpGas = useCallback(async () => {
    const local = getLocalSigner();
    if (!local) throw new Error('Only a wallet created here can be topped up.');
    // The ACCOUNT, not the signing key. The server keys enrolments by the account, funds
    // the account, and the account is what sends transactions; the key holds no records
    // and spends nothing. Omitting it funded the key and then asked to top up an address
    // that was never enrolled, so the button could only ever fail — and `gas.js` states
    // this invariant in its own comment.
    return ensureGas(local, sessionAddress());
  }, []);

  /**
   * Refresh everything that can change when the user switches accounts.
   * Roles come from the contract; "patient" comes from actually owning a token.
   *
   * In demo mode the wallet is absent, so roles come from the backend's
   * chainPermissions (same contract read, no signer) and patient-ness from
   * actual on-chain ownership — the persona's real state, not a flag.
   */
  const refresh = useCallback(
    async (address) => {
      const target = address || accountRef.current;
      if (!target) {
        setRoles({ admin: false, manager: false, auditor: false, hospital: false });
        setIdentity({ label: '', active: false, facility: null });
        setDid('');
        setOwnedRecords([]);
        return;
      }

      setRefreshing(true);
      try {
        const provider = getReadProvider();

        // Demo personas ALWAYS read through the backend, never through an extension.
        //
        // The condition used to be `demoRoleRef.current && !provider`, which meant the
        // demo path was taken only when no wallet was installed. With MetaMask present
        // — which is most machines this gets demoed on — `getReadProvider()` returns a
        // BrowserProvider, so the demo silently fell through to reading the contract
        // through the extension instead.
        //
        // That fails in the worst possible way. `wrongNetwork` is deliberately
        // suppressed in demo mode (`!demoRole && ...`), so when the extension is sat on
        // another chain the contract reads return false for every role and the page
        // reports "this wallet holds no role" — with the wrong-network warning that
        // would have explained it switched off. A demo persona is not a wallet; the
        // extension has nothing to say about it and must not be consulted.
        if (demoRoleRef.current) {
          // Walletless demo: same contract reads, via the backend's own RPC.
          const info = await chainPermissions(target);
          setChainId(CHAIN_ID);
          setReadReady(true);
          setRoles({
            admin: info.roles.admin,
            manager: info.roles.manager,
            auditor: info.roles.auditor,
            hospital: Boolean(info.isFacility),
          });
          setIdentity({
            label: info.identity.label || '',
            active: info.identity.active,
            facility: info.identity.facility && info.identity.facility !== '0x0000000000000000000000000000000000000000' ? info.identity.facility : (info.isFacility ? target : null),
          });
          setDid(info.did || '');
        } else if (provider) {
          const network = await provider.getNetwork();
          setChainId(Number(network.chainId));
          setReadReady(true);

          // Roles: one authoritative source, the contract.
          const contract = await readContract();
          if (contract) {
            const [adminRole, managerRole, auditorRole, hospitalRole] = await Promise.all([
              contract.DEFAULT_ADMIN_ROLE(),
              contract.MANAGER_ROLE(),
              contract.AUDITOR_ROLE(),
              contract.HOSPITAL_ROLE(),
            ]);
            const [isAdmin, isManager, isAuditor, isHospital, record, didString, facilityFlag] =
              await Promise.all([
                contract.hasRole(adminRole, target),
                contract.hasRole(managerRole, target),
                contract.hasRole(auditorRole, target),
                contract.hasRole(hospitalRole, target),
                contract.identities(target),
                contract.didFor(target),
                contract.facilities(target).catch(() => false),
              ]);
            // Labels are off-chain now: the struct is (createdAt, active,
            // facility), so index 0 is a timestamp, not a name. The label comes
            // from the directory (POST /identities), read back joined.
            let label = '';
            try {
              const { chainIdentities } = await import('./services/api');
              const list = await chainIdentities().catch(() => null);
              label =
                list?.identities?.find(
                  (entry) => String(entry.account).toLowerCase() === String(target).toLowerCase()
                )?.label || '';
            } catch {
              /* label is a nicety */
            }
            const facilityAddr = record[2];
            const zero = '0x0000000000000000000000000000000000000000';
            setRoles({ admin: isAdmin, manager: isManager, auditor: isAuditor, hospital: isHospital });
            setIdentity({
              label,
              active: record[1],
              facility:
                facilityAddr && facilityAddr !== zero ? facilityAddr : facilityFlag ? target : null,
            });
            setDid(didString);
          }
        } else {
          // Neither a wallet nor a demo persona can resolve this address.
          return;
        }

        // The patient role is ownership, not a role grant — so ask the backend.
        try {
          const owned = await recordsByOwner(target);
          setOwnedRecords(owned.records || []);
        } catch {
          setOwnedRecords([]);
        }
      } catch (error) {
        setWalletError(describeError(error));
      } finally {
        setRefreshing(false);
      }
    },
    [getReadProvider, readContract]
  );

  const readAccounts = useCallback(async () => {
    if (!hasWallet()) return { selected: [], permitted: [] };
    const request = window.ethereum.request.bind(window.ethereum);
    const selected = await request({ method: 'eth_accounts' }).catch(() => []);

    // eth_accounts often reports only the active account. wallet_getPermissions
    // returns every account this site was authorised to use, as a caveat.
    let permitted = [];
    try {
      const permissions = await request({ method: 'wallet_getPermissions' });
      const caveat = permissions?.[0]?.caveats?.find((c) => c.type === 'restrictReturnedAccounts');
      if (caveat?.value) permitted = caveat.value;
    } catch {
      /* not supported — fall back to whatever eth_accounts gave us */
    }
    return { selected, permitted };
  }, []);

  /** Connect (or silently re-attach) and load roles for the active account. */
  const syncAccounts = useCallback(
    async ({ prompt = false } = {}) => {
      if (!hasWallet()) return;
      // A demo persona is not a wallet account, so the extension's account list has
      // nothing to say about it and must not be allowed to overwrite it.
      //
      // This was a real bug: `enterDemo` set the address and kicked off `refresh`,
      // then the mount effect's `syncAccounts` landed a moment later and replaced it
      // with `eth_accounts[0]` — which on a machine with MetaMask holding four
      // accounts is an address the demo was never showing. The user picked "Demo
      // admin" and got "this wallet holds no role" for an address they did not choose.
      // The API answered `admin: true` the whole time.
      //
      // The poll timer below fires every 12s, so this was not a one-off race either:
      // any refresh could re-clobber the demo and bounce them out of the console.
      if (demoRoleRef.current) return;
      try {
        setConnecting(true);
        setWalletError(null);
        const request = window.ethereum.request.bind(window.ethereum);
        if (prompt) await request({ method: 'eth_requestAccounts' });

        const { selected, permitted } = await readAccounts();
        const unique = [...new Set([...selected, ...permitted])];
        setAvailableAccounts(unique);

        const active = selected[0] || unique[0] || null;
        accountRef.current = active;
        setAccount(active);
        await refresh(active);
      } catch (error) {
        const described = describeError(error);
        setWalletError(described);
      } finally {
        setConnecting(false);
        setBootstrapped(true);
      }
    },
    [readAccounts, refresh]
  );

  /**
   * Switch the active wallet. MetaMask will not let a page silently change the
   * selected account, so this asks for the permission set again and, when the
   * user picks a different account, re-reads the chain.
   */
  const requestAccountSwitch = useCallback(
    async (address) => {
      if (!hasWallet() || !isAddress(address)) return;
      try {
        setConnecting(true);
        setWalletError(null);
        await window.ethereum.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }],
        });
        await syncAccounts();
      } catch (error) {
        setWalletError(describeError(error));
      } finally {
        setConnecting(false);
      }
    },
    [syncAccounts]
  );

  const switchNetwork = useCallback(async () => {
    if (!hasWallet()) return;
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
      });
    } catch (error) {
      setWalletError(describeError(error));
    }
  }, []);

  // Demo mode has no wallet to listen to, so the persona is loaded once and the
  // backend is polled for fresh chain state.
  //
  // This deliberately depends on `demoRole` rather than running mount-only:
  // entering a persona from /access happens mid-session, and an effect that never
  // re-runs would leave the console without roles, without ownership, and with no
  // polling to recover.
  useEffect(() => {
    if (!demoRole) return undefined;

    const address = demoAddressFor(demoRole);
    if (address) {
      accountRef.current = address;
      setAccount(address);
      setChainId(CHAIN_ID);
      refresh(address).finally(() => setBootstrapped(true));
    } else {
      setBootstrapped(true);
    }
    const timer = setInterval(() => refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [demoRole, refresh]);

  // Unwrap the stored session once, before anything asks whether one exists. The
  // failure mode this avoids is subtle and looks like a bug elsewhere: without it,
  // a refreshed page briefly reports no session, and any gate that acts on that
  // would bounce the user to /access while their key was about to arrive.
  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((result) => {
        if (cancelled) return;
        const isLockedNow = result?.state === 'locked';
        setLocked(isLockedNow);
        setLockedAddress(isLockedNow ? result.address : null);
      })
      .finally(() => {
        if (!cancelled) setSessionRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A wallet created here needs no extension, so it resolves on its own — on mount
  // if one is already unlocked, and through adoptSession() the moment one is.
  //
  // Gated on `sessionRestored` because the key is no longer stored in the clear: it
  // arrives wrapped, and unwrapping is asynchronous. Checking hasSession() before that
  // finishes would always be false, and the wallet would look signed out on every
  // refresh until something else happened to re-render.
  useEffect(() => {
    if (!sessionRestored) return undefined;
    if (demoRole || !hasSession()) return undefined;

    const address = sessionAddress();
    if (!address) return undefined;

    accountRef.current = address;
    setAccount(address);
    setLocalSession(address);
    setChainId(CHAIN_ID);
    refresh(address).finally(() => setBootstrapped(true));

    const timer = setInterval(() => refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [demoRole, refresh, sessionRestored]);

  /**
   * Take up a wallet that was just created or unlocked.
   *
   * Called by the enrol and unlock screens, which run before there is an account
   * for the rest of the app to read — without this, finishing enrolment would land
   * the user on a console that still believed nobody was signed in.
   */
  const adoptSession = useCallback(
    async (address) => {
      accountRef.current = address;
      setAccount(address);
      setLocalSession(address);
      setChainId(CHAIN_ID);
      setBootstrapped(true);
      await refresh(address);
    },
    [refresh]
  );

  /**
   * Open a locked session with the device secret.
   *
   * This is what stops a returning user typing twenty characters every time: the wallet
   * is already on the device, wrapped, and a fingerprint or the PIN releases it. The
   * recovery code is still underneath for a new device or a wiped profile.
   */
  const unlockDevice = useCallback(
    async ({ pin } = {}) => {
      const result = await unlockSession({ pin });
      setLocked(false);
      setLockedAddress(null);
      if (result?.state === 'unlocked') await adoptSession(result.address);
      return result;
    },
    [adoptSession]
  );

  /**
   * Lock the wallet again. The key is dropped from this tab; the sealed blob on the
   * server is untouched, so the recovery code still opens it.
   */
  const endSession = useCallback(() => {
    clearSession();
    setLocalSession(null);
    setLocked(false);
    setLockedAddress(null);
    accountRef.current = null;
    setAccount(null);
    setRoles({ admin: false, manager: false, auditor: false, hospital: false });
    setIdentity({ label: '', active: false, facility: null });
    setDid('');
    setOwnedRecords([]);
  }, []);

  // With a real wallet: attach on mount, and keep re-reading whenever the world
  // might have moved — account switch, network switch, tab focus, or time passing.
  useEffect(() => {
    if (demoRole || !hasWallet()) return undefined;

    syncAccounts();

    // Drop the cached provider so the next read re-detects the network.
    //
    // `BrowserProvider` caches the chain it saw on first use, so re-reading through the
    // same instance keeps answering with the OLD one. That made the "Wrong network"
    // banner permanent: switching to Base Sepolia in MetaMask left the page insisting the
    // wallet was elsewhere, and telling the user to do the thing they had just done. The
    // poll did not save it either, because it read through the same stale instance.
    //
    // Clearing it is enough — a fresh BrowserProvider calls eth_chainId again.
    const reDetectNetwork = () => {
      providerRef.current = null;
    };

    const onAccountsChanged = () => syncAccounts();
    const onChainChanged = () => {
      reDetectNetwork();
      syncAccounts();
    };
    const onFocus = () => {
      // Also re-detect here: a switch made while the tab was in the background can miss
      // the `chainChanged` event entirely, and focus is when the user comes back to look.
      reDetectNetwork();
      refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reDetectNetwork();
        refresh();
      }
    };

    window.ethereum.on?.('accountsChanged', onAccountsChanged);
    window.ethereum.on?.('chainChanged', onChainChanged);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => refresh(), POLL_MS);

    return () => {
      window.ethereum.removeListener?.('accountsChanged', onAccountsChanged);
      window.ethereum.removeListener?.('chainChanged', onChainChanged);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [demoRole, refresh, syncAccounts]);

  // A patient is not defined by owning a record.
  //
  // Recognising one only through `ownedRecords.length > 0` meant a patient console could
  // not open until something had been minted TO the patient — so a correctly registered
  // patient was refused with "this wallet holds no role here", and the page blamed their
  // registration for it. The evidence was already loaded and simply unused: `identity.active`
  // is true and they hold no staff role. That is what a patient is. Owning a record is a
  // consequence of being one, not the test for it — and it cannot be the test, because a
  // patient has to be able to sign in and see an empty console before anything exists.
  const isStaff = roles.admin || roles.manager || roles.auditor || roles.hospital;
  const isPatient = !isStaff && (identity.active || ownedRecords.length > 0);
  const anyRole = isStaff || isPatient;

  const primaryRole = useMemo(() => {
    if (roles.admin) return 'admin';
    if (roles.hospital) return 'hospital';
    if (roles.manager) return 'doctor';
    if (roles.auditor) return 'auditor';
    if (isPatient) return 'patient';
    return null;
  }, [roles, isPatient]);

  const value = useMemo(
    () => ({
      // wallet
      account,
      availableAccounts,
      chainId,
      wrongNetwork: !demoRole && chainId !== null && chainId !== CHAIN_ID,
      connecting,
      refreshing,
      walletError,
      hasWallet: hasWallet(),
      connect: () => syncAccounts({ prompt: true }),
      requestAccountSwitch,
      switchNetwork,
      refresh,
      // demo walkthrough — a walletless persona, not an account
      demoRole,
      isDemo: Boolean(demoRole),
      demoAddress: demoRole ? demoAddressFor(demoRole) : null,
      enterDemo: async (role) => {
        // Set the ref BEFORE any await. `refresh` reads it to decide which read path
        // to take, and the extension's account list must not overwrite what follows.
        try {
          sessionStorage.setItem(DEMO_KEY, role);
        } catch {
          /* private mode — demo still works for this load */
        }
        setDemoRole(role);
        demoRoleRef.current = role;
        const address = demoAddressFor(role);
        accountRef.current = address;
        setAccount(address);
        setChainId(CHAIN_ID);
        // Roles come back empty until this resolves, so the page must not conclude
        // "no role" in the meantime. `bootstrapped` is what the gate waits on.
        setBootstrapped(false);
        try {
          await refresh(address);
        } finally {
          setBootstrapped(true);
        }
      },
      exitDemo: () => {
        try {
          sessionStorage.removeItem(DEMO_KEY);
        } catch {
          /* ignore */
        }
        setDemoRole(null);
        demoRoleRef.current = null;
        accountRef.current = null;
        setAccount(null);
        setRoles({ admin: false, manager: false, auditor: false, hospital: false });
        setIdentity({ label: '', active: false, facility: null });
        setDid('');
        setOwnedRecords([]);
        setWalletError(null);
      },
      // identity, all read from the chain
      roles,
      identity,
      did,
      ownedRecords,
      isPatient,
      anyRole,
      primaryRole,
      readReady,
      bootstrapped,
      // A wallet created here rather than connected through an extension.
      hasLocalSession: Boolean(localSession),
      adoptSession,
      endSession,
      // A wallet is on this device but the key is still wrapped.
      locked,
      lockedAddress,
      unlockDevice,
      // contract access
      readContract,
      writeAs,
      simulateAs,
      signMessage,
      signRead,
      topUpGas,
    }),
    [
      account,
      availableAccounts,
      chainId,
      connecting,
      demoRole,
      refreshing,
      walletError,
      requestAccountSwitch,
      switchNetwork,
      refresh,
      roles,
      identity,
      did,
      ownedRecords,
      isPatient,
      anyRole,
      primaryRole,
      readReady,
      bootstrapped,
      localSession,
      adoptSession,
      endSession,
      // A wallet is on this device but the key is still wrapped.
      locked,
      lockedAddress,
      unlockDevice,
      getSigner,
      readContract,
      writeAs,
      simulateAs,
      signMessage,
      signRead,
      topUpGas,
    ]
  );

  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

export function useChain() {
  const context = useContext(ChainContext);
  if (!context) throw new Error('useChain must be used inside <ChainProvider>');
  return context;
}

/** Short 0x1234…abcd form. */
export function shortAddress(address) {
  if (!address || typeof address !== 'string') return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function asChecksum(address) {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}
