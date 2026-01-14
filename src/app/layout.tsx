import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Impostor Mobile",
  description: "Mini jogo de impostor para jogar com amigos no celular.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
