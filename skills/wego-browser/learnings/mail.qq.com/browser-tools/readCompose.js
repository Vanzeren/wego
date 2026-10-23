// Read the current compose form state (runs IN PAGE via page.evaluate).
export default function readCompose() {
  const ed = document.querySelector('div[contenteditable="true"]');
  return {
    recipients: document.querySelector('.receiver-editor-wrap')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    subject: [...document.querySelectorAll('input')].map((i) => i.value).find((v) => v) ?? '',
    body: ed ? ed.textContent : null,
    url: location.href,
  };
}
