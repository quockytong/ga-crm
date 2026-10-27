import { Fragment, type ReactNode } from "react";

/**
 * The small Markdown subset the assistants write (headings, lists, bold), rendered as React
 * nodes (never as HTML). Pseudonym tokens such as [K1] show the real name; [S1] marks a source.
 */

// Tokens may come grouped despite the prompt: [K1, K2].
const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[(?:[KLNAP]\d+(?:\s*,\s*[KLNAP]\d+)*|S\d+)\])/g;

function inline(text: string, names: Record<string, string>, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k}>{inline(part.slice(2, -2), names, k)}</strong>;
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <em key={k}>{inline(part.slice(1, -1), names, k)}</em>;
    const tokens = /^\[([KLNAP]\d+(?:\s*,\s*[KLNAP]\d+)*)\]$/.exec(part)?.[1]?.split(/\s*,\s*/);
    if (tokens)
      return (
        <Fragment key={k}>
          {tokens.map((token, j) => (
            <Fragment key={token}>
              {j > 0 && ", "}
              <span className="font-semibold text-link" title={token}>
                {names[token] ?? `[${token}]`}
              </span>
            </Fragment>
          ))}
        </Fragment>
      );
    const source = /^\[S(\d+)\]$/.exec(part)?.[1];
    if (source)
      return (
        <sup key={k} className="ml-0.5 rounded bg-blue-20 px-1 text-[10px] font-semibold text-link">
          {source}
        </sup>
      );
    return <Fragment key={k}>{part}</Fragment>;
  });
}

export function Markdown({ text, names }: { text: string; names: Record<string, string> }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, names, `l${blocks.length}-${i}`)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      ),
    );
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} className="border-border" />);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <blockquote key={blocks.length} className="border-l-2 border-primary/40 pl-3 text-nav italic">
          {inline(quote[1]!, names, `q${blocks.length}`)}
        </blockquote>,
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={blocks.length} className="font-semibold text-nav">
          {inline(heading[1]!, names, `h${blocks.length}`)}
        </p>
      ) : (
        <p key={blocks.length}>{inline(line, names, `p${blocks.length}`)}</p>
      ),
    );
  }
  flush();
  return <div className="grid gap-2 text-sm leading-relaxed">{blocks}</div>;
}
