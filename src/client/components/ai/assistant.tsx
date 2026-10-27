import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/client/components/ui/button";
import { ErrorText } from "@/client/components/ui/card";
import { Input, Select } from "@/client/components/ui/input";
import { cn } from "@/client/lib/cn";
import { api, can, errorText, meQuery } from "@/client/lib/api";
import { aiAgentsQuery, aiConversationQuery, aiConversationsQuery, sendAiMessage, type AiAgent, type AiSource } from "@/client/lib/ai";
import { vi } from "@/i18n/vi";
import { COACH_CRITERIA, COACH_DIFFICULTIES, COACH_SCENARIOS, type AiContext, type CoachScore, type CoachSetup, type TaskClass } from "@/shared/ai";
import { Markdown } from "./markdown";

const t = vi.ai;

/** The screen decides what the assistant sees: this lead, this client, the lists, or the FC's day. */
function useScreenContext(): { context: AiContext; ref?: string } {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const lead = /^\/leads\/([^/]+)$/.exec(path)?.[1];
  if (lead && lead !== "import") return { context: "LEAD", ref: decodeURIComponent(lead) };
  const client = /^\/clients\/([^/]+)$/.exec(path)?.[1];
  if (client) return { context: "CLIENT", ref: decodeURIComponent(client) };
  if (path === "/leads") return { context: "LEAD_LIST" };
  if (path === "/clients") return { context: "CLIENT_LIST" };
  return { context: "GENERAL" };
}

function Sparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

/** Floating "Trợ lý AI" button on every page of an agent with `ai.use`. */
export function AssistantLauncher() {
  const { data: me } = useSuspenseQuery(meQuery);
  const [open, setOpen] = useState(false);
  const screen = useScreenContext();
  if (!me.tenant || !can(me, "ai.use")) return null;
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-4 z-40 inline-flex h-12 cursor-pointer items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-lg hover:bg-primary/90"
        >
          <Sparkle />
          {t.open}
        </button>
      )}
      {open && (
        <aside
          role="dialog"
          aria-label={t.open}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-card shadow-[-16px_0_40px_-8px_rgba(0,30,90,0.28),-2px_0_8px_rgba(0,30,90,0.10)] sm:w-[30rem]"
        >
          <Panel key={`${screen.context}:${screen.ref ?? ""}`} context={screen.context} contextRef={screen.ref} onClose={() => setOpen(false)} />
        </aside>
      )}
    </>
  );
}

type Pending = {
  text: string;
  answer: string;
  tool: string | null;
  meta: { task: TaskClass; model: string; sources: AiSource[] } | null;
  /** Messages already shown when the question was sent; newer stored ones are this exchange. */
  shown: number;
};

