# ciphertalk-plugin-ui

CipherTalk（密语）插件 UI 组件库 —— 宿主 `.ct-*` 样式类的 **React 薄封装**。

组件**不自带 CSS**：观感、暗色、主题切换全部由宿主在 `connect()` 握手时注入的
统一样式库提供。因此包体极小，且天然与宿主一致。

> 不用 React 的插件不需要本包：直接写 `<button class="ct-btn ct-btn-primary">`
> 等语义化 HTML + `.ct-*` 类即可（见插件开发指南 §6）。

## 安装

```bash
npm i ciphertalk-plugin-sdk ciphertalk-plugin-ui
```

`react` 为 peer 依赖，由你的插件项目提供（脚手架 `ciphertalk-plugin init` 已内置）。

## 用法

先 `connect()`（它负责注入 `.ct-*` 样式与主题），再正常渲染组件：

```jsx
import { connect } from 'ciphertalk-plugin-sdk'
import { Button, Card, DataTable, BarChart } from 'ciphertalk-plugin-ui'

const api = await connect()

function App() {
  return (
    <Card>
      <Button variant="primary" onClick={() => api.ui.toast('已保存')}>保存</Button>
    </Card>
  )
}
```

## 组件

| 分类 | 组件 |
| --- | --- |
| 排版 | `Title` `Hint` `Label` |
| 表单 | `Button` `Input` `Textarea` `Select` `Switch` `Checkbox` |
| 展示 | `Card` `Divider` `Chip` `Badge` `Dot` `Code` `Spinner` `Skeleton` `Progress` `List` `ListItem` `Empty` |
| 交互 | `Tabs` `Menu` `MenuItem` `Dialog` |
| 数据 | `DataTable`（排序 + 可选分页）`BarChart`（柱状图） |

### DataTable

```jsx
<DataTable
  pageSize={10}
  columns={[
    { key: 'name', title: '联系人', sortable: true },
    { key: 'count', title: '消息数', sortable: true, align: 'right' },
    { key: 'act', title: '', render: (row) => <Button variant="ghost">查看</Button> },
  ]}
  rows={rows}
/>
```

### BarChart

```jsx
<BarChart height={200} data={[
  { label: '周一', value: 120 },
  { label: '周二', value: 88 },
]} />
```

### Dialog（受控）

```jsx
const [open, setOpen] = useState(false)
<Dialog open={open} onClose={() => setOpen(false)} title="确认"
  actions={<>
    <Button onClick={() => setOpen(false)}>取消</Button>
    <Button variant="primary" onClick={confirm}>确定</Button>
  </>}>
  <Hint>说明文字</Hint>
</Dialog>
```

## 图标

本包不含图标。推荐直接用 [`lucide-react`](https://lucide.dev)（与宿主同款风格）：

```bash
npm i lucide-react
```

```jsx
import { Search } from 'lucide-react'
<Button variant="primary"><Search size={16} /> 搜索</Button>
```

## 许可

CC-BY-NC-SA-4.0
