import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { Badge, Card, CardTitle, ErrorText, FilterTab, PageTitle } from "@/client/components/ui/card";
import { Field, Input, Select } from "@/client/components/ui/input";
import { api, errorText, formatDateTime } from "@/client/lib/api";
import {
  aiAdminAgentsQuery,
  aiDocumentsQuery,
  aiKbsQuery,
  aiModelsQuery,
  aiSettingsQuery,
  aiUsageQuery,
  type AiAdminAgent,
  type AiDocument,
  type AiKb,
  type AiSettingsView,
  type AiUsageRow,
} from "@/client/lib/ai";
import { vi } from "@/i18n/vi";
import {
  AGENT_KINDS,
  AI_CONTEXTS,
  AI_PROVIDERS,
  AI_TIERS,
  DEFAULT_TASK_TIER,
  defaultAgentConfig,
  KB_CATEGORIES,
  MAX_DOC_CHARS,
  TASK_CLASSES,
  type AgentKind,
  type AiModelChoice,
  type AiTier,
  type KbCategory,
} from "@/shared/ai";

const t = vi.ai;
const a = vi.ai.admin;
type Tab = keyof typeof a.tabs;
const num = (n: number) => n.toLocaleString("vi-VN");
const textarea = "w-full rounded-md bg-card px-3 py-2 text-base shadow-ring sm:text-sm";
const check = "size-4 shrink-0 accent-[var(--brand-blue-100)]";

/** "Trợ lý AI" for the GA Head: assistants, knowledge bases, models and budget, usage. */
export function AiSettingsPage() {
  const [tab, setTab] = useState<Tab>("agents");
  return (
    <>
      <PageTitle>{a.title}</PageTitle>
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {(Object.keys(a.tabs) as Tab[]).map((k) => (
          <FilterTab key={k} active={tab === k} onClick={() => setTab(k)}>
            {a.tabs[k]}
          </FilterTab>
        ))}
      </div>
      {tab === "agents" && <AgentsTab />}
      {tab === "knowledge" && <KnowledgeTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "usage" && <UsageTab />}
    </>
  );
}

/* ---------- Assistants ---------- */

type AgentDraft = Omit<AiAdminAgent, "id">;

/** A new assistant starts blank: the GA Head names it and writes its role. */
const newDraft = (): AgentDraft => ({
  kind: "CUSTOM",
  name: "",
  description: "",
  enabled: true,
  instructions: "",
  contexts: [...AI_CONTEXTS],
  models: {},
  taskTiers: {},
  kbIds: [],
  config: defaultAgentConfig("CUSTOM"),
  sortOrder: 100,
});

function AgentsTab() {
  const agents = useQuery(aiAdminAgentsQuery);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{a.agentsHelp}</p>
        <Button disabled={adding} onClick={() => setAdding(true)}>
          {a.addAgent}
        </Button>
      </div>
      {adding && <AgentEditor key="new" draft={newDraft()} onDone={() => setAdding(false)} />}
      {agents.data?.items.map((ag) =>
        editing === ag.id ? (
          <AgentEditor key={ag.id} id={ag.id} draft={ag} onDone={() => setEditing(null)} />
        ) : (
          <Card key={ag.id} className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{ag.name}</CardTitle>
                <Badge>{t.kinds[ag.kind]}</Badge>
                <Badge tone={ag.enabled ? "success" : "destructive"}>{ag.enabled ? a.enabled : a.disabledLabel}</Badge>
              </div>
              {ag.description && <p className="text-sm text-muted-foreground">{ag.description}</p>}
              <p className="text-xs text-muted-foreground">
                {a.contexts}: {ag.contexts.map((c) => t.contexts[c]).join(", ")} · {a.knowledge}: {ag.kbIds.length}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setEditing(ag.id)}>
              {vi.common.edit}
            </Button>
          </Card>
        ),
      )}
    </div>
  );
}

