import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuthFrame } from "@/client/components/auth-frame";
import { Button } from "@/client/components/ui/button";
import { Card, ErrorText } from "@/client/components/ui/card";
import { Field, Input } from "@/client/components/ui/input";
import { vi } from "@/i18n/vi";

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activated } = useSearch({ from: "/login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      if (!res.ok) {
        setError(res.status >= 500 ? vi.errors.internal! : vi.errors.invalid_credentials!);
        return;
      }
      queryClient.clear();
      await navigate({ to: "/" });
    } catch {
      setError(vi.errors.network!);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      <Card>
        <form onSubmit={submit} className="grid gap-4">
          <h1 className="text-lg font-semibold text-nav">{vi.login.title}</h1>
          {activated && <p className="rounded-md bg-blue-20 p-3 text-sm text-success">{vi.login.activated}</p>}
          <Field label={vi.login.email} htmlFor="email">
            <Input id="email" type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={vi.login.password} htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy}>
            {busy ? vi.login.submitting : vi.login.submit}
          </Button>
        </form>
      </Card>
      <p className="text-center text-xs text-muted-foreground">{vi.login.noAccount}</p>
    </AuthFrame>
  );
}
