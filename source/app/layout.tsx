import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zsyh PDF Quiz Bot",
  description: "PDF to native Telegram quiz service",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
