import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function SafeMarkdown({ content }: { content: string }) {
  return <Markdown skipHtml remarkPlugins={[remarkGfm]}
    urlTransform={url => /^(https?:\/\/|mailto:)/i.test(url) ? url : ""}
    components={{
      a: ({ children, href, title }) => href ?
        <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a> :
        <span>{children}</span>,
      img: ({ alt }) => <span>[Image: {alt ?? "unavailable"}]</span>,
    }}>{content}</Markdown>;
}
