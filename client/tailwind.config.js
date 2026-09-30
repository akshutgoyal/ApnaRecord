/** @type {import('tailwindcss').Config} */

// ApnaRecord design tokens — "Peacock + Marigold".
//
// Warm, institutional, distinctly Indian without being loud. Two shells:
//
//   INK SHELL   — the public site.   ink #0C2431 surface, parchment text.
//   PAPER SHELL — every dashboard.   paper #FAF6EE surface, ink text.
//
// Colour budget: peacock is the action colour; marigold is at most ~10% of any
// screen and means exactly one thing — *time-bound / attention* (a consent
// window closing, a live dot, a pending confirmation). Marigold must never mean
// "error" and never mean "primary".
//
// Legacy ramps are remapped rather than renamed, so the ~20 existing screens
// moved onto the palette in one step and cannot drift:
//
//   slate   -> warm ink-tinted neutral ("the app's only grey")
//   teal    -> peacock
//   emerald -> success
//   amber   -> warn  (distinct from the marigold accent on purpose)
//   rose    -> error
//
// New code should prefer the explicit brand names (ink / paper / peacock /
// marigold / success / warn / error) so intent is readable at a glance.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Avenir', 'Helvetica', 'Arial', 'sans-serif'],
        display: ['Anek Latin', 'Inter', 'system-ui', 'sans-serif'],
        deva: ['Mukta', 'Anek Devanagari', 'Noto Sans Devanagari', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // ---- brand -------------------------------------------------------
        ink: {
          DEFAULT: '#0C2431',
          950: '#081A25',
          900: '#0C2431',
          800: '#11313F',
          700: '#1A4252',
          600: '#265264',
        },
        paper: '#FAF6EE',
        parchment: '#F5EFE2',
        peacock: {
          DEFAULT: '#0E6E62',
          50: '#E7F1EF',
          100: '#CFE4E1',
          200: '#A8CFC9',
          300: '#6FB0A7',
          400: '#2E8B7C',
          500: '#12806F',
          600: '#0E6E62',
          700: '#0B5A50',
          800: '#08443C',
          900: '#06332D',
        },
        marigold: {
          DEFAULT: '#D99A00',
          50: '#FDF6E3',
          100: '#FAE9BE',
          200: '#F2D488',
          300: '#E6B840',
          400: '#D99A00',
          600: '#B27F00',
          // Text-safe on paper (marigold itself is ~2.3:1 there, which fails AA).
          700: '#8A6200',
        },
        success: {
          DEFAULT: '#15803D',
          50: '#ECFDF3',
          100: '#D1FADF',
          200: '#A6F4C5',
          600: '#15803D',
          700: '#0F5C2E',
        },
        warn: {
          DEFAULT: '#B45309',
          50: '#FDF4EA',
          100: '#F9E4CE',
          200: '#F0C79B',
          600: '#B45309',
          700: '#8A3F07',
        },
        error: {
          DEFAULT: '#B42318',
          50: '#FEF3F2',
          100: '#FEE4E2',
          200: '#FCC9C5',
          600: '#B42318',
          700: '#912018',
        },
        // Warm hairline, tinted rather than grey — the border that makes paper
        // read as paper.
        line: 'rgba(12,36,49,0.10)',
        'line-strong': 'rgba(12,36,49,0.18)',
        'line-dark': 'rgba(245,239,226,0.14)',

        // ---- remapped legacy ramps --------------------------------------
        slate: {
          50: '#F7F3EA',
          100: '#F1EADC',
          200: '#E4DAC7',
          300: '#CFC3AB',
          400: '#A79C88',
          500: '#7D7466',
          600: '#5E574C',
          700: '#463F36',
          800: '#2E2A24',
          900: '#1C2A31',
        },
        teal: {
          50: '#E7F1EF',
          100: '#CFE4E1',
          200: '#A8CFC9',
          300: '#6FB0A7',
          400: '#2E8B7C',
          500: '#12806F',
          600: '#0E6E62',
          700: '#0B5A50',
          800: '#08443C',
          900: '#06332D',
        },
        emerald: {
          50: '#ECFDF3',
          100: '#D1FADF',
          200: '#A6F4C5',
          300: '#6CE9A6',
          400: '#32D583',
          500: '#12B76A',
          600: '#15803D',
          700: '#0F5C2E',
          800: '#0B4726',
        },
        amber: {
          50: '#FDF4EA',
          100: '#F9E4CE',
          200: '#F0C79B',
          300: '#E3A863',
          400: '#CE8434',
          500: '#B45309',
          600: '#9A4708',
          700: '#8A3F07',
          800: '#6B3106',
        },
        rose: {
          50: '#FEF3F2',
          100: '#FEE4E2',
          200: '#FCC9C5',
          300: '#F7A9A2',
          400: '#E4685C',
          500: '#C93C2E',
          600: '#B42318',
          700: '#912018',
          800: '#7A1C14',
        },
      },
      borderRadius: {
        institutional: '0.25rem',
      },
      boxShadow: {
        // Warm, low-contrast elevation. Shadows are ink-tinted, never pure black.
        card: '0 1px 2px rgba(12,36,49,0.04), 0 1px 3px rgba(12,36,49,0.06)',
        raised: '0 4px 16px rgba(12,36,49,0.08)',
        overlay: '0 16px 48px rgba(12,36,49,0.18)',
        sticker: '4px 4px 0 0 rgba(12,36,49,0.9)',
        'sticker-sm': '2.5px 2.5px 0 0 rgba(12,36,49,0.9)',
        // Kept for the landing page's die-cut panels.
        legend: '6px 6px 0 0 rgba(12,36,49,0.10)',
      },
    },
  },
  plugins: [],
};
