import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1280px' },
    },
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        surface: 'hsl(var(--surface))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        success: { DEFAULT: 'hsl(var(--success))', foreground: '#ffffff' },
        warning: { DEFAULT: 'hsl(var(--warning))', foreground: '#ffffff' },
        danger: { DEFAULT: 'hsl(var(--danger))', foreground: '#ffffff' },
        destructive: {
          DEFAULT: 'hsl(var(--danger))',
          foreground: '#ffffff',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: '14px', // cards
        md: '9px', // buttons
        sm: '7px', // inputs
      },
      boxShadow: {
        card: '0 2px 8px rgba(16,35,75,0.025), 0 1px 2px rgba(16,35,75,0.025)',
        'card-hover': '0 4px 16px rgba(17,24,39,0.08), 0 1px 3px rgba(17,24,39,0.06)',
        popover: '0 12px 32px rgba(17,24,39,0.14), 0 2px 8px rgba(17,24,39,0.08)',
        nav: '4px 0 24px rgba(17,24,39,0.10)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      fontSize: {
        caption: '12px',
        body: '14px',
        label: '16px',
        'card-title': '20px',
        'page-heading': '24px',
        kpi: '32px',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        // UPI-app-style success tick: the circle pops in with a slight overshoot,
        // then the check stroke draws itself in — see order-success-check.tsx.
        'pop-in': {
          '0%': { transform: 'scale(0)', opacity: '0' },
          '60%': { transform: 'scale(1.15)', opacity: '1' },
          '100%': { transform: 'scale(1)' },
        },
        'check-draw': { from: { strokeDashoffset: '100' }, to: { strokeDashoffset: '0' } },
      },
      animation: {
        'pop-in': 'pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
        'check-draw': 'check-draw 0.35s 0.25s cubic-bezier(0.65, 0, 0.35, 1) forwards',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
