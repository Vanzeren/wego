// mail.qq.com compose ritual — the executable form of notes/compose.md.
// args: { page, to, subject, body } — page must be on any mail.qq.com view.
// Handles: open compose, recipient token widget ritual, subject, body.
export default async function compose({ page, to, subject, body }) {
  if (!page) throw new Error('compose needs args.page (a Page on mail.qq.com)');
  if (!to || !subject || !body) throw new Error('compose needs to/subject/body');

  // open compose if not already there (hash nav on the SPA is unreliable —
  // click 写信 and wait for the compose DOM)
  const composeReady = () => page.evaluate(() => !!document.querySelector('.receiver-editor-wrap'));
  if (!(await composeReady())) {
    await page.click('text=写信').catch(() => {});
    await page.waitForFunction(() => !!document.querySelector('.receiver-editor-wrap'), undefined, { timeout: 5000 }).catch(() => {});
  }
  if (!(await composeReady())) {
    await page.goto('https://wx.mail.qq.com/home/index#/compose').catch(() => {});
    await page.waitForFunction(() => !!document.querySelector('.receiver-editor-wrap'), undefined, { timeout: 5000 }).catch(() => {});
  }
  if (!(await composeReady())) throw new Error('compose form did not open');
  await page.snapshot(); // refs for this round

  // --- recipient token ritual (see notes/compose.md) ---
  const rect = await page.evaluate(() => {
    const inp = document.querySelector('input.cmp-account-input');
    if (inp) {
      const r = inp.getBoundingClientRect();
      if (r.width > 4) return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) };
    }
    const editor = document.querySelector('.receiver-editor-wrap .xmail-cmp-accounts-editor');
    const r = editor.getBoundingClientRect();
    return { x: Math.round(r.right - 20), y: Math.round(r.top + r.height / 2) };
  });
  const rowText = () => page.evaluate(() =>
    document.querySelector('.receiver-editor-wrap').textContent.replace(/\s+/g, ' ').trim());
  await page.mouse.click(rect.x, rect.y); // real click reveals input.cmp-account-input
  await page.waitForTimeout(400);
  // focus must land on the recipient input, or Backspace eats the body text
  const focused = await page.evaluate(() => document.activeElement?.classList?.contains('cmp-account-input') ?? false);
  if (!focused) {
    // retry once with a fresh click
    await page.mouse.click(rect.x, rect.y);
    await page.waitForTimeout(400);
    const again = await page.evaluate(() => document.activeElement?.classList?.contains('cmp-account-input') ?? false);
    if (!again) throw new Error('recipient input would not focus');
  }
  // clear any leftover tokens/text: Backspace deletes editing text per char,
  // then tokens. The expand icons contribute "+0"/"-1" text — strip them when
  // judging cleanliness.
  const residualOf = (row) => row.replace(/收件人|抄送|密送|分别发送|[+\-0-9\s]/g, '');
  let lastResidual = null;
  for (let i = 0; i < 16; i++) {
    const residual = residualOf(await rowText());
    if (!residual) break;
    if (residual === lastResidual) throw new Error(`recipient area will not clean: ${JSON.stringify(residual)}`);
    lastResidual = residual;
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
  }
  if (residualOf(await rowText())) throw new Error('recipient area not clean after cleanup loop');
  // paste the address: one atomic insert, immune to keymap quirks and
  // suggestion-dropdown interference while typing
  await page.keyboard.paste({ text: to });
  await page.waitForTimeout(300);
  // If a contact suggestion dropdown is visible, Enter would pick it; close
  // it first. Otherwise Enter tokenizes the address.
  const dropdownOpen = await page.evaluate(() =>
    !!document.querySelector('[class*="suggestion"] [class*="item"], [class*="dropdown"] [class*="item"]'));
  if (dropdownOpen) await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  if (!(await rowText()).includes(to)) {
    // one retry: blur-commit via clicking the subject label
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('*')].find((e) => e.childElementCount <= 3 && /^\s*主\s*题\s*$/.test(e.textContent));
      label?.click();
    });
    await page.waitForTimeout(400);
  }
  const finalRow = await rowText();
  if (!finalRow.includes(to)) {
    throw new Error(`recipient not committed: row is ${JSON.stringify(finalRow)}`);
  }

  // --- subject (native input, accessible name 主题) ---
  await page.fill('loc=role:textbox[name=主题]', subject);

  // --- body via DOM write (never Ctrl+A + paste) ---
  await page.evaluate((text) => {
    const ed = document.querySelector('div[contenteditable="true"]');
    const paras = String(text).split('\n');
    ed.innerHTML = paras.map((p) => `<div>${p || '<br>'}</div>`).join('');
    ed.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, body);

  await page.waitForTimeout(400);
  // verify final state
  return page.evaluate(() => ({
    recipients: document.querySelector('.receiver-editor-wrap')?.textContent.replace(/\s+/g, ' ').trim(),
    subject: [...document.querySelectorAll('input')].map((i) => i.value).find((v) => v) ?? '',
    bodyHead: document.querySelector('div[contenteditable="true"]')?.textContent.slice(0, 60),
  }));
}
