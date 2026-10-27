import { keepPreviousData, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { InviteLinkCard } from "@/client/components/invite-link";
import { RolePicker } from "@/client/components/role-picker";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, PageTitle } from "@/client/components/ui/card";
import { Field, Input } from "@/client/components/ui/input";
import { api, errorText, formatDateTime, meQuery, usersQuery, type InviteLink, type User } from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import { AGENT_ROLES, type Role } from "@/shared/enums";

const statusTone = { ACTIVE: "success", INVITED: "warning", DISABLED: "destructive" } as const;
const needsAgentCode = (roles: Role[]) => roles.some((r) => (AGENT_ROLES as readonly Role[]).includes(r));

type ShownLink = { email: string; link: InviteLink };

export function UsersPage() {
  const { data: me } = useSuspenseQuery(meQuery);
  const isHead = me.roles.includes("GA_HEAD");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownLink | null>(null);
  const users = useQuery({ ...usersQuery(page, q), placeholderData: keepPreviousData });
  const pages = users.data ? Math.max(1, Math.ceil(users.data.total / users.data.pageSize)) : 1;

  return (
    <>
      <PageTitle actions={!inviting && <Button onClick={() => setInviting(true)}>{vi.users.inviteButton}</Button>}>{vi.users.title}</PageTitle>

      {shown && <InviteLinkCard email={shown.email} link={shown.link} onClose={() => setShown(null)} />}
      {inviting && (
        <InviteForm
          canGrantHead={isHead}
          onCancel={() => setInviting(false)}
          onDone={(link) => {
            setInviting(false);
            setShown(link);
          }}
        />
      )}

      <Input
        type="search"
        placeholder={vi.users.searchPlaceholder}
        aria-label={vi.common.search}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />

      <Card className="overflow-x-auto p-0 sm:p-0">
        {users.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : users.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(users.error)}</ErrorText>
          </div>
        ) : users.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.users.empty}</p>
        ) : (
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{vi.users.name}</th>
                <th className="px-4 py-2.5 font-medium">{vi.users.roles}</th>
                <th className="px-4 py-2.5 font-medium">{vi.users.agentCode}</th>
                <th className="px-4 py-2.5 font-medium">{vi.users.status}</th>
                <th className="px-4 py-2.5 font-medium">{vi.users.lastLogin}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.data.items.map((u) =>
                editing === u.id ? (
                  <tr key={u.id}>
                    <td colSpan={6} className="bg-muted/50 p-4">
                      <EditForm user={u} isSelf={u.id === me.user.id} canGrantHead={isHead} onClose={() => setEditing(null)} onLink={setShown} />
                    </td>
                  </tr>
                ) : (
                  <tr key={u.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <Badge key={r}>{vi.roles[r]}</Badge>
                        ))}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {u.agentCode ? (
                        <>
                          <p className="font-mono">{u.agentCode}</p>
                          <p className="text-xs text-muted-foreground">{u.agentName ?? vi.users.notInTree}</p>
                        </>
                      ) : (
                        vi.common.none
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone[u.status]}>{vi.userStatus[u.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(u.lastLoginAt) ?? vi.users.never}</td>
                    <td className="px-4 py-3 text-right">
                      {/* GA Head accounts are managed by GA Heads only. */}
                      {(isHead || !u.roles.includes("GA_HEAD")) && (
                        <Button variant="outline" size="sm" onClick={() => setEditing(u.id)}>
                          {vi.common.edit}
                        </Button>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </Card>

      {users.data && users.data.total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{vi.common.total(users.data.total)}</span>
          <span className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {vi.common.prev}
            </Button>
            {vi.common.pageOf(page, pages)}
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {vi.common.next}
            </Button>
          </span>
        </div>
      )}
    </>
  );
}

function InviteForm({ canGrantHead, onCancel, onDone }: { canGrantHead: boolean; onCancel: () => void; onDone: (l: ShownLink) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<Role[]>(["FC"]);
  const [agentCode, setAgentCode] = useState("");

  const invite = useMutation({
    mutationFn: () =>
      api<InviteLink & { user: User }>("/api/users/invite", {
        json: { email, name, roles, agentCode: agentCode.trim() || null },
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      onDone({ email: res.user.email, link: res });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    invite.mutate();
  }

  return (
    <Card>
      <form onSubmit={submit} className="grid gap-4">
        <CardTitle>{vi.users.inviteTitle}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={vi.users.name} htmlFor="invite-name">
            <Input id="invite-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={vi.users.email} htmlFor="invite-email">
            <Input id="invite-email" type="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <RolePicker value={roles} onChange={setRoles} canGrantHead={canGrantHead} />
        <Field label={vi.users.agentCode} htmlFor="invite-agent" hint={vi.users.agentCodeHint}>
          <Input id="invite-agent" inputMode="numeric" pattern="\d{1,20}" required={needsAgentCode(roles)} className="font-mono sm:max-w-xs" value={agentCode} onChange={(e) => setAgentCode(e.target.value)} />
        </Field>
        <ErrorText>{invite.isError ? errorText(invite.error) : null}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" disabled={invite.isPending || roles.length === 0}>
            {vi.users.sendInvite}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {vi.common.cancel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EditForm({ user, isSelf, canGrantHead, onClose, onLink }: { user: User; isSelf: boolean; canGrantHead: boolean; onClose: () => void; onLink: (l: ShownLink) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const [agentCode, setAgentCode] = useState(user.agentCode ?? "");

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    // Own roles may have changed.
    if (isSelf) await queryClient.invalidateQueries({ queryKey: ["me"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<User>(`/api/users/${user.id}`, { method: "PATCH", json: patch }),
    onSuccess: done,
  });
  const renew = useMutation({
    mutationFn: () => api<InviteLink>(`/api/users/${user.id}/invite`, { method: "POST" }),
    onSuccess: (link) => {
      onLink({ email: user.email, link });
      onClose();
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api<void>(`/api/users/${user.id}`, { method: "DELETE" }),
    onSuccess: done,
  });
  const busy = save.isPending || renew.isPending || withdraw.isPending;
  const error = save.error ?? renew.error ?? withdraw.error;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ name, roles, agentCode: agentCode.trim() || null });
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">{user.email}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={vi.users.name} htmlFor={`name-${user.id}`}>
          <Input id={`name-${user.id}`} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={vi.users.agentCode} htmlFor={`agent-${user.id}`} hint={vi.users.agentCodeHint}>
          <Input id={`agent-${user.id}`} inputMode="numeric" pattern="\d{1,20}" required={needsAgentCode(roles)} className="font-mono" value={agentCode} onChange={(e) => setAgentCode(e.target.value)} />
        </Field>
      </div>
      <RolePicker value={roles} onChange={setRoles} canGrantHead={canGrantHead} />
      <ErrorText>{error ? errorText(error) : null}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || roles.length === 0}>
          {vi.common.save}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {vi.common.cancel}
        </Button>
        <span className="grow" />
        {user.status === "INVITED" && (
          <>
            <Button variant="outline" disabled={busy} onClick={() => renew.mutate()}>
              {vi.users.renewInvite}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => confirm(vi.users.confirmWithdraw(user.email)) && withdraw.mutate()}>
              {vi.users.withdrawInvite}
            </Button>
          </>
        )}
        {user.status === "ACTIVE" && !isSelf && (
          <Button variant="destructive" disabled={busy} onClick={() => confirm(vi.users.confirmDisable(user.name)) && save.mutate({ status: "DISABLED" })}>
            {vi.users.disable}
          </Button>
        )}
        {user.status === "DISABLED" && (
          <Button variant="outline" disabled={busy} onClick={() => save.mutate({ status: "ACTIVE" })}>
            {vi.users.enable}
          </Button>
        )}
      </div>
    </form>
  );
}
