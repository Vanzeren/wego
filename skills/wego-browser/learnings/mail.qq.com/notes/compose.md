# QQ 邮箱写信页(#/compose)

打过的硬仗，2026-10-23 验证有效。该页全是自研组件，常规 fill/click 会翻车，照此流程：

## 收件人(xmail 自研 token 组件)

- 可编辑输入框是 `input.cmp-account-input`,**点击后才出现**:真实鼠标点击
  `.receiver-editor-wrap .xmail-cmp-accounts-editor` 的右端空白处。
- 输入地址后 **`Enter` 会选中联想下拉的首项**(可能塞进错误联系人)。正确提交:
  输完按 `Escape` 关掉联想,再点正文区域失焦提交;或确认下拉无匹配时再 Enter。
- 删除 token:聚焦输入框,空值时 `Backspace` 删最右 token;正在编辑的文本按字符删。
- 校验终态:读 `.receiver-editor-wrap` 的 textContent,坏 token 文本带红底高亮
  (如 `campus@dewucom` 缺点这种错地址会标红)。
- 填充时若只进了一半文本(如只剩 `campus`),清掉重来:Backspace 循环直到只剩
  `收件人…抄送密送分别发送` 骨架文本。

## 正文(contenteditable 富文本)

- 编辑器是 `div#contentDiv_0[contenteditable="true"]`。
- **不要**用 Ctrl+A + 粘贴(会串到正文之外的卡片文本,产生重复内容)。
- 稳定写法:`innerHTML` 按段写 `<div>…</div>`(空段用 `<br>`),然后
  `dispatchEvent(new InputEvent('input', {bubbles:true}))` 让框架感知。

## 其他

- 主题/收件人旁的输入框是原生 `input`,fill() 正常。
- 草稿自动保存("上次保存" 时间戳),中断后重开 `#/compose` 会带上次内容——
  先看现有内容再决定覆盖还是继续。
- 读信页(#/read/…)正文中 "HR邮箱 → 给TA写信" 的 href 即真实 HR 地址;
  直接回复按钮指向 noreply 地址,不要回复 noreply。
