import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render an agent text part as safe GitHub-flavoured Markdown. Raw HTML is intentionally not
 * enabled: model output can format prose, code, tables, and links without being able to inject
 * arbitrary DOM into the application.
 */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => {
            const external = href?.startsWith("http://") || href?.startsWith("https://");
            return (
              <a
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