function ModelPicker({
  value,
  onChange,
  providers,
  allowEmpty,
  id,
}: {
  value: AiModelChoice | undefined;
  onChange: (v: AiModelChoice | undefined) => void;
  providers: AiSettingsView["providers"];
  allowEmpty?: boolean;
  id: string;
}) {
  const info = providers.find((p) => p.provider === value?.provider);
  // The provider's own list, when the GA has a key: model ids change too often to hard-code.
  const live = useQuery({ ...aiModelsQuery(value?.provider ?? "GEMINI"), enabled: !!value && !!info?.ready });
  const models = live.data?.items.length ? live.data.items : null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select
        id={id}
        aria-label={a.provider}
        value={value?.provider ?? ""}
        onChange={(e) => {
          const p = e.target.value as AiModelChoice["provider"] | "";
          if (!p) return onChange(undefined);
          onChange({ provider: p, model: providers.find((x) => x.provider === p)?.models[0] ?? "" });
        }}
      >
        {allowEmpty && <option value="">{a.useDefault}</option>}
        {AI_PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {providers.find((x) => x.provider === p)?.label ?? p}
            {providers.find((x) => x.provider === p)?.ready ? "" : " ⚠"}
          </option>
        ))}
      </Select>
      {value &&
        (models ? (
          <Select aria-label={a.model} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {!models.includes(value.model) && <option value={value.model}>{value.model} ⚠</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <>
            <Input aria-label={a.model} list={`${id}-models`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} />
            <datalist id={`${id}-models`}>
              {info?.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        ))}
      {value && models && !models.includes(value.model) && <p className="text-xs text-destructive sm:col-span-2">{a.modelNotListed}</p>}
    </div>
  );
}

