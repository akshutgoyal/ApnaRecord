import React from 'react';

// The wordmark. One mark, one spelling, everywhere — a rebrand that lives in
// twenty places is a rebrand that drifts.
//
// The mark is a shield holding a heartbeat trace: protection plus health, drawn
// as geometry rather than a religious or national symbol. The Devanagari line is
// the one deliberate nod to where this product is from, and it is set small and
// quiet next to the Latin name.

export function Logomark({ className = 'h-8 w-8', tone = 'peacock' }) {
  const bg = tone === 'ink' ? '#0E6E62' : '#0E6E62';
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" role="presentation">
      <rect width="32" height="32" rx="9" fill={bg} />
      {/* shield */}
      <path
        d="M16 6.5l7 2.4v6.3c0 4.3-2.9 8.1-7 9.3-4.1-1.2-7-5-7-9.3V8.9l7-2.4z"
        fill="none"
        stroke="#F5EFE2"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* heartbeat, drawn through the shield */}
      <path
        d="M9.6 16.2h3.1l1.5-2.9 2.3 5.4 1.6-2.5h4.2"
        fill="none"
        stroke="#D99A00"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The wordmark lockup.
 * `devanagari` adds the quiet second line; use it on the landing page and in the
 * app sidebar footer, not in tight chrome.
 */
export default function Brand({ size = 'md', tone = 'light', devanagari = false, className = '' }) {
  const sizes = {
    sm: { mark: 'h-7 w-7', text: 'text-[15px]' },
    md: { mark: 'h-8 w-8', text: 'text-[17px]' },
    lg: { mark: 'h-10 w-10', text: 'text-xl' },
  }[size];

  const text = tone === 'dark' ? 'text-ink' : 'text-parchment';

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Logomark className={sizes.mark} />
      <span className="min-w-0">
        <span className={`font-display block font-bold leading-none tracking-tight ${sizes.text} ${text}`}>
          ApnaRecord
        </span>
        {devanagari && (
          <span className="font-deva mt-1 block text-[11px] leading-none text-parchment/45">
            अपना रिकॉर्ड
          </span>
        )}
      </span>
    </span>
  );
}
