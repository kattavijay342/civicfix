import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { getSessionProfile, createClient } from "@/lib/supabase/server";
import { getUnreadNotificationCount } from "@/lib/data/notifications";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CivicFix – AI-Powered Civic Issue Management",
  description:
    "CivicFix is an AI-powered civic issue reporting, routing, monitoring, and follow-up platform. Report a problem, let AI understand and route it to the right department, and track progress until resolution.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getSessionProfile();
  const unreadCount = session
    ? await getUnreadNotificationCount(await createClient(), session.user.id)
    : 0;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-civic-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
        >
          Skip to content
        </a>
        <Navbar profile={session?.profile ?? null} unreadCount={unreadCount} />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
