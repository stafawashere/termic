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
            span.code && "text-[var(--cc-permission)]",
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
      return <div aria-hidden>{"\u00A0"}</div>;

    case "paragraph":
      return <div><Spans spans={block.spans} /></div>;

    case "heading": {
      const isTitle = block.level === 1;
      return (
        <div data-heading-level={block.level} className={cn("font-bold", isTitle && "italic underline")}>
          <Spans spans={block.spans} />
        </div>
      );
    }

    case "table":
      return <div data-testid="subagent-table" className="whitespace-pre">{block.lines.join("\n")}</div>;

    case "bullet":
      return (
        <div className="flex" style={{ paddingLeft: `calc(var(--cell) * ${block.depth * 2})` }}>
          <span aria-hidden className="w-[calc(var(--cell)*2)] shrink-0">-</span>
          <div className="min-w-0 flex-1"><Spans spans={block.spans} /></div>
        </div>
      );

    case "numbered":
      return (
        <div className="flex" style={{ paddingLeft: `calc(var(--cell) * ${block.depth * 2})` }}>
          <span className="shrink-0" style={{ width: `calc(var(--cell) * ${block.marker.length + 1})` }}>{block.marker}</span>
          <div className="min-w-0 flex-1"><Spans spans={block.spans} /></div>
        </div>
      );

    case "quote":
      return (
        <div className="pl-[calc(var(--cell)*2)] italic text-[var(--cc-dim)]">
          <Spans spans={block.spans} />
        </div>
      );

    case "code": {
      const hasLanguage = block.language !== "";
      return (
        <div data-code-language={block.language} className={cn("whitespace-pre-wrap", !hasLanguage && "text-[var(--cc-permission)]")}>
          {block.lines.length > 0 ? block.lines.join("\n") : "\u00A0"}
        </div>
      );
    }
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
