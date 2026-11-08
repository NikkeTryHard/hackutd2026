import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import ThemeToggle from './theme-toggle';
import '@calcom/cal-sans-ui/ui.css';
import '../src/styles.css';

export const metadata: Metadata = {
  title: 'Sightline · UI/UX for the people, by the people',
  description:
    'See your interface from a different point of view. Visual agents explore controlled browser journeys and record evidence you can inspect.',
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f8f9fa',
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('sightline-theme');document.documentElement.dataset.theme=t==='light'?'light':'dark'}catch{document.documentElement.dataset.theme='dark'}`,
          }}
        />
      </head>
      <body>
        <ThemeToggle />
        {children}
      </body>
    </html>
  );
}
