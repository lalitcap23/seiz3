"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { NotificationSync } from "@/components/Notifications";
import { WalletProvider } from "@/lib/wallet";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 1_000 } } }),
  );
  // the wallet lives above every page: the top bar's notifications follow it on the dashboard too
  return (
    <QueryClientProvider client={client}>
      <WalletProvider>
        <NotificationSync />
        {children}
      </WalletProvider>
    </QueryClientProvider>
  );
}
