/**
 * Shell: fonts, the fixed top bar, and the mobile gate.
 *
 * The type pairing is the spec's (§4): Inter for interface, IBM Plex Mono for
 * anything numeric, hash-like or machine-readable. Both are loaded through
 * next/font, which self-hosts them at build time — no render-blocking request to
 * a font CDN, and no layout shift from a late swap.
 *
 * The wordmark and the stamp are the only uppercase text in the product, which
 * is why the wordmark is written as a literal here rather than through a class.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';
import { MobileNotice } from '@/components/MobileNotice';
import { NavBar } from '@/components/NavBar';
import { API_BASE_URL } from '@/lib/api';
import { TAGLINE } from '@/lib/copy';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  weight: ['400'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Factor Prover',
  description: TAGLINE,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <body>
        {/*
          Below 768px this product shows a message instead of a compromised
          layout (spec §10). The gate is applied with CSS rather than by
          measuring the viewport in JS, so there is no flash of the desktop
          layout on a phone and no hydration mismatch on a resize.
        */}
        <div className="md:hidden">
          <MobileNotice />
        </div>

        <div className="hidden md:block">
          <NavBar />
          <main className="mx-auto w-full max-w-[1280px] px-8 pb-16 pt-6">{children}</main>
          {/*
            The API host is printed rather than hidden. If a reader is looking at
            an empty page, the first question is which backend it asked, and the
            answer should not require opening the console.
          */}
          <footer className="mx-auto w-full max-w-[1280px] border-t border-rule px-8 py-4">
            <p className="font-mono text-caption text-ink-light">
              agent API: {API_BASE_URL}
            </p>
            <p className="mt-1 max-w-[80ch] text-caption text-ink-light">{TAGLINE}</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
