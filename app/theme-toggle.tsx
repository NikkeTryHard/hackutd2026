'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

const storageKey = 'sightline-theme';

export default function ThemeToggle({ inline = false }: { inline?: boolean }) {
  const pathname = usePathname();
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const update = () => setDark(document.documentElement.dataset.theme === 'dark');
    update();
    window.addEventListener('sightline-theme-change', update);
    return () => window.removeEventListener('sightline-theme-change', update);
  }, []);
  if (
    !inline &&
    (pathname === '/' || pathname.startsWith('/dashboard') || pathname.startsWith('/agent/'))
  )
    return null;
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      className={inline ? 'sl-theme-toggle landing-theme-toggle' : 'sl-theme-toggle'}
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = !dark;
        const theme = next ? 'dark' : 'light';
        localStorage.setItem(storageKey, theme);
        document.documentElement.dataset.theme = theme;
        setDark(next);
      }}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
          </>
        ) : (
          <path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z" />
        )}
      </svg>
    </button>
  );
}
