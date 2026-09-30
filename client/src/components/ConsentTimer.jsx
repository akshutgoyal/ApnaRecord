import React, { useEffect, useState } from 'react';

// A live countdown against the on-chain expiry.
//
// This is the one place marigold is used for *meaning* rather than ornament: a
// window that is running out is the definition of "time-bound / attention". When
// it reaches zero the contract stops authorising the read, so the countdown is
// not a UI convention — it is a mirror of chain state.

function remaining(expiresAtSeconds) {
  if (!expiresAtSeconds) return null;
  const ms = expiresAtSeconds * 1000 - Date.now();
  if (ms <= 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function absolute(expiresAtSeconds) {
  return new Date(expiresAtSeconds * 1000).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ConsentTimer({ expiresAt, label = 'Consent', showAbsolute = true }) {
  const [text, setText] = useState(() => remaining(expiresAt));

  useEffect(() => {
    setText(remaining(expiresAt));
    const timer = setInterval(() => setText(remaining(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return <span className="status-expired">○ {label}: none</span>;
  if (!text) return <span className="status-expired">○ {label}: expired</span>;

  return (
    <span className="status-expiring" title={`Expires ${absolute(expiresAt)} — enforced by the contract`}>
      <span aria-hidden="true" className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-marigold-400" />
      {label} {text}
      {showAbsolute && <span className="font-normal opacity-70">· until {absolute(expiresAt)}</span>}
    </span>
  );
}
