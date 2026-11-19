# dsh-vmouse · 虚拟鼠标

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 macOS 桌面控制插件。
模型用**自己的虚拟光标**读窗口、点击、输入、滚动；**你的物理鼠标不动，前台焦点不被打断**。

```text
你：继续写你的代码 / 回你的消息
DSH：在后台对目标窗口做 vmouse_tree → vmouse_click → vmouse_type
```

## 为什么不是普通桌面自动化

| 常见做法 | 问题 | dsh-vmouse |
|---|---|---|
| 移动系统鼠标 + 全局按键 | 抢走你的鼠标，打断你正在做的事 | 元素动作 + `CGEventPostToPid` 定向投递，物理光标不动 |
| 全靠截图 | 每次几千 token，还容易看错 | 默认读无障碍树，纯文本几百 token |
| 全屏截图 | 把你桌面上的一切都送进模型 | 只截目标窗口，后台也能截 |
| 需要前台激活 | 你被迫停下手上的事 | 默认不激活目标应用 |

## 安装

要求：macOS、DSH `0.2.1` 以上、Xcode Command Line Tools（`xcode-select --install`，首次编译 helper 用）。

```sh
# 直接从 GitHub 安装
dsh plugin --profile <你的 profile> add github:MOKA-LI/dsh-vmouse

# 或者先克隆再本地链接
git clone https://github.com/MOKA-LI/dsh-vmouse
dsh plugin --profile <你的 profile> add ./dsh-vmouse
```

然后在「设置 → 插件」里确认出现**虚拟鼠标**并启用，重启 DSH。

首次调用会编译 helper（约 3–8 秒，之后走缓存）。

## 授权

- 「系统设置 → 隐私与安全性 → **辅助功能**」勾选 DeepSeek Harness —— 读树和点击需要。
- 只有截图需要「**屏幕录制**」。

用 `vmouse_ping` 确认：`accessibility granted` 即就绪。

## 用法

让模型做的事就是你要它做的事，例如：

```text
打开系统设置，把「自动隐藏菜单栏」打开，然后回来告诉我当前状态。
```

模型自己的节奏是：

1. `vmouse_apps` —— 找到目标应用和窗口
2. `vmouse_tree {pid}` —— 读到元素，拿到 `e12`
3. `vmouse_click {pid, ref:"e12"}` —— 点它
4. 需要看像素时 `vmouse_shot` + `read_image`

## 工具

见 [docs/DETAIL.md](docs/DETAIL.md)，8 个工具，前缀 `vmouse_`。

## 限制

- 没有无障碍树的自绘界面（部分游戏/画布）只能坐标操作，少数应用只接受前台点击。
- 元素 ref 属于一次快照，重读后换新。
- 不提供拖拽、窗口移动、菜单栏操作。
- 只在 macOS 上工作；其它平台每个调用都会明确报错。

## 开发

```sh
# 编译原生 helper
xcrun -sdk macosx swiftc -O -o .build/vmouse-helper helper/vmouse-helper.swift

# helper 自检
./.build/vmouse-helper --selftest

# 插件冒烟测试（不需要 DSH）
node test/plugin-smoke.mjs
```

## License

MIT
