# QQ 邮箱写信页(#/compose)

打过的硬仗，2026-10-23 验证有效。该页全是自研组件，常规 fill/click 会翻车，照此流程：

## 收件人(xmail 自研 token 组件)

**可执行版本已封装为 `tools/compose.mjs`**(`runSiteTool('mail.qq.com','compose',{page,to,subject,body})`),
以下是其依据的手工仪式:

- 可编辑输入框是 `input.cmp-account-input`,**点击后才出现**;点击目标优先选
  输入框自身(有宽度时),否则组件右端空白。点击后必须校验
  `document.activeElement` 确实是它,否则 Backspace 会吃到正文。
- 输入地址用**粘贴**(`keyboard.paste`),不要逐字 type:`.` 的 ASCII(46)撞上
  VK_DELETE 会丢点(input.js 已修 vk=0,但粘贴更稳,且不会触发逐字联想)。
- 提交:无联想下拉时 `Enter` 成 token;有联想下拉先 `Escape` 再 `Enter`,
  否则会误选联想联系人(踩过:地址联想出 "CIS / SGS Customer service")。
- 删除:输入框空时 `Backspace` 删最右 token;编辑中文本按字符删。
- **清理循环的判净**:行内折叠/展开图标会贡献 `+0`/`-1` 文本。用
  `row.replace(/收件人|抄送|密送|分别发送|[+\-0-9\s]/g,'')` 为空判净,
  残差两轮不变说明焦点丢了,抛错交还人。
- **草稿自动保存会刷新页面状态**:编辑中的半截文本(如缺点的地址)是瞬态,
  自动保存后重开 `#/compose` 才是提交后的真实内容。校验终态以重开/重读后为准,
  或直接读 `.receiver-editor-wrap` 文本——好 token 显示完整地址,
  坏地址红底高亮。

## 正文(contenteditable 富文本)

- 编辑器是 `div#contentDiv_0[contenteditable="true"]`。
- **不要**用 Ctrl+A + 粘贴(会串到正文之外的卡片文本,产生重复内容)。
- 稳定写法:`innerHTML` 按段写 `<div>…</div>`(空段用 `<br>`),然后
  `dispatchEvent(new InputEvent('input', {bubbles:true}))` 让框架感知。

## 失败路径(都踩过,勿复蹈)

- `page.keyboard.type('a@b.com')` 丢 `.`(vk 冲突,已修但仍推荐粘贴);
- Ctrl+A 全选正文 + 粘贴 → 串入签名卡片文本,内容重复;
- 合成事件(dispatchEvent click/mousedown)点收件人组件 → 焦点永远落在正文编辑器;
- `#/write?to=xxx` hash 直达写信页 → 被重定向到列表页,必须点"写信"按钮或等
  `.receiver-editor-wrap` 出现。

## 其他

- 主题/收件人旁的输入框是原生 `input`,fill() 正常。
- 草稿自动保存("上次保存" 时间戳),中断后重开 `#/compose` 会带上次内容——
  先看现有内容再决定覆盖还是继续。
- 读信页(#/read/…)正文中 "HR邮箱 → 给TA写信" 的 href 即真实 HR 地址;
  直接回复按钮指向 noreply 地址,不要回复 noreply。