function AgentEditor({ id, draft: initial, onDone }: { id?: string; draft: AgentDraft; onDone: () => void }) {
  const qc = useQueryClient();
  const kbs = useQuery(aiKbsQuery);
  const settings = useQuery(aiSettingsQuery);
  const [d, setD] = useState<AgentDraft>({ ...initial, config: { ...defaultAgentConfig(initial.kind), ...initial.config } });
  const config = { ...defaultAgentConfig(d.kind), ...d.config };
  const prompts = config.quickPrompts;
  const setConfig = (c: Partial<typeof config>) => setD({ ...d, config: { ...config, ...c } });
  const body = {
    kind: d.kind,
    name: d.name,
    description: d.description,
    enabled: d.enabled,
    instructions: d.instructions,
    contexts: d.contexts,
    models: d.models,
    taskTiers: d.taskTiers,
    kbIds: d.kbIds,
    config: { ...config, quickPrompts: prompts.filter((q) => q.label.trim() && q.text.trim()) },
    sortOrder: d.sortOrder,
  };
  const save = useMutation({
    mutationFn: () => (id ? api(`/api/ai/admin/agents/${id}`, { method: "PATCH", json: body }) : api("/api/ai/admin/agents", { json: body })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai"] });
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/ai/admin/agents/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai"] });
      onDone();
    },
  });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const fid = id ?? "new";
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{id ? initial.name : a.newAgent}</CardTitle>
        <label className="flex items-center gap-2 text-sm font-semibold text-nav">
          <input type="checkbox" className={check} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
          {a.enabled}
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={a.name} htmlFor={`${fid}-name`}>
          <Input id={`${fid}-name`} value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label={a.description} htmlFor={`${fid}-desc`}>
          <Input id={`${fid}-desc`} value={d.description ?? ""} maxLength={300} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </Field>
      </div>
      <Field label={a.kind} hint={t.kindHints[d.kind]} htmlFor={`${fid}-kind`}>
        <Select
          id={`${fid}-kind`}
          value={d.kind}
          onChange={(e) => {
            const kind = e.target.value as AgentKind;
            setD({ ...d, kind, config: { ...defaultAgentConfig(kind), quickPrompts: prompts } });
          }}
        >
          {AGENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t.kinds[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={a.instructions} hint={d.kind === "CUSTOM" ? a.instructionsCustomHint : a.instructionsHint} htmlFor={`${fid}-ins`}>
        <textarea
          id={`${fid}-ins`}
          rows={6}
          maxLength={8000}
          className={textarea}
          value={d.instructions}
          onChange={(e) => setD({ ...d, instructions: e.target.value })}
        />
      </Field>
      <fieldset className="grid gap-1.5">
        <legend className="text-sm font-semibold text-nav">{a.contexts}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {AI_CONTEXTS.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className={check} checked={d.contexts.includes(c)} onChange={() => setD({ ...d, contexts: toggle(d.contexts, c) })} />
              {t.contexts[c]}
            </label>
          ))}
        </div>
      </fieldset>
      {d.kind !== "COACH" && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold text-nav">{a.abilities}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className={`${check} mt-0.5`} checked={config.crmData} onChange={(e) => setConfig({ crmData: e.target.checked })} />
            <span>
              {a.crmData}
              <span className="block text-xs text-muted-foreground">{a.crmDataHint}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className={`${check} mt-0.5`} checked={config.tools} onChange={(e) => setConfig({ tools: e.target.checked })} />
            <span>
              {a.tools}
              <span className="block text-xs text-muted-foreground">{a.toolsHint}</span>
            </span>
          </label>
        </fieldset>
      )}
      {d.kind !== "COACH" && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold text-nav">{a.quickPrompts}</legend>
          <p className="text-xs text-muted-foreground">{a.quickPromptsHint}</p>
          {prompts.map((q, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
              <Input
                aria-label={a.quickLabel}
                placeholder={a.quickLabel}
                value={q.label}
                maxLength={60}
                onChange={(e) => setConfig({ quickPrompts: prompts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
              />
              <Input
                aria-label={a.quickText}
                placeholder={a.quickText}
                value={q.text}
                maxLength={1000}
                onChange={(e) => setConfig({ quickPrompts: prompts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
              />
              <Button variant="ghost" aria-label={a.quickRemove} onClick={() => setConfig({ quickPrompts: prompts.filter((_, j) => j !== i) })}>
                ✕
              </Button>
            </div>
          ))}
          {prompts.length < 8 && (
            <Button size="sm" variant="outline" className="w-fit" onClick={() => setConfig({ quickPrompts: [...prompts, { label: "", text: "" }] })}>
              {a.quickAdd}
            </Button>
          )}
        </fieldset>
      )}
      {d.kind !== "COACH" && (
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-semibold text-nav">{a.knowledge}</legend>
          {kbs.data?.items.length ? (
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {kbs.data.items.map((kb) => (
                <label key={kb.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className={check} checked={d.kbIds.includes(kb.id)} onChange={() => setD({ ...d, kbIds: toggle(d.kbIds, kb.id) })} />
                  {kb.name}
                  <span className="text-xs text-muted-foreground">({t.kbCategories[kb.category]})</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{a.noKnowledge}</p>
          )}
        </fieldset>
      )}
      {settings.data && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold text-nav">{a.models}</legend>
          {AI_TIERS.map((tier) => (
            <div key={tier} className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:items-center">
              <span className="text-sm">{t.tiers[tier]}</span>
              <ModelPicker
                id={`${fid}-m-${tier}`}
                allowEmpty
                providers={settings.data.providers}
                value={d.models[tier]}
                onChange={(v) => {
                  const models = { ...d.models };
                  if (v) models[tier] = v;
                  else delete models[tier];
                  setD({ ...d, models });
                }}
              />
            </div>
          ))}
        </fieldset>
      )}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-semibold text-nav">{a.taskTiers}</legend>
        <p className="text-xs text-muted-foreground">{a.taskTiersHint}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {TASK_CLASSES.filter((k) => (d.kind === "COACH" ? k === "ROLEPLAY" || k === "EVALUATION" : k !== "ROLEPLAY" && k !== "EVALUATION")).map((task) => (
            <label key={task} className="grid grid-cols-[8rem_1fr] items-center gap-2 text-sm">
              {t.tasks[task]}
              <Select
                value={d.taskTiers[task] ?? ""}
                onChange={(e) => {
                  const taskTiers = { ...d.taskTiers };
                  if (e.target.value) taskTiers[task] = e.target.value as AiTier;
                  else delete taskTiers[task];
                  setD({ ...d, taskTiers });
                }}
              >
                <option value="">
                  {a.useDefault} ({t.tiers[DEFAULT_TASK_TIER[task]]})
                </option>
                {AI_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {t.tiers[tier]}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorText>{save.isError ? errorText(save.error) : remove.isError ? errorText(remove.error) : null}</ErrorText>
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          <Button disabled={save.isPending || !d.name.trim() || !d.instructions.trim() || d.contexts.length === 0} onClick={() => save.mutate()}>
            {vi.common.save}
          </Button>
          <Button variant="outline" onClick={onDone}>
            {vi.common.cancel}
          </Button>
        </div>
        {id && (
          <Button variant="destructive" disabled={remove.isPending} onClick={() => window.confirm(a.confirmDelete) && remove.mutate()}>
            {a.deleteAgent}
          </Button>
        )}
      </div>
    </Card>
  );
}

/* ---------- Knowledge ---------- */

function KnowledgeTab() {
  const qc = useQueryClient();
  const kbs = useQuery(aiKbsQuery);
  const [form, setForm] = useState<{ name: string; category: KbCategory; description: string }>({ name: "", category: "PRODUCT", description: "" });
  const create = useMutation({
    mutationFn: () => api("/api/ai/admin/kbs", { json: { ...form, enabled: true } }),
    onSuccess: () => {
      setForm({ name: "", category: "PRODUCT", description: "" });
      void qc.invalidateQueries({ queryKey: ["ai", "admin", "kbs"] });
    },
  });
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{a.knowledgeHelp}</p>
      <Card>
        <form
          className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={a.kbName} htmlFor="kb-name">
            <Input id="kb-name" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={a.kbCategory} htmlFor="kb-cat">
            <Select id="kb-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as KbCategory })}>
              {KB_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t.kbCategories[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={a.description} htmlFor="kb-desc">
            <Input id="kb-desc" value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Button type="submit" disabled={!form.name.trim() || create.isPending}>
            {a.addKb}
          </Button>
        </form>
        <ErrorText>{create.isError ? errorText(create.error) : null}</ErrorText>
      </Card>
      {kbs.data?.items.map((kb) => (
        <KbCard key={kb.id} kb={kb} />
      ))}
      <SearchTry />
    </div>
  );
}

function KbCard({ kb }: { kb: AiKb }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const docs = useQuery({ ...aiDocumentsQuery(kb.id), enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ["ai", "admin", "kbs"] });
  const patch = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/ai/admin/kbs/${kb.id}`, { method: "PATCH", json: { name: kb.name, description: kb.description, category: kb.category, enabled } }),
    onSuccess: refresh,
  });
  const removeKb = useMutation({ mutationFn: () => api(`/api/ai/admin/kbs/${kb.id}`, { method: "DELETE" }), onSuccess: refresh });
  const removeDoc = useMutation({ mutationFn: (id: string) => api(`/api/ai/admin/documents/${id}`, { method: "DELETE" }), onSuccess: refresh });
  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button type="button" className="grid min-w-0 flex-1 cursor-pointer gap-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="flex flex-wrap items-center gap-2">
            <CardTitle>
              {open ? "▾" : "▸"} {kb.name}
            </CardTitle>
            <Badge>{t.kbCategories[kb.category]}</Badge>
            {!kb.enabled && <Badge tone="destructive">{a.disabledLabel}</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">
            {a.documents(kb.documents)} · {a.chars(num(kb.chars))}
            {kb.description ? ` · ${kb.description}` : ""}
          </span>
        </button>
        <label className="flex items-center gap-2 text-sm font-semibold text-nav">
          <input type="checkbox" className={check} checked={kb.enabled} disabled={patch.isPending} onChange={(e) => patch.mutate(e.target.checked)} />
          {a.enabled}
        </label>
      </div>
      {open && (
        <>
          {docs.data?.items.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{a.docTitle}</th>
                    <th className="py-2 pr-3 font-medium">{vi.tenants.productCode}</th>
                    <th className="py-2 pr-3 text-right font-medium">{a.chunksCol}</th>
                    <th className="py-2 pr-3 font-medium">{vi.leads.date}</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {docs.data.items.map((d) => (
                    <DocRow key={d.id} doc={d} onDelete={() => removeDoc.mutate(d.id)} deleting={removeDoc.isPending} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{docs.isPending ? vi.common.loading : a.noDocs}</p>
          )}
          <AddDocument kbId={kb.id} />
          <div>
            <Button size="sm" variant="destructive" disabled={removeKb.isPending} onClick={() => window.confirm(a.confirmDeleteKb) && removeKb.mutate()}>
              {a.deleteKb}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** One document; its title and product code can be changed after upload. */
function DocRow({ doc, onDelete, deleting }: { doc: AiDocument; onDelete: () => void; deleting: boolean }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<{ title: string; productCode: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api(`/api/ai/admin/documents/${doc.id}`, { method: "PATCH", json: { title: edit!.title, productCode: edit!.productCode || null } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["ai", "admin", "kbs"] });
      setEdit(null);
    },
  });
  if (edit)
    return (
      <tr>
        <td className="py-2 pr-3" colSpan={2}>
          <form
            id={`doc-${doc.id}`}
            className="grid gap-2 sm:grid-cols-[2fr_1fr]"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <Input aria-label={a.docTitle} value={edit.title} maxLength={200} autoFocus onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            <Input
              aria-label={a.docProduct}
              value={edit.productCode}
              maxLength={40}
              className="font-mono"
              onChange={(e) => setEdit({ ...edit, productCode: e.target.value })}
            />
          </form>
          <ErrorText>{save.isError ? errorText(save.error) : null}</ErrorText>
        </td>
        <td className="py-2 pr-3 text-right tabular-nums">{doc.chunks}</td>
        <td />
        <td className="py-2 text-right whitespace-nowrap">
          <Button size="sm" type="submit" form={`doc-${doc.id}`} disabled={!edit.title.trim() || save.isPending}>
            {vi.common.save}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
            {vi.common.cancel}
          </Button>
        </td>
      </tr>
    );
  return (
    <tr>
      <td className="py-2 pr-3">
        {doc.title}
        {doc.sourceName && <span className="block text-xs text-muted-foreground">{doc.sourceName}</span>}
      </td>
      <td className="py-2 pr-3 font-mono text-xs">{doc.productCode ?? vi.common.none}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{doc.chunks}</td>
      <td className="py-2 pr-3 text-xs whitespace-nowrap text-muted-foreground">
        {formatDateTime(doc.createdAt)}
        {doc.createdByName ? ` · ${doc.createdByName}` : ""}
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        <Button size="sm" variant="ghost" onClick={() => setEdit({ title: doc.title, productCode: doc.productCode ?? "" })}>
          {vi.common.edit}
        </Button>
        <Button size="sm" variant="ghost" disabled={deleting} onClick={onDelete}>
          {a.deleteDoc}
        </Button>
      </td>
    </tr>
  );
}

type QueuedFile = { file: File; status: "waiting" | "reading" | "saving" | "done" | "error"; detail?: string };

/** Several files at once (each becomes a document titled after its file), or pasted text. */
function AddDocument({ kbId }: { kbId: string }) {
  const qc = useQueryClient();
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [running, setRunning] = useState(false);
  const [doc, setDoc] = useState({ title: "", productCode: "", text: "" });
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["ai", "admin", "kbs"] });
  const post = (body: { title: string; productCode: string | null; sourceName: string | null; text: string }) =>
    api<{ chunks: number }>(`/api/ai/admin/kbs/${kbId}/documents`, { json: body });

  async function uploadAll() {
    setRunning(true);
    const { extractText } = await import("@/client/lib/extract-text");
    const set = (i: number, patch: Partial<QueuedFile>) => setQueue((q) => q.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    // One at a time: PDF parsing is heavy for the browser and each upload is one request.
    for (const [i, item] of queue.entries()) {
      if (item.status === "done") continue;
      try {
        set(i, { status: "reading", detail: undefined });
        const text = (await extractText(item.file)).trim();
        if (text.length < 20) {
          set(i, { status: "error", detail: a.docUnreadable });
          continue;
        }
        if (text.length > MAX_DOC_CHARS) {
          set(i, { status: "error", detail: a.docTooLong(num(MAX_DOC_CHARS)) });
          continue;
        }
        set(i, { status: "saving" });
        const r = await post({ title: item.file.name.replace(/\.[^.]+$/, "").slice(0, 200), productCode: null, sourceName: item.file.name, text });
        set(i, { status: "done", detail: a.chunks(r.chunks) });
      } catch (e) {
        set(i, { status: "error", detail: errorText(e) });
      }
    }
    setRunning(false);
    void refresh();
  }

  const paste = useMutation({
    mutationFn: () => post({ title: doc.title, productCode: doc.productCode || null, sourceName: null, text: doc.text }),
    onSuccess: (r) => {
      setNote(a.docSaved(r.chunks));
      setDoc({ title: "", productCode: "", text: "" });
      void refresh();
    },
  });
  const tooLong = doc.text.length > MAX_DOC_CHARS;
  const pending = queue.filter((q) => q.status !== "done").length;
  const tone = { waiting: "neutral", reading: "warning", saving: "warning", done: "success", error: "destructive" } as const;

  return (
    <div className="grid gap-3 rounded-md bg-blue-10/60 p-3">
      <p className="text-sm font-semibold text-nav">{a.addDoc}</p>
      <Field label={a.docFiles} hint={a.docFilesHint} htmlFor={`${kbId}-files`}>
        <Input
          id={`${kbId}-files`}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          className="pt-2.5"
          disabled={running}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            setQueue((q) => [...q.filter((x) => x.status !== "done"), ...files.map((file) => ({ file, status: "waiting" as const }))]);
            e.target.value = "";
          }}
        />
      </Field>
      {queue.length > 0 && (
        <ul className="grid gap-1.5 text-sm">
          {queue.map((q, i) => (
            <li key={`${q.file.name}-${i}`} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{q.file.name}</span>
              <Badge tone={tone[q.status]}>{a.fileStatus[q.status]}</Badge>
              {q.detail && <span className={q.status === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{q.detail}</span>}
              {!running && q.status !== "done" && (
                <button
                  type="button"
                  className="cursor-pointer text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => setQueue(queue.filter((_, j) => j !== i))}
                  aria-label={a.deleteDoc}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending > 0 && (
        <Button size="sm" className="w-fit" disabled={running} onClick={uploadAll}>
          {running ? a.uploading : a.uploadFiles(pending)}
        </Button>
      )}

      <form
        className="grid gap-3 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          paste.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={a.docTitle} htmlFor={`${kbId}-title`}>
            <Input id={`${kbId}-title`} value={doc.title} maxLength={200} onChange={(e) => setDoc({ ...doc, title: e.target.value })} />
          </Field>
          <Field label={a.docProduct} htmlFor={`${kbId}-product`}>
            <Input id={`${kbId}-product`} value={doc.productCode} maxLength={40} onChange={(e) => setDoc({ ...doc, productCode: e.target.value })} />
          </Field>
        </div>
        <Field label={a.docText} htmlFor={`${kbId}-text`} hint={doc.text ? a.chars(num(doc.text.length)) : undefined}>
          <textarea id={`${kbId}-text`} rows={4} className={textarea} value={doc.text} onChange={(e) => setDoc({ ...doc, text: e.target.value })} />
        </Field>
        <ErrorText>{tooLong ? a.docTooLong(num(MAX_DOC_CHARS)) : paste.isError ? errorText(paste.error) : null}</ErrorText>
        {note && <p className="text-sm text-success">{note}</p>}
        <Button type="submit" size="sm" variant="outline" className="w-fit" disabled={paste.isPending || tooLong || !doc.title.trim() || !doc.text.trim()}>
          {a.savePasted}
        </Button>
      </form>
    </div>
  );
}

function SearchTry() {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({
    queryKey: ["ai", "admin", "search", submitted],
    queryFn: () =>
      api<{ items: { id: string; title: string; kb: string; heading: string | null; body: string }[] }>(
        `/api/ai/admin/search?q=${encodeURIComponent(submitted)}`,
      ),
    enabled: !!submitted,
  });
  return (
    <Card className="grid gap-3">
      <CardTitle>{a.tryTitle}</CardTitle>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <Input value={q} placeholder={a.tryPlaceholder} aria-label={a.tryTitle} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="outline" disabled={!q.trim()}>
          {vi.common.search}
        </Button>
      </form>
      {results.data &&
        (results.data.items.length ? (
          <ol className="grid gap-2">
            {results.data.items.map((r) => (
              <li key={r.id} className="rounded-md bg-blue-10 p-2 text-sm">
                <p className="text-xs font-semibold text-nav">
                  {r.title}
                  {r.heading ? ` › ${r.heading}` : ""} · {r.kb}
                </p>
                <p className="line-clamp-3 whitespace-pre-line">{r.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{a.noResults}</p>
        ))}
    </Card>
  );
}

/* ---------- Models and budget ---------- */

function ModelsTab() {
  const qc = useQueryClient();
  const data = useQuery(aiSettingsQuery);
  const [s, setS] = useState<AiSettingsView["settings"] | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data.data && !s) setS(data.data.settings);
  }, [data.data, s]);
  const save = useMutation({
    mutationFn: () => api("/api/ai/admin/settings", { method: "PUT", json: s }),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["ai"] });
    },
  });
  if (!data.data || !s) return <p className="text-sm text-muted-foreground">{vi.common.loading}</p>;
  const providers = data.data.providers;
  const ready = (c: AiModelChoice) => providers.find((p) => p.provider === c.provider)?.ready;
  const status = (c: AiModelChoice) => <Badge tone={ready(c) ? "success" : "destructive"}>{ready(c) ? a.providerReady : a.providerMissing}</Badge>;
  return (
    <div className="grid gap-4">
      <ProviderKeys providers={providers} />
      <Card className="grid gap-5">
        <p className="text-sm text-muted-foreground">{a.modelsHelp}</p>
        <label className="flex items-center gap-2 text-sm font-semibold text-nav">
          <input type="checkbox" className={check} checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          {a.aiEnabled}
        </label>
        {AI_TIERS.map((tier) => (
          <div key={tier} className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-nav">{t.tiers[tier]}</span>
              {status(s.tiers[tier])}
            </div>
            <p className="text-xs text-muted-foreground">{t.tierHints[tier]}</p>
            <ModelPicker
              id={`tier-${tier}`}
              providers={providers}
              value={s.tiers[tier]}
              onChange={(v) => v && setS({ ...s, tiers: { ...s.tiers, [tier]: v } })}
            />
          </div>
        ))}
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-nav">{a.router}</span>
            {status(s.router)}
          </div>
          <ModelPicker id="router" providers={providers} value={s.router} onChange={(v) => v && setS({ ...s, router: v })} />
          <p className="text-xs text-muted-foreground">{a.modelHint}</p>
        </div>
        <Field label={a.limit} htmlFor="ai-limit" hint={a.used(num(data.data.usedThisMonth), s.monthlyTokenLimit ? num(s.monthlyTokenLimit) : "∞")}>
          <Input
            id="ai-limit"
            type="number"
            min={0}
            step={100000}
            value={s.monthlyTokenLimit}
            onChange={(e) => setS({ ...s, monthlyTokenLimit: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
        <ErrorText>{save.isError ? errorText(save.error) : null}</ErrorText>
        <div className="flex items-center gap-3">
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {vi.common.save}
          </Button>
          {saved && !save.isPending && <span className="text-sm text-success">{a.saved}</span>}
        </div>
      </Card>
    </div>
  );
}

/** The GA's own API key per provider. The key is write-only: only its last 4 characters come back. */
function ProviderKeys({ providers }: { providers: AiSettingsView["providers"] }) {
  return (
    <Card className="grid gap-4">
      <div>
        <CardTitle>{a.keysTitle}</CardTitle>
        <p className="text-xs text-muted-foreground">{a.keysHelp}</p>
      </div>
      <div className="grid gap-4 divide-y divide-border">
        {providers.map((p) => (
          <ProviderKeyRow key={p.provider} p={p} />
        ))}
      </div>
    </Card>
  );
}

function ProviderKeyRow({ p }: { p: AiSettingsView["providers"][number] }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["ai", "admin", "settings"] }), qc.invalidateQueries({ queryKey: ["ai", "admin", "models", p.provider] })]);
  const save = useMutation({
    mutationFn: () => api(`/api/ai/admin/keys/${p.provider}`, { method: "PUT", json: { apiKey: value } }),
    onSuccess: () => {
      setValue("");
      setResult(a.keySaved);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/ai/admin/keys/${p.provider}`, { method: "DELETE" }),
    onSuccess: () => {
      setResult(null);
      void refresh();
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ model: string }>(`/api/ai/admin/keys/${p.provider}/test`, { method: "POST" }),
    onSuccess: (r) => setResult(a.keyWorks(r.model)),
  });
  const status =
    p.keySource === "GA" ? (
      <Badge tone="success">{a.keyGa(p.last4 ?? "")}</Badge>
    ) : p.keySource === "PLATFORM" ? (
      <Badge tone="warning">{a.keyPlatform}</Badge>
    ) : (
      <Badge tone="destructive">{a.keyNone}</Badge>
    );
  const error = save.isError ? save.error : remove.isError ? remove.error : test.isError ? test.error : null;
  return (
    <div className="grid gap-2 pt-4 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-nav">{p.label}</span>
        {status}
        {p.keyUpdatedAt && p.keySource === "GA" && <span className="text-xs text-muted-foreground">{a.keyUpdated(formatDateTime(p.keyUpdatedAt) ?? "")}</span>}
      </div>
      {p.keyUnreadable && <p className="text-xs text-destructive">{a.keyUnreadable}</p>}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          save.mutate();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-64 font-mono"
          aria-label={a.keyInput(p.label)}
          placeholder={p.keySource === "GA" ? a.keyReplace : a.keyPlaceholder}
          value={value}
          maxLength={500}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={value.trim().length < 8 || save.isPending}>
          {vi.common.save}
        </Button>
        <Button
          variant="outline"
          disabled={!p.ready || test.isPending}
          onClick={() => {
            setResult(null);
            test.mutate();
          }}
        >
          {test.isPending ? a.keyTesting : a.keyTest}
        </Button>
        {p.keySource === "GA" && (
          <Button variant="destructive" disabled={remove.isPending} onClick={() => window.confirm(a.keyConfirmDelete) && remove.mutate()}>
            {a.keyDelete}
          </Button>
        )}
      </form>
      <ErrorText>{error ? errorText(error) : null}</ErrorText>
      {result && <p className="text-sm text-success">{result}</p>}
    </div>
  );
}

/* ---------- Usage ---------- */

function UsageTab() {
  const [month, setMonth] = useState(() => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7));
  const usage = useQuery(aiUsageQuery(month));
  const table = (title: string, rows: AiUsageRow[], label: (r: AiUsageRow) => string) => (
    <Card className="grid gap-2 overflow-x-auto">
      <CardTitle>{title}</CardTitle>
      {rows.length ? (
        <table className="w-full min-w-[24rem] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium" />
              <th className="py-2 pr-3 text-right font-medium">{a.answers}</th>
              <th className="py-2 pr-3 text-right font-medium">{a.inputTokens}</th>
              <th className="py-2 text-right font-medium">{a.outputTokens}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {[...rows]
              .sort((x, y) => y.inputTokens + y.outputTokens - (x.inputTokens + x.outputTokens))
              .map((r) => (
                <tr key={r.key}>
                  <td className="py-2 pr-3">{label(r)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{num(r.answers)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{num(r.inputTokens)}</td>
                  <td className="py-2 text-right tabular-nums">{num(r.outputTokens)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">{a.noUsage}</p>
      )}
    </Card>
  );
  return (
    <div className="grid gap-4">
      <div className="w-48">
        <Field label={a.month} htmlFor="ai-month">
          <Input id="ai-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
      </div>
      {usage.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {table(a.byUser, usage.data.byUser, (r) => r.name ?? r.key)}
          {table(a.byAgent, usage.data.byAgent, (r) => r.name ?? r.key)}
          {table(a.byModel, usage.data.byModel, (r) => r.key)}
          {table(a.byTask, usage.data.byTask, (r) => (r.key ? t.tasks[r.key as keyof typeof t.tasks] : vi.common.none))}
        </div>
      )}
    </div>
  );
}
