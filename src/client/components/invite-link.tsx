import { useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Card, CardTitle } from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { formatDateTime, type InviteLink } from "@/client/lib/api";
import { vi } from "@/i18n/vi";

/** Shows a freshly created invite link once, to be copied and sent by hand. */
export function InviteLinkCard({ email, link, onClose }: { email: string; link: InviteLink; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card className="grid gap-3 bg-highlight shadow-ring-highlight">
      <CardTitle>{vi.users.inviteLinkTitle(email)}</CardTitle>
      <p className="text-sm text-muted-foreground">{vi.users.inviteLinkHelp}</p>
      <div className="flex gap-2">
        <Input readOnly value={link.inviteUrl} onFocus={(e) => e.currentTarget.select()} aria-label={vi.users.inviteLinkTitle(email)} />
        <Button
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(link.inviteUrl);
            setCopied(true);
          }}
        >
          {copied ? vi.common.copied : vi.common.copy}
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{vi.users.inviteExpires(formatDateTime(link.inviteExpiresAt) ?? "")}</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {vi.common.close}
        </Button>
      </div>
    </Card>
  );
}
