import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Riff Sketchbook",
    template: "%s · Riff Sketchbook",
  },
  description: "기타 리프를 녹음하고, 테이크를 고르고, 앨범처럼 정리하는 개인 스케치북",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
