import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/client/components/ui/button";
import { Card, CardTitle, ErrorText } from "@/client/components/ui/card";
import { cn } from "@/client/lib/cn";
import { errorText, formatDateTime } from "@/client/lib/api";
import { vi } from "@/i18n/vi";
import { CONTACT_TYPES } from "@/shared/schemas";

// "Ghi chú" for leads and clients: notes and contacts (call, Zalo, meeting) in one story,
// oldest first. Picking a chip when adding logs the contact and keeps the text as its note.

export type ContactType = (typeof CONTACT_TYPES)[number];
export type NoteItem = { id: string; kind: "NOTE" | ContactType; body: string | null; at: string; by: string | null; tag?: string | null; outcome?: string | null };

const t = vi.notes;
const svg = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function ContactIcon({ kind }: { kind: ContactType }) {
  if (kind === "CALL")
    return (
      <svg {...svg}>
        <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
      </svg>
    );
  if (kind === "ZALO")
    return (
      <svg {...svg}>
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-4.6A8 8 0 0 1 3 11.5 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
        <path d="M8.5 9.5h4l-4 4h4M15.5 9.5v4" />
      </svg>
    );
  return (
    <svg {...svg}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </svg>
  );
}

const textarea = "w-full rounded-md bg-card px-3 py-2 text-base shadow-ring sm:text-sm";

export function NotesCard({
  items,
  help,
  canAdd,
  onAdd,
  firstLabel,
  children,
}: {
  items: NoteItem[];
  help: string;
  canAdd: boolean;
  /** `kind` null = a plain note. */
  onAdd: (kind: ContactType | null, body: string) => Promise<unknown>;
  /** Label of the oldest note (e.g. "Ghi chú ban đầu" on a lead). */
  firstLabel?: string;
  children?: ReactNode;
}) {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<ContactType | null>(null);
  const add = useMutation({
    mutationFn: () => onAdd(kind, body),
    onSuccess: () => {
      setBody("");
      setKind(null);
    },
  });
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <Card className="grid content-start gap-3">
      <div>
        <CardTitle>{t.title}</CardTitle>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <ol className="grid divide-y divide-border">
          {sorted.map((n, i) => (
            <li key={n.id} className="py-3 text-sm first:pt-0 last:pb-0">
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                {n.kind !== "NOTE" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-10 px-2 py-0.5 font-semibold text-link">
                    <ContactIcon kind={n.kind} />
                    {t.kinds[n.kind]}
                  </span>
                )}
                {i === 0 && n.kind === "NOTE" && firstLabel && <span className="font-semibold text-nav">{firstLabel} ·</span>}
                <span>
                  {formatDateTime(n.at)}
                  {n.by ? ` · ${t.by(n.by)}` : ""}
                  {n.tag ? ` · ${n.tag}` : ""}
                </span>
              </p>
              {n.outcome && <p className="mt-1 font-medium">{n.outcome}</p>}
              {n.body && <p className="mt-1 whitespace-pre-line">{n.body}</p>}
            </li>
          ))}
        </ol>
      )}
      {canAdd && (
        <form
          className="grid gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.kindLabel}>
            {CONTACT_TYPES.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(kind === k ? null : k)}
                className={cn(
                  "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-semibold",
                  kind === k ? "bg-primary text-primary-foreground" : "bg-card text-nav shadow-ring hover:bg-blue-10",
                )}
              >
                <ContactIcon kind={k} />
                {t.kinds[k]}
              </button>
            ))}
            <span className="text-xs text-muted-foreground">{kind ? t.willLog(t.kinds[kind]) : t.chipHint}</span>
          </div>
          <textarea rows={3} maxLength={4000} aria-label={t.add} placeholder={t.placeholder} className={textarea} value={body} onChange={(e) => setBody(e.target.value)} />
          <ErrorText>{add.isError ? errorText(add.error) : null}</ErrorText>
          <Button type="submit" size="sm" className="w-fit" disabled={add.isPending || !body.trim()}>
            {kind ? t.addContact(t.kinds[kind]) : t.add}
          </Button>
        </form>
      )}
      {children}
    </Card>
  );
}
