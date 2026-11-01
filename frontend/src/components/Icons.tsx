// Outline icons for navigation (24x24, color from currentColor)
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const IconLogo = () => (
  <svg viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="var(--accent)" />
    <circle cx="16" cy="16" r="8" fill="none" stroke="#fff" strokeWidth="3" />
    <circle cx="16" cy="16" r="2.5" fill="#fff" />
  </svg>
);
export const IconLibrary = () => (
  <svg {...base}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const IconStats = () => (
  <svg {...base}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
);
export const IconFilm = () => (
  <svg {...base}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></svg>
);
export const IconGrenade = () => (
  <svg {...base}><circle cx="11" cy="14" r="6" /><path d="M11 8V5h4M15 5l3-2M9 14h4" /></svg>
);
