"use client";

import { OverlayProvider } from "overlay-kit";

import { Toaster } from "@/shared/ui/sonner";

type AppProvidersProps = {
  children: React.ReactNode;
};

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <OverlayProvider>
      {children}
      <Toaster />
    </OverlayProvider>
  );
}
