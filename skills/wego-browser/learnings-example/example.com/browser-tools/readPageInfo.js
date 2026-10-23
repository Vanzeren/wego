// Sample in-page tool: read the page's heading and link (format demo only).
export default function readPageInfo() {
  return {
    title: document.title,
    heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    firstLink: document.querySelector('a')?.href ?? null,
  };
}
