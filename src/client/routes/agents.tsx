import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, ErrorText, PageTitle } from "@/client/components/ui/card";
import { Field, Select } from "@/client/components/ui/input";
import { agentTreeQuery, api, can, errorText, meQuery, type Agent } from "@/client/lib/api";
import { vi } from "@/i18n/vi";

export function AgentsPage() {
  const { data: me } = useSuspenseQuery(meQuery);
  const tree = useQuery(agentTreeQuery);
  const [editing, setEditing] = useState<string | null>(null);
  const canEdit = can(me, "agents.edit_tree");
  const agents = tree.data?.items ?? [];

  // Depth relative to the visible roots: a manager only sees their own subtree.
  const depthOf = useMemo(() => {
    const visible = new Set(agents.map((a) => a.agentCode));
    return (a: Agent) => a.path.split("/").filter((code) => code && code !== a.agentCode && visible.has(code)).length;
  }, [agents]);

  return (
    <>
      <PageTitle actions={agents.length > 0 ? <span className="text-sm text-muted-foreground">{vi.agents.count(agents.length)}</span> : undefined}>
        {vi.agents.title}
      </PageTitle>
      {!can(me, "agents.view_all") && agents.length > 0 && (
        <p className="text-sm text-muted-foreground">{vi.agents.scopeNote}</p>
      )}
      <Card className="p-0 sm:p-0">
        {tree.isPending ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : tree.isError ? (
          <div className="p-4">
            <ErrorText>{errorText(tree.error)}</ErrorText>
          </div>
        ) : agents.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{vi.agents.empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {agents.map((a) => (
              <li key={a.agentCode} className="px-4 py-2.5" style={{ paddingLeft: `${1 + depthOf(a) * 1.25}rem` }}>
                <div className="flex items-center gap-3">
                  <Badge tone={a.rank === "FC" ? "neutral" : "primary"}>{a.rank}</Badge>
                  <div className="min-w-0 grow">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{a.agentCode}</p>
                  </div>
                  {canEdit && editing !== a.agentCode && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(a.agentCode)}>
                      {vi.agents.changeManager}
                    </Button>
                  )}
                </div>
                {editing === a.agentCode && <ManagerForm agent={a} agents={agents} onClose={() => setEditing(null)} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ManagerForm({ agent, agents, onClose }: { agent: Agent; agents: Agent[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [managerCode, setManagerCode] = useState(agent.managerCode ?? "");
  // Not the agent itself, and nobody below it.
  const candidates = agents.filter((a) => !a.path.includes(`/${agent.agentCode}/`));

  const save = useMutation({
    mutationFn: () => api(`/api/agents/${agent.agentCode}/manager`, { method: "PATCH", json: { managerCode: managerCode || null } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      onClose();
    },
  });

  return (
    <form
      className="mt-3 grid gap-3 rounded-md bg-muted/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label={vi.agents.manager} htmlFor={`manager-${agent.agentCode}`} hint={vi.agents.changeNote}>
        <Select id={`manager-${agent.agentCode}`} value={managerCode} onChange={(e) => setManagerCode(e.target.value)}>
          <option value="">{vi.agents.noManager}</option>
          {candidates.map((c) => (
            <option key={c.agentCode} value={c.agentCode}>
              {c.rank}: {c.agentCode}-{c.name}
            </option>
          ))}
        </Select>
      </Field>
      <ErrorText>{save.isError ? errorText(save.error) : null}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || managerCode === (agent.managerCode ?? "")}>
          {vi.common.save}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {vi.common.cancel}
        </Button>
      </div>
    </form>
  );
}
