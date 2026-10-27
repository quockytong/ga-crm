import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { InviteLinkCard } from "@/client/components/invite-link";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, PageTitle } from "@/client/components/ui/card";
import { Field, Input } from "@/client/components/ui/input";
import { api, ApiError, errorText, formatDateTime, productsQuery, tenantsQuery, tenantUsersQuery, type InviteLink, type Tenant } from "@/client/lib/api";
import { vi } from "@/i18n/vi";

type ShownLink = { email: string; link: InviteLink };
type Created = InviteLink & { tenant: Tenant; head: { id: string; email: string } };

export function TenantsPage() {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<ShownLink | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const tenants = useQuery({ ...tenantsQuery(page), placeholderData: keepPreviousData });
  const pages = tenants.data ? Math.max(1, Math.ceil(tenants.data.total / tenants.data.pageSize)) : 1;

  return (
    <>
      <PageTitle actions={!creating && <Button onClick={() => setCreating(true)}>{vi.tenants.createTitle}</Button>}>{vi.tenants.title}</PageTitle>
      {shown && <InviteLinkCard email={shown.email} link={shown.link} onClose={() => setShown(null)} />}
      {creating && (
        <CreateForm
          onCancel={() => setCreating(false)}
          onDone={(link) => {
            setCreating(false);
            setShown(link);
          }}
        />
      )}
      <p className="text-xs text-muted-foreground">{vi.tenants.auditNote}</p>
      <Card className="p-0 sm:p-0">
        {tenants.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : tenants.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(tenants.error)}</ErrorText>
          </div>
        ) : tenants.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.tenants.empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {tenants.data.items.map((t) => (
              <li key={t.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 grow">
                    <p className="text-sm font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{t.gaCode}</span> · {vi.tenants.createdAt}: {formatDateTime(t.createdAt)}
                    </p>
                  </div>
                  <Badge tone={t.status === "active" ? "success" : "destructive"}>{vi.tenants.status[t.status]}</Badge>
                  <Button variant="outline" size="sm" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    {open === t.id ? vi.common.close : vi.tenants.viewUsers}
                  </Button>
                </div>
                {open === t.id && <TenantUsers tenantId={t.id} onLink={setShown} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {vi.common.prev}
          </Button>
          {vi.common.pageOf(page, pages)}
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {vi.common.next}
          </Button>
        </div>
      )}
      <ProductCatalog />
    </>
  );
}

function TenantUsers({ tenantId, onLink }: { tenantId: string; onLink: (l: ShownLink) => void }) {
  const detail = useQuery(tenantUsersQuery(tenantId));
  const renew = useMutation({
    mutationFn: (user: { id: string; email: string }) =>
      api<InviteLink>(`/api/platform/tenants/${tenantId}/users/${user.id}/invite`, { method: "POST" }).then((link) => ({ email: user.email, link })),
    onSuccess: onLink,
  });
  if (detail.isPending) return <p className="mt-3 text-sm text-muted-foreground">{vi.common.loading}</p>;
  if (detail.isError) return <ErrorText>{errorText(detail.error)}</ErrorText>;
  return (
    <ul className="mt-3 grid gap-2 rounded-md bg-muted/60 p-3">
      {detail.data.users.items.map((u) => (
        <li key={u.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 grow">
            {u.name} <span className="text-muted-foreground">· {u.email}</span>
          </span>
          {u.roles.map((r) => (
            <Badge key={r}>{vi.roles[r]}</Badge>
          ))}
          <Badge tone={u.status === "ACTIVE" ? "success" : u.status === "INVITED" ? "warning" : "destructive"}>{vi.userStatus[u.status]}</Badge>
          {u.status === "INVITED" && (
            <Button variant="outline" size="sm" disabled={renew.isPending} onClick={() => renew.mutate(u)}>
              {vi.users.renewInvite}
            </Button>
          )}
        </li>
      ))}
      <ErrorText>{renew.isError ? errorText(renew.error) : null}</ErrorText>
    </ul>
  );
}

function CreateForm({ onCancel, onDone }: { onCancel: () => void; onDone: (l: ShownLink) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ gaCode: "", name: "", headName: "", headEmail: "", headAgentCode: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const create = useMutation({
    mutationFn: () =>
      api<Created>("/api/platform/tenants", {
        json: {
          gaCode: form.gaCode,
          name: form.name,
          head: { name: form.headName, email: form.headEmail, agentCode: form.headAgentCode.trim() || null },
        },
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["tenants"] });
      onDone({ email: res.head.email, link: res });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Card>
      <form onSubmit={submit} className="grid gap-4">
        <CardTitle>{vi.tenants.createTitle}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={vi.tenants.gaCode} htmlFor="ga-code" hint={vi.tenants.gaCodeHint}>
            <Input id="ga-code" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,30}[A-Za-z0-9]" className="font-mono uppercase" value={form.gaCode} onChange={set("gaCode")} />
          </Field>
          <Field label={vi.tenants.name} htmlFor="ga-name">
            <Input id="ga-name" required maxLength={120} value={form.name} onChange={set("name")} />
          </Field>
        </div>
        <CardTitle className="text-sm">{vi.tenants.headTitle}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={vi.tenants.headName} htmlFor="head-name">
            <Input id="head-name" required maxLength={120} value={form.headName} onChange={set("headName")} />
          </Field>
          <Field label={vi.tenants.headEmail} htmlFor="head-email">
            <Input id="head-email" type="email" inputMode="email" required value={form.headEmail} onChange={set("headEmail")} />
          </Field>
          <Field label={vi.tenants.headAgentCode} htmlFor="head-agent">
            <Input id="head-agent" inputMode="numeric" pattern="\d{1,20}" className="font-mono" value={form.headAgentCode} onChange={set("headAgentCode")} />
          </Field>
        </div>
        <ErrorText>{create.isError ? errorText(create.error) : null}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {vi.tenants.create}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {vi.common.cancel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// 11_Products header -> API field. The catalog is DLVN-wide: every GA's client pages use it.
const PRODUCT_COLUMNS: Record<string, string> = {
  product_code: "productCode",
  product_name: "productName",
  product_role: "productRole",
  category: "category",
  min_entry_age: "minEntryAge",
  max_entry_age: "maxEntryAge",
  max_cover_age: "maxCoverAge",
  gender: "gender",
  waiting_period_days: "waitingPeriod",
  key_benefits: "keyBenefits",
  fit_rule: "fitRule",
  trigger_event: "triggerEvent",
  rule_status: "ruleStatus",
};

function ProductCatalog() {
  const queryClient = useQueryClient();
  const catalog = useQuery(productsQuery);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer());
      const sheet = wb.Sheets["11_Products"];
      const raw = sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null }) : [];
      const rows = raw
        .map((r) =>
          Object.fromEntries(
            Object.entries(r).flatMap(([h, v]) => (PRODUCT_COLUMNS[h.trim()] && v !== null && v !== "" ? [[PRODUCT_COLUMNS[h.trim()], String(v).trim()]] : [])),
          ),
        )
        .filter((r) => r.productCode && r.productName);
      if (rows.length === 0) throw new Error(vi.tenants.productsMissing);
      return api<{ saved: number }>("/api/platform/products", { json: { rows } });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platform", "products"] }),
  });
  return (
    <Card className="grid gap-3">
      <CardTitle>{vi.tenants.productsTitle}</CardTitle>
      <p className="text-sm text-muted-foreground">{vi.tenants.productsHelp}</p>
      <label className="inline-flex h-9 w-fit cursor-pointer items-center rounded-md bg-card px-3 text-sm font-semibold text-nav shadow-ring hover:bg-blue-10">
        {vi.tenants.productsUpload}
        <input
          type="file"
          accept=".xlsx,.xls"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = "";
          }}
        />
      </label>
      {upload.isSuccess && <p className="text-sm text-success">{vi.tenants.productsSaved(upload.data.saved)}</p>}
      <ErrorText>{upload.isError ? (upload.error instanceof ApiError ? errorText(upload.error) : upload.error.message) : null}</ErrorText>
      {catalog.data && catalog.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{vi.tenants.productsEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{vi.tenants.productCode}</th>
                <th className="px-2 py-2 font-medium">{vi.tenants.productName}</th>
                <th className="px-2 py-2 font-medium">{vi.tenants.category}</th>
                <th className="px-2 py-2 font-medium">{vi.tenants.ruleStatus}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {catalog.data?.items.map((p) => (
                <tr key={p.productCode}>
                  <td className="py-2 pr-3 font-mono">{p.productCode}</td>
                  <td className="px-2 py-2">{p.productName}</td>
                  <td className="px-2 py-2">{p.category ?? vi.common.none}</td>
                  <td className="px-2 py-2">{p.ruleStatus ?? vi.common.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
