import { memo } from "react";
import { cn } from "@/lib/utils";
import { parseMarkdown, type MarkdownBlock, type MarkdownSpan } from "@/lib/subagentMarkdown";

function Spans({ spans }: { spans: readonly MarkdownSpan[] }) {
  return (
    <>
      {spans.map((span, position) => (
        <span
          key={position}
          className={cn(
            span.bold && "font-bold",
            span.italic && "italic",
            span.code && "text-[var(--color-palette-blue)]",
          )}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case "blank":
      return <div aria-hidden>{" "}</div>;

    case "paragraph":
      return <div><Spans spans={block.spans} /></div>;

    case "heading":
      return <div className="font-bold"><Spans spans={block.spans} /></div>;

    case "bullet":
      return (
        <div className="flex" style={{ paddingLeft: `${block.depth * 2}ch` }}>
          <span aria-hidden className="w-[2ch] shrink-0">-</span>
          <div className="min-w-0 flex-1"><Spans spans={block.spans} /></div>
        </div>
      );

    case "numbered":
      return (
        <div className="flex" style={{ paddingLeft: `${block.depth * 2}ch` }}>
          <span className="shrink-0" style={{ width: `${block.marker.length + 1}ch` }}>{block.marker}</span>
          <div className="min-w-0 flex-1"><Spans spans={block.spans} /></div>
        </div>
      );

    case "quote":
      return (
        <div className="pl-[2ch] italic text-[var(--color-fg-dim)]">
          <Spans spans={block.spans} />
        </div>
      );

    case "code":
      return (
        <div className="whitespace-pre-wrap pl-[2ch] text-[var(--color-fg-dim)]">
          {block.lines.length > 0 ? block.lines.join("\n") : " "}
        </div>
      );
  }
}

/** Assistant text in Claude Code's markdown subset, as React text only. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text.replace(/\s+$/, ""));

  return (
    <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
      {blocks.map((block, position) => <Block key={position} block={block} />)}
    </div>
  );
});
