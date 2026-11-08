'use client';

import { useEffect, useState, type ReactNode } from 'react';

export default function LandingNav({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <header className="landing-nav" data-scrolled={scrolled}>
      {children}
    </header>
  );
}
