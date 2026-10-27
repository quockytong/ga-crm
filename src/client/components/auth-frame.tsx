import type { ReactNode } from "react";
import { FutureLine, Logo } from "@/client/components/brand/dlvn-brand";
import { vi } from "@/i18n/vi";

/** Frame of the signed-out pages: the FutureLine strip, the DLVN logo and the app name. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <FutureLine style={{ width: "100%" }} />
      <div className="mx-auto grid w-full max-w-sm flex-1 content-center gap-5 px-4 py-8">
        <div className="grid justify-items-center gap-3 text-center">
          <Logo state="logo dlvn" />
          <div>
            <p className="text-lg font-semibold text-nav">{vi.appName}</p>
            <p className="text-sm text-muted-foreground">{vi.login.subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
