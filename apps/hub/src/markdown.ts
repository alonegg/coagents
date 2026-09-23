import DOMPurify from "dompurify";
import { marked } from "marked";

// Peer-written Markdown is untrusted: rendered, then sanitized. Only http(s)/mailto links survive,
// and they open in a new tab without referrer or opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true });
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
    FORBID_TAGS: ["style", "iframe", "form", "input", "button", "textarea", "select", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}
