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
export const IconScout = () => (
  <svg {...base}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5M11 8v6M8 11h6" /></svg>
);
export const IconUs = () => (
  <svg {...base}><path d="M12 3l8 3v6c0 4.5-3.3 7.8-8 9-4.7-1.2-8-4.5-8-9V6z" /></svg>
);
export const IconMap = () => (
  <svg {...base}><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5zM9 4v13.5M15 6.5V20" /></svg>
);
export const IconStar = () => (
  <svg {...base}><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.5-4.2 6.1-.8z" /></svg>
);
