import { Fragment, type ReactNode } from "react";

/** **negritas** → <b>. Todo lo demás es texto (React lo escapa): el texto del modelo nunca se interpreta como HTML. */
const inline = (s: string): ReactNode[] =>
  // Un "**" sin pareja (el modelo va a medias de una negrita mientras llega el texto) no se muestra.
  s.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i} className="font-semibold text-fg">{part}</b> : <Fragment key={i}>{part.replace(/\*\*/g, "")}</Fragment>));

/** Markdown mínimo: párrafos, "- viñetas", "1. listas numeradas", "# títulos" (en negritas) y **negritas** (lo único que usan el resumen y el chat). */
export function MiniMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    if (!items.length) return;
    const Tag = ordered ? "ol" : "ul";
    blocks.push(<Tag key={`u${blocks.length}`} className={`flex flex-col gap-1.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((it, i) => <li key={i} className="leading-snug">{inline(it)}</li>)}</Tag>);
    items = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const num = /^\d{1,2}[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      // Un cambio entre viñetas y números abre otra lista.
      if (items.length && ordered !== !!num) flush();
      ordered = !!num;
      items.push((bullet ?? num)![1]);
    } else {
      flush();
      if (!line) continue;
      const heading = /^#+\s*(.*)$/.exec(line);
      blocks.push(<p key={`p${blocks.length}`} className={`leading-snug ${heading ? "font-semibold text-fg" : ""}`}>{inline(heading ? heading[1] : line)}</p>);
    }
  }
  flush();
  return <div className="flex flex-col gap-2.5">{blocks}</div>;
}
