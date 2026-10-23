# example.com(样例 learning,演示格式)

这是随仓库发布的**格式样例**,不含任何真实经验。真正的 learnings 在用户目录
`~/.wego/learnings/`(永不发布)。

## 结构约定

- `manifest.json`:`domains`(命中主机,含子域)、`intents`(意图关键词)、
  `notes`、`tools`、`browserTools`;
- `notes/*.md`:站点打法。必含「失败路径」章节——记录走不通的路,防止重蹈;
- `tools/<name>.mjs`:node 侧工具,`export default async (args) => …`,
  `args.page` 传 Page 可获得真实输入;
- `browser-tools/<name>.js`:页内工具,`export default (arg) => …`,
  自包含无闭包引用(源码会被序列化进页面执行)。

## 写作原则

- 稳定 URL、耐用选择器、无像素坐标、无账号/隐私信息;
- 记录"为什么",不只"做什么"——控件行为变了才知道改哪里。
