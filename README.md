# Canvas Room · 离线协作白板

纯前端单文件应用（`index.html`），无需后端、可完全离线使用。

## 运行

```bash
python3 -m http.server 8123   # 或任意静态服务器 / 直接双击 index.html
# 打开 http://127.0.0.1:8123/index.html
```

## 功能

- **房间与链接**：房间号稳定地写在 URL hash（`#room=ABC123`），"复制链接"即可分享；同一浏览器打开即进入同一房间。"新房间"生成新房间号。
- **本地持久化**：房间数据（对象 + 已应用事件 ID）写入 `localStorage`，刷新/重开页面自动恢复。
- **多标签实时同步**：同一浏览器多个标签页通过 `BroadcastChannel` + `storage` 事件双通道同步新增、移动、编辑、删除；每个事件带唯一 ID，接收方按 ID 去重，**重复事件不会被重复应用**。
- **对象**：便签（三色）、文本、矩形、圆形、连线（拖拽绘制、带箭头）。支持新增、选择、拖动、双击编辑、Delete 移除。
- **完整撤销/重做**：命令模式，撤销/重做本身也作为新事件广播，跨标签页一致；连续方向键微调自动合并为一步。
- **导出 PNG**：将画布内容（对象包围盒 + 边距，2 倍缩放）序列化为 SVG 后栅格化为真实 PNG 下载，不含任何工具栏 UI。
- **窄屏与键盘**：响应式布局（390px 可用）；快捷键 `V/N/T/R/C/L` 切工具、`Delete` 删除、`Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` 撤销重做、方向键微调（Shift×10）、`Enter` 编辑、`Esc` 取消、`Ctrl+E` 导出。

## 验证

```bash
npm install                       # puppeteer-core
python3 -m http.server 8123 &
CHROME_PATH=<chromium路径> node test/verify.cjs
```

`test/verify.cjs` 端到端覆盖：多标签同步（增/移/编/删）、刷新恢复、重复事件幂等、撤销重做及跨标签同步、PNG 导出（魔数/尺寸/无工具栏）、窄屏与键盘操作。当前 21 项全部通过。
