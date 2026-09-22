/**
 * Why the result above can be trusted (brief §40).
 *
 * Three claims, and each one is a property of the code rather than a promise
 * about the team. That is the only kind of trust line this project is entitled
 * to make, and it is why the copy is narrow: "fixed rules before results",
 * "frozen data", "tamper-evident record" are all things a reader can check.
 *
 * §40's own closing note is the one that governs the third column: do not claim
 * immutability when the implementation provides tamper DETECTION. The log is a
 * hash chain that a verifier re-reads; it can be edited by anyone with write
 * access to the file, and the edit becomes visible rather than impossible. So
 * the word is "tamper-evident" here and everywhere else in this product.
 *
 * The destinations are all real. Two of the three land on the provenance panel,
 * which is not laziness: the gate policy hash and the dataset hash are printed
 * in that one panel, so it is genuinely where both the protocol and the data
 * details live. The third goes to the evidence screen, which is the record
 * itself. No link here points at a page that does not show what the link
 * promises — the failure mode a trust section is least able to survive.
 */

import Link from 'next/link';
import { Database, FileCheck, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';

interface Claim {
  icon: ReactNode;
  title: string;
  body: string;
  href: string;
  cta: string;
}

const CLAIMS: Claim[] = [
  {
    icon: <LockKeyhole size={20} aria-hidden />,
    title: 'Fixed rules before results',
    body: 'The pass/fail rules are written before the session runs, so the bar cannot be moved after seeing the result.',
    href: '#provenance',
    cta: 'See the protocol',
  },
  {
    icon: <Database size={20} aria-hidden />,
    title: 'Frozen data',
    body: 'The test uses pinned data so the same result can be reproduced later.',
    href: '#provenance',
    cta: 'View data details',
  },
  {
    /*
     * `FileCheck`, not the `FileCheck2` the brief specifies (§40). The numbered
     * variants (`FileCheck2`, `AlertCircle`, the whole `*2` family) were removed
     * in lucide's 1.0 rename, and this project is on 1.47.0 — `FileCheck2` does
     * not exist in the installed package and importing it fails the build. The
     * same family also supplies `FileCheckCorner`; plain `FileCheck` is the
     * closer match for "a record that has been checked".
     */
    icon: <FileCheck size={20} aria-hidden />,
    title: 'Tamper-evident record',
    body: 'Every decision is chained to the one before it. Change a recorded entry and verification catches it.',
    href: '/log',
    cta: 'Explore evidence',
  },
];

export function TrustSection() {
  return (
    <section aria-label="Why these results can be checked" className="border-y border-rule py-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {CLAIMS.map((claim) => (
          <div key={claim.title} className="flex flex-col gap-2">
            <span className="text-ink">{claim.icon}</span>
            <h3 className="text-h3 font-semibold text-ink">{claim.title}</h3>
            <p className="max-w-[46ch] flex-1 text-label text-ink-light">{claim.body}</p>
            <Link href={claim.href} className="text-label text-ink">
              {claim.cta} →
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