function Panel({ context, contextRef, onClose }: { context: AiContext; contextRef?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const agents = useQuery(aiAgentsQuery(context));
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agents.data?.items.find((a) => a.id === agentId) ?? agents.data?.items[0] ?? null;
  const [convId, setConvId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const conv = useQuery({ ...aiConversationQuery(convId ?? ""), enabled: !!convId });
  const history = useQuery({
    ...aiConversationsQuery(agent?.kind === "COACH" ? "GENERAL" : context, agent?.kind === "COACH" ? undefined : contextRef),
    enabled: showHistory,
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (conv.data) setNames((n) => ({ ...n, ...conv.data.names }));
  }, [conv.data]);
  // Block body: newer browsers return a Promise from scrollIntoView, which an effect must not return.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conv.data?.messages.length, pending?.answer, pending?.tool]);

  const create = (coach?: CoachSetup) =>
    api<{ id: string }>("/api/ai/conversations", {
      json: { agentId: agent!.id, context, contextRef: agent!.kind === "COACH" ? undefined : contextRef, coach },
    }).then((r) => {
      setConvId(r.id);
      return r.id;
    });

  async function send(text: string, task?: TaskClass) {
    if (!agent || pending) return;
    setError(null);
    setPending({ text, answer: "", tool: null, meta: null, shown: conv.data?.messages.length ?? 0 });
    try {
      const id = convId ?? (await create());
      await sendAiMessage(
        id,
        { text, task },
        {
          onMeta: (m) => setPending((p) => p && { ...p, meta: m }),
          onDelta: (d) => setPending((p) => p && { ...p, answer: p.answer + d, tool: null }),
          onTool: (name) => setPending((p) => p && { ...p, tool: name }),
          onDone: (d) => setNames((n) => ({ ...n, ...d.names })),
        },
      );
      await qc.invalidateQueries({ queryKey: ["ai", "conversation", id] });
      void qc.invalidateQueries({ queryKey: ["ai", "conversations"] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  }

  const score = useMutation({
    mutationFn: () => api(`/api/ai/conversations/${convId}/score`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "conversation", convId] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/ai/conversations/${id}`, { method: "DELETE" }),
    onSuccess: (_r, id) => {
      if (id === convId) setConvId(null);
      void qc.invalidateQueries({ queryKey: ["ai", "conversations"] });
    },
  });

  // While answering, the stored copy of this exchange (refetched mid-stream) is hidden: the pending bubbles show it.
  const messages = (conv.data?.messages ?? []).slice(0, pending ? pending.shown : undefined);
  const isCoach = agent?.kind === "COACH";
  const finished = !!conv.data?.conversation.score;
  const quick: readonly { label: string; text: string; task?: TaskClass }[] = agent?.quickPrompts.length
    ? agent.quickPrompts
    : agent?.kind === "OPS"
      ? t.opsQuick
      : agent?.kind === "ASSISTANT"
        ? t.quick[context]
        : [];

  return (
    <>
      <header className="grid gap-2 border-b border-border px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-nav">
            <span className="text-primary">
              <Sparkle />
            </span>
            {t.open}
          </h2>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>
              {t.history}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConvId(null);
                setShowHistory(false);
                setError(null);
              }}
            >
              {t.newChat}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose} aria-label={vi.common.close}>
              ✕
            </Button>
          </div>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label={t.admin.kind}>
          {agents.data?.items.map((a) => (
            <AgentChip
              key={a.id}
              agent={a}
              active={a.id === agent?.id}
              onClick={() => {
                setAgentId(a.id);
                setConvId(null);
                setError(null);
              }}
            />
          ))}
        </div>
        {!isCoach && <p className="text-xs text-muted-foreground">{t.seeing(t.contexts[context])}</p>}
      </header>

      {showHistory && (
        <div className="max-h-60 overflow-x-hidden overflow-y-auto border-b border-border bg-blue-10/50 px-4 py-2 text-sm">
          {history.data?.items.filter((h) => h.agentId === agent?.id).length ? (
            <ul className="grid gap-1">
              {history.data.items
                .filter((h) => h.agentId === agent?.id)
                .map((h) => (
                  <li key={h.id} className="flex min-w-0 items-center justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-primary"
                      onClick={() => {
                        setConvId(h.id);
                        setShowHistory(false);
                      }}
                    >
                      {h.title}
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => remove.mutate(h.id)}
                      aria-label={t.deleteChat}
                    >
                      ✕
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{history.isPending ? vi.common.loading : t.noHistory}</p>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {agents.data && !agents.data.enabled ? (
          <p className="text-sm text-muted-foreground">{t.disabled}</p>
        ) : agents.data && !agent ? (
          <p className="text-sm text-muted-foreground">{t.noAgents}</p>
        ) : !agent ? (
          <p className="text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : isCoach && !convId ? (
          <CoachSetupForm leadId={context === "LEAD" ? contextRef : undefined} onStart={(setup) => create(setup).catch((e) => setError(errorText(e)))} />
        ) : (
          <div className="grid gap-4">
            {messages.length === 0 && !pending && (
              <div className="grid gap-3">
                {agent.description && <p className="text-sm text-muted-foreground">{agent.description}</p>}
                {isCoach && <p className="rounded-md bg-blue-10 p-3 text-sm text-nav">{t.coach.intro}</p>}
                {quick.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {quick.map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        onClick={() => send(q.text, q.task)}
                        className="cursor-pointer rounded-full bg-card px-3 py-1.5 text-left text-sm font-medium text-nav shadow-ring hover:bg-blue-10"
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} text={m.content} />
              ) : m.task === "EVALUATION" && conv.data?.conversation.score ? (
                <ScoreCard key={m.id} score={conv.data.conversation.score} />
              ) : (
                <Answer key={m.id} text={m.content} names={names} task={m.task} model={m.model} sources={m.sources ?? []} coach={isCoach} />
              ),
            )}
            {pending && (
              <>
                <UserBubble text={pending.text} />
                {pending.answer ? (
                  <Answer
                    text={pending.answer}
                    names={names}
                    task={pending.meta?.task ?? null}
                    model={pending.meta?.model ?? null}
                    sources={pending.meta?.sources ?? []}
                    coach={isCoach}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground italic">{(pending.tool && t.tools[pending.tool]) || t.thinking}</p>
                )}
                {pending.answer && pending.tool && <p className="text-sm text-muted-foreground italic">{t.tools[pending.tool] ?? t.thinking}</p>}
              </>
            )}
            {score.isPending && <p className="text-sm text-muted-foreground italic">{t.coach.scoring}</p>}
            <div ref={bottom} />
          </div>
        )}
      </div>

      {agent && (!isCoach || convId) && (
        <footer className="grid gap-2 border-t border-border px-4 py-3">
          <ErrorText>{error ?? (score.isError ? errorText(score.error) : null)}</ErrorText>
          {isCoach && finished ? (
            <Button variant="outline" onClick={() => setConvId(null)}>
              {t.coach.again}
            </Button>
          ) : (
            <Composer disabled={!!pending} placeholder={isCoach ? t.coach.placeholder : t.placeholder} onSend={(text) => send(text)} />
          )}
          {isCoach && convId && !finished && messages.filter((m) => m.role === "user").length >= 2 && (
            <Button size="sm" variant="outline" disabled={score.isPending || !!pending} onClick={() => score.mutate()}>
              {t.coach.finish}
            </Button>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t.privacy} {t.disclaimer}
          </p>
        </footer>
      )}
    </>
  );
}

function AgentChip({ agent, active, onClick }: { agent: AiAgent; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={agent.description ?? undefined}
      className={cn(
        "h-8 shrink-0 cursor-pointer rounded-full px-3 text-sm font-semibold whitespace-nowrap",
        active ? "bg-primary text-primary-foreground" : "bg-card text-nav shadow-ring hover:bg-blue-10",
      )}
    >
      {agent.name}
    </button>
  );
}

function UserBubble({ text }: { text: string }) {
  return <p className="ml-10 justify-self-end rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-line text-primary-foreground">{text}</p>;
}

function Answer({
  text,
  names,
  task,
  model,
  sources,
  coach,
}: {
  text: string;
  names: Record<string, string>;
  task: TaskClass | null;
  model: string | null;
  sources: AiSource[];
  coach: boolean;
}) {
  return (
    <div className={cn("mr-6 grid gap-2 rounded-lg rounded-bl-sm px-3 py-2", coach ? "bg-blue-20" : "bg-blue-10")}>
      <Markdown text={text} names={names} />
      {sources.length > 0 && (
        <div className="grid gap-0.5 border-t border-border pt-1.5 text-xs text-muted-foreground">
          <span className="font-semibold">{t.sources}</span>
          {sources.map((s) => (
            <span key={s.n}>
              [{s.n}] {s.title}
              {s.heading ? ` › ${s.heading}` : ""} · {s.kb}
            </span>
          ))}
        </div>
      )}
      {task && model && !coach && <span className="text-[11px] text-muted-foreground">{t.via(t.tasks[task], model)}</span>}
    </div>
  );
}

function Composer({ disabled, placeholder, onSend }: { disabled: boolean; placeholder: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v);
    setText("");
  };
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        rows={2}
        maxLength={4000}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="min-h-11 flex-1 resize-none rounded-md bg-card px-3 py-2 text-base shadow-ring sm:text-sm"
      />
      <Button type="submit" disabled={disabled || !text.trim()}>
        {t.send}
      </Button>
    </form>
  );
}

function CoachSetupForm({ leadId, onStart }: { leadId?: string; onStart: (setup: CoachSetup) => void }) {
  const [setup, setSetup] = useState<CoachSetup>({ scenario: "NO_MONEY", difficulty: "MEDIUM" });
  const [useLead, setUseLead] = useState(false);
  const c = t.coach;
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onStart({ ...setup, leadId: useLead ? leadId : undefined });
      }}
    >
      <p className="rounded-md bg-blue-10 p-3 text-sm text-nav">{c.intro}</p>
      <label className="grid gap-1 text-sm font-semibold text-nav">
        {c.scenario}
        <Select value={setup.scenario} onChange={(e) => setSetup({ ...setup, scenario: e.target.value as CoachSetup["scenario"] })}>
          {COACH_SCENARIOS.map((s) => (
            <option key={s} value={s}>
              {c.scenarios[s]}
            </option>
          ))}
        </Select>
      </label>
      {setup.scenario === "CUSTOM" && (
        <label className="grid gap-1 text-sm font-semibold text-nav">
          {c.custom}
          <Input value={setup.custom ?? ""} maxLength={500} onChange={(e) => setSetup({ ...setup, custom: e.target.value })} />
        </label>
      )}
      <fieldset className="grid gap-1">
        <legend className="text-sm font-semibold text-nav">{c.difficulty}</legend>
        <div className="flex gap-2">
          {COACH_DIFFICULTIES.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={setup.difficulty === d}
              onClick={() => setSetup({ ...setup, difficulty: d })}
              className={cn(
                "h-9 cursor-pointer rounded-full px-4 text-sm font-semibold",
                setup.difficulty === d ? "bg-primary text-primary-foreground" : "bg-card text-nav shadow-ring hover:bg-blue-10",
              )}
            >
              {c.difficulties[d]}
            </button>
          ))}
        </div>
      </fieldset>
      {leadId && (
        <label className="flex items-center gap-2 text-sm text-nav">
          <input type="checkbox" className="size-4 accent-[var(--brand-blue-100)]" checked={useLead} onChange={(e) => setUseLead(e.target.checked)} />
          {c.useLead}
        </label>
      )}
      {!useLead && (
        <label className="grid gap-1 text-sm font-semibold text-nav">
          {c.persona}
          <Input
            value={setup.persona ?? ""}
            maxLength={500}
            placeholder={c.personaPlaceholder}
            onChange={(e) => setSetup({ ...setup, persona: e.target.value || undefined })}
          />
        </label>
      )}
      <label className="grid gap-1 text-sm font-semibold text-nav">
        {c.product}
        <Input value={setup.product ?? ""} maxLength={200} onChange={(e) => setSetup({ ...setup, product: e.target.value || undefined })} />
      </label>
      <Button type="submit">{c.start}</Button>
    </form>
  );
}

function ScoreCard({ score }: { score: CoachScore }) {
  const c = t.coach;
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div className="grid gap-1">
        <p className="text-sm font-semibold text-nav">{title}</p>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="grid gap-3 rounded-lg p-3 shadow-ring">
      <div className="flex items-center gap-3">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">
          {Math.round(score.overall)}
        </span>
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase">{c.overall}</p>
          <p className="text-sm">{score.verdict}</p>
        </div>
      </div>
      <div className="grid gap-2">
        {COACH_CRITERIA.map((key) => {
          const cr = score.criteria.find((x) => x.key === key);
          if (!cr) return null;
          return (
            <div key={key} className="grid gap-0.5">
              <div className="flex justify-between text-sm">
                <span className="font-semibold text-nav">{c.criteria[key]}</span>
                <span className="tabular-nums">{cr.score}/10</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-blue-20">
                <div className="h-full bg-primary" style={{ width: `${cr.score * 10}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">{cr.comment}</p>
            </div>
          );
        })}
      </div>
      {list(c.strengths, score.strengths)}
      {list(c.improvements, score.improvements)}
      {score.betterLines.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-sm font-semibold text-nav">{c.betterLines}</p>
          {score.betterLines.map((b, i) => (
            <div key={i} className="grid gap-0.5 rounded-md bg-blue-10 p-2 text-sm">
              <span className="text-muted-foreground">
                {c.youSaid}: “{b.original}”
              </span>
              <span>
                {c.tryInstead}: “{b.suggestion}”
              </span>
            </div>
          ))}
        </div>
      )}
      {list(c.persuasion, score.persuasionOptions)}
    </div>
  );
}
