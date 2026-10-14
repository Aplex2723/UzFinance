import { Fragment, type ReactNode } from "react";

/** **negritas** → <b>. Todo lo demás es texto (React lo escapa): el texto del modelo nunca se interpreta como HTML. */
const inline = (s: string): ReactNode[] => s.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i} className="font-semibold text-fg">{part}</b> : <Fragment key={i}>{part}</Fragment>));

/** Markdown mínimo: párrafos, "- viñetas" y **negritas** (lo único que usa el resumen). */
export function MiniMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    blocks.push(<ul key={`u${blocks.length}`} className="flex list-disc flex-col gap-1.5 pl-5">{items.map((it, i) => <li key={i} className="leading-snug">{inline(it)}</li>)}</ul>);
    items = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1]);
    else {
      flush();
      if (line) blocks.push(<p key={`p${blocks.length}`} className="leading-snug">{inline(line.replace(/^#+\s*/, ""))}</p>);
    }
  }
  flush();
  return <div className="flex flex-col gap-2.5">{blocks}</div>;
}
