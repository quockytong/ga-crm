import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Card, ErrorText, PageTitle } from "@/client/components/ui/card";
import { api, errorText, permissionsQuery, type PermissionMatrix } from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import type { ConfigurableRole, Permission } from "@/shared/permissions";

const t = vi.permissions;

/** RBAC matrix of the GA: functions (rows) by role (columns). GA Head only. */
export function PermissionsPage() {
  const queryClient = useQueryClient();
  const matrix = useQuery(permissionsQuery);
  const [grants, setGrants] = useState<PermissionMatrix["grants"] | null>(null);
  useEffect(() => {
    if (matrix.data) setGrants(matrix.data.grants);
  }, [matrix.data]);

  const save = useMutation({
    mutationFn: () => api<{ grants: PermissionMatrix["grants"] }>("/api/permissions", { method: "PUT", json: { grants } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["permissions"] });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const toggle = (role: ConfigurableRole, p: Permission) => {
    if (!grants) return;
    save.reset();
    const has = grants[role].includes(p);
    setGrants({ ...grants, [role]: has ? grants[role].filter((x) => x !== p) : [...grants[role], p] });
  };
  const dirty = !!grants && !!matrix.data && JSON.stringify(grants) !== JSON.stringify(matrix.data.grants);

  return (
    <>
      <div>
        <PageTitle>{t.title}</PageTitle>
        <p className="mt-2 text-sm text-muted-foreground">{t.intro}</p>
      </div>
      <Card className="overflow-x-auto p-0 sm:p-0">
        {!matrix.data || !grants ? (
          <p className="p-4 text-sm text-muted-foreground">{matrix.isError ? errorText(matrix.error) : vi.common.loading}</p>
        ) : (
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t.function}</th>
                <th className="px-2 py-2.5 text-center font-medium">{vi.roles.GA_HEAD}</th>
                {matrix.data.roles.map((r) => (
                  <th key={r} className="px-2 py-2.5 text-center font-medium">
                    {vi.roles[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {matrix.data.permissions.map((p) => (
                <tr key={p}>
                  <td className="px-4 py-3">
                    <p className="font-medium">{t.items[p].label}</p>
                    <p className="text-xs text-muted-foreground">{t.items[p].hint}</p>
                  </td>
                  <td className="px-2 py-3 text-center">
                    <input type="checkbox" className="size-4 accent-[var(--brand-blue-100)]" checked disabled aria-label={`${t.items[p].label}: ${vi.roles.GA_HEAD}`} />
                  </td>
                  {matrix.data.roles.map((r) => (
                    <td key={r} className="px-2 py-3 text-center">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--brand-blue-100)]"
                        checked={grants[r].includes(p)}
                        onChange={() => toggle(r, p)}
                        aria-label={`${t.items[p].label}: ${vi.roles[r]}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">{t.headFixed}</p>
      <ErrorText>{save.isError ? errorText(save.error) : null}</ErrorText>
      <div className="flex items-center gap-3">
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {vi.common.save}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => matrix.data && setGrants(matrix.data.grants)}>
            {vi.common.cancel}
          </Button>
        )}
        {save.isSuccess && !dirty && <span className="text-sm text-success">{t.saved}</span>}
      </div>
    </>
  );
}
