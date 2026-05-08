import type { Metadata } from "next";
import { connection } from "next/server";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import {
  readFrontendSentryRuntimeConfig,
  serializeFrontendSentryRuntimeConfig,
} from "@/lib/telemetry/bootstrap-config";
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
  title: "SRE Simulator",
  description: "The Break-Fix Game for Azure Red Hat OpenShift",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await connection();
  const sentryConfig = readFrontendSentryRuntimeConfig(process.env);

  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Script
          id="sentry-browser-runtime-config"
          strategy="beforeInteractive"
        >
          {serializeFrontendSentryRuntimeConfig(sentryConfig)}
        </Script>
        {children}
      </body>
    </html>
  );
}
