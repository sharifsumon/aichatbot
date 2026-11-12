/** Line icons from the approved sidebar design. */
import type { ReactNode } from 'react';

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  logo: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  ),
  dashboard: () => (
    <Svg>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  ),
  inbox: () => (
    <Svg>
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M5 5h14l2 8v6H3v-6z" />
    </Svg>
  ),
  agent: () => (
    <Svg>
      <path d="M4 5h16v11H8l-4 4z" />
    </Svg>
  ),
  orders: () => (
    <Svg>
      <path d="M3 4h2l2.5 11h11L21 7H6.2" />
      <circle cx="9" cy="19.5" r="1.5" />
      <circle cx="17" cy="19.5" r="1.5" />
    </Svg>
  ),
  catalog: () => (
    <Svg>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M9 11h7M9 15h7" />
    </Svg>
  ),
  models: () => (
    <Svg>
      <circle cx="12" cy="5" r="2.5" />
      <path d="M8 21l1.5-9L7 9.5 9.5 8h5L17 9.5 14.5 12 16 21z" />
    </Svg>
  ),
  images: () => (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-9 9" />
    </Svg>
  ),
  sparkle: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  ),
  play: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 4l14 8-14 8z" />
    </svg>
  ),
  video: () => (
    <Svg>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </Svg>
  ),
  comments: () => (
    <Svg>
      <path d="M4 5h16v10H10l-5 4v-4H4z" />
      <path d="M8 9h8M8 12h5" />
    </Svg>
  ),
  knowledge: () => (
    <Svg>
      <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" />
      <path d="M4 19V5M9 7h6" />
    </Svg>
  ),
  activity: () => (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  ),
  settings: () => (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </Svg>
  ),
  bot: () => (
    <Svg>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12h.01M15 12h.01" />
    </Svg>
  ),
  logout: () => (
    <Svg>
      <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
    </Svg>
  ),
  menu: () => (
    <Svg size={20}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  ),
  send: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 12l16-8-6 16-2-7z" />
    </svg>
  ),
  post: () => (
    <Svg size={22}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15l5-5 4 4 3-3 6 6" />
    </Svg>
  ),
};
