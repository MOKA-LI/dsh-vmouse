# 虚拟鼠标（dsh-vmouse）

给 DeepSeek Harness 一个**独立的虚拟光标**：模型能读别的应用窗口、点击、输入、滚动、截单个窗口，
而**你的物理鼠标不会跳、前台焦点不会被打断**。你继续在 DSH（或任何应用）里干活，模型在后台
操作它自己选定的目标应用。

只在 macOS 上工作（Windows / Linux 会明确拒绝而不是假装成功）。

## 怎么做到"不打扰你"

1. **先读无障碍树，而不是截图。** `vmouse_tree` 返回窗口的元素列表：角色、标题、值、坐标、支持的动作。
   纯文本，几十个元素大约几百 token；截图一张通常一千多 token，而且看不懂的就还是看不懂。
2. **优先用元素动作点击。** 元素支持 `press` 时直接触发，不涉及鼠标坐标，也不需要窗口在前台。
3. **必须用坐标时，事件只投递给目标进程。** 通过 `CGEventPostToPid` 把点击/按键/滚轮排进那个进程的
   事件队列，物理光标位置不变、前台应用不变。
4. **截图只截目标窗口**（`screencapture -l <windowId>`），后台窗口也能截，不截你的整个桌面。

## 工具

| 工具 | 作用 | 只读 |
|---|---|---|
| `vmouse_ping` | 检查辅助功能权限、helper 状态、物理光标位置 | ✅ |
| `vmouse_apps` | 列出有窗口的运行中应用，给出 pid 和 window id | ✅ |
| `vmouse_tree` | 读窗口无障碍树，返回紧凑文本 + 元素 ref（e1、e2…） | ✅ |
| `vmouse_click` | 按元素 ref 点击（优先 accessibility press），或按坐标点击；支持双击、右键、修饰键 | |
| `vmouse_type` | 向元素或目标应用输入文本，优先写 accessibility value，回退 Unicode 按键事件；支持中文 | |
| `vmouse_key` | 发送快捷键，如 `cmd+s`、`cmd+shift+z`、`return` | |
| `vmouse_scroll` | 在元素/坐标/窗口中心滚动，只投递给目标进程 | |
| `vmouse_shot` | 只截目标窗口的 PNG，返回文件路径；需要看像素时再用 `read_image` 打开 | ✅ |

典型一次操作：`vmouse_apps` → `vmouse_tree`（拿到 `e12`）→ `vmouse_click {ref:"e12"}`。
三个调用、几百 token，全程不碰你的鼠标。

## 权限

- **辅助功能（Accessibility）**：读元素树和执行元素动作需要。首次使用在
  「系统设置 → 隐私与安全性 → 辅助功能」里勾选 DeepSeek Harness。
- **屏幕录制（Screen Recording）**：只有 `vmouse_shot` 需要。

## 限制（真实行为）

- **没有无障碍树的应用**（部分游戏、自绘画布）只能按坐标工作。坐标点击通过进程事件投递，
  少数应用只接受前台点击，这时调用可能成功返回但界面没反应——请改用元素 ref，或先把窗口拉到前台。
- **元素 ref 只在产生它的快照内有效**，重复读树会换一批 ref。
- 输入法候选框不会经过虚拟键盘；中文直接以 Unicode 事件或 value 写入，效果取决于目标控件。
- 不提供窗口移动/缩放、拖拽、菜单栏操作。
- helper 是 Swift 源码首次使用时编译（需要 Xcode Command Line Tools），产物缓存在
  `~/.cache/dsh-vmouse/bin`。
