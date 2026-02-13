"use client";

import { Header } from "./Header";

interface GameLayoutProps {
  chatPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  scoreOverlay?: React.ReactNode;
}

export function GameLayout({
  chatPanel,
  rightPanel,
  scoreOverlay,
}: GameLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <Header />
      <div className="flex-1 grid grid-cols-[2fr_3fr] grid-rows-[1fr] min-h-0 overflow-hidden">
        <div className="overflow-hidden">{chatPanel}</div>
        <div className="overflow-hidden">{rightPanel}</div>
      </div>
      {scoreOverlay}
    </div>
  );
}
