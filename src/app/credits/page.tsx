import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { imageCredits } from "@/lib/image-credits";

export const metadata: Metadata = {
  title: "Image Credits — CivicFix",
};

export default function CreditsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">Image Credits</h1>
      <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
        Every photograph used on CivicFix is a real, freely-licensed civic photo sourced from
        Wikimedia Commons. Attribution below satisfies the CC BY / CC BY-SA license terms these
        were published under.
      </p>

      <ul className="mt-8 flex flex-col divide-y divide-border rounded-2xl border border-border bg-white">
        {imageCredits.map((credit) => (
          <li key={credit.file} className="flex flex-col gap-1 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-foreground">{credit.title}</p>
              <p className="text-xs text-foreground-muted">
                {credit.author} &middot; {credit.license}
              </p>
            </div>
            <a
              href={credit.source}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-civic-700 hover:underline"
            >
              View source ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
