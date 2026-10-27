import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuthFrame } from "@/client/components/auth-frame";
import { Button } from "@/client/components/ui/button";
import { Card, ErrorText } from "@/client/components/ui/card";
import { Field, Input } from "@/client/components/ui/input";
import { api, errorText } from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import { PASSWORD_MIN } from "@/shared/schemas";

export function AcceptInvitePage() {
  const { token } = useParams({ from: "/invite/$token" });
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<{ email: string; name: string; tenantName: string }>(`/api/invites/${token}`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api<{ email: string }>("/api/invites/accept", { json: { token, password } }),
    onSuccess: () => navigate({ to: "/login", search: { activated: true } }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setMismatch(password !== confirm);
    if (password === confirm) accept.mutate();
  }

  return (
    <AuthFrame>
      <Card>
        {invite.isPending ? (
          <p className="text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : invite.isError ? (
          <div className="grid gap-4">
            <ErrorText>{errorText(invite.error)}</ErrorText>
            <Link to="/login" className="text-sm font-medium text-link underline">
              {vi.invite.toLogin}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <h1 className="text-lg font-semibold text-nav">{vi.invite.title}</h1>
            <p className="text-sm text-muted-foreground">{vi.invite.welcome(invite.data.name, invite.data.tenantName)}</p>
            <Field label={vi.login.email} htmlFor="email">
              <Input id="email" type="email" autoComplete="username" readOnly value={invite.data.email} />
            </Field>
            <Field label={vi.invite.password} htmlFor="password" hint={vi.invite.passwordHint(PASSWORD_MIN)}>
              <Input id="password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label={vi.invite.confirm} htmlFor="confirm">
              <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <ErrorText>{mismatch ? vi.invite.mismatch : accept.isError ? errorText(accept.error) : null}</ErrorText>
            <Button type="submit" disabled={accept.isPending}>
              {vi.invite.submit}
            </Button>
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}
