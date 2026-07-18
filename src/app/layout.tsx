import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter, JetBrains_Mono, Oswald } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { MenuScreenReaderLiveRegion } from "@/components/uiux/MenuScreenReader";
import { applyBootDataAttributes } from "@/lib/game/uiux/boot-attributes";
import { AgeGateOverlay } from "@/components/uiux/AgeGateOverlay";
import { PwaBoot } from "@/components/uiux/PwaBoot";
import { FirebaseBoot } from "@/components/uiux/FirebaseBoot";

// Inter — the closest free alternative to Apple SF Pro Display.
// Variable font with full weight range (100-900) for premium typography.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
});

// Oswald — condensed geometric sans for the tactical wordmark + headlines.
// Chosen with intent: condensed military stencil-adjacent feel reads as
// "tactical operator sim," not generic SaaS. Paired with Inter (body) and
// JetBrains Mono (HUD numerics) — one identity across menu and HUD.
const oswald = Oswald({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// JetBrains Mono — for tabular numerics in HUD/stats (Apple SF Mono alternative).
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Project Reality — Browser FPS",
  description: "Project Reality: a photoreal tactical FPS built for the browser. Six waves, one operator.",
  keywords: ["FPS", "CS2", "browser game", "Three.js", "tactical shooter", "Project Reality"],
  authors: [{ name: "Project Reality" }],
  icons: {
    icon: "/logo.svg",
  },
  // Prompt #111 — PWA manifest. Lets players "Install app" / "Add to Home
  // Screen" so Project Reality boots in a clean fullscreen Chrome window
  // without URL bar / browser chrome. Paired with the theme-color viewport
  // export below so the OS taskbar / recent-apps card matches the in-game
  // dark UI. (Next.js 16 moved themeColor out of `metadata` into the
  // dedicated `viewport` export — see generateViewport below.)
  manifest: "/manifest.json",
  openGraph: {
    title: "Project Reality",
    description: "A photoreal tactical FPS in your browser.",
    url: "https://chat.z.ai",
    siteName: "Project Reality",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Project Reality",
    description: "A photoreal tactical FPS in your browser.",
  },
};

export const viewport: Viewport = {
  // Prompt #111 — theme-color for the OS chrome (Android status bar,
  // iOS PWA status bar, macOS Safari tint). Matches the in-game near-black
  // background (#08090c) so the install / fullscreen transition is seamless.
  themeColor: "#08090c",
  // FPS wants every pixel — lock to landscape so the device doesn't rotate
  // mid-firefight on tablets. Paired with the manifest's `orientation:
  // "landscape"` for installed-PWA launches.
  width: "device-width",
  initialScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Prompt I-977 + I-976 — apply boot-time data-attributes on <html>
  // (reduced-motion, colorblind mode) so the first paint already has
  // the right CSS selectors active. The SettingsPanel updates these
  // live as the player changes settings.
  applyBootDataAttributes();
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${oswald.variable} ${jetbrainsMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
        <SonnerToaster position="top-center" richColors closeButton />
        {/* Prompt I-976 — Screen reader live region for menus.
            Announces phase changes + major UI transitions to assistive
            tech. The region is polite (doesn't interrupt) + atomic
            (announced as a whole). */}
        <MenuScreenReaderLiveRegion />
        {/* Prompt I-983 — Age gate enforcement (first-launch modal). */}
        <AgeGateOverlay />
        {/* Prompt I-979/I-985/I-986 — PWA: service worker registration
            + OTA update toasts + install prompt listener. */}
        <PwaBoot />
        {/* Firebase SDK — loads the modular Firebase JS SDK from gstatic
            CDN, then initializes the app via FirebaseBoot. The config is
            safe to expose (Firebase web config is not a secret; security
            is enforced by Firestore Security Rules + Firebase Auth). */}
        <FirebaseBoot />
      </body>
    </html>
  );
}
