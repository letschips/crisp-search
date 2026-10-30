# Crisp Search

Obsidian 自带的快速切换只看文件名，全局搜索要先打开侧栏。中文笔记还有一个问题：中文词之间没有空格，很多搜索插件把一整句当成一个词，搜「知识库」找不到「整理个人知识库的目录」。

Crisp Search 是一个启动器式的搜索面板，在 Obsidian 里按一个快捷键打开，输入就出结果，笔记、正文和命令都在同一个列表里。

[![Obsidian](https://img.shields.io/badge/Obsidian-v1.6.0%2B-blue.svg)](https://obsidian.md)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Crisp Suite](https://img.shields.io/badge/Crisp-Suite-orange.svg)](https://github.com/letschips)

## 能搜什么

- **笔记**：文件名、别名、所在文件夹。图片、PDF、画布等附件按文件名搜索，带扩展名的完整文件名也能搜到。
- **正文**：标题、标签、属性和正文。命中的地方显示一行摘录并高亮。
- **命令**：Obsidian 和各插件注册的命令，只列出当前能运行的；回车直接运行，右侧显示已绑定的快捷键。输入 `>` 开头只搜命令。

## 中文怎么搜

中文按相邻两个字建索引，不依赖词典，句子里任意一段都能搜到；单个字也能搜。笔记名和别名还能用拼音找：「知识库设计」可以用 `zhishiku`、`zsk`，也可以从中间的 `sheji`、`sj` 开始。

英文按单词开头匹配，`obsid` 能找到 Obsidian；拼错一两个字母（如 `launchr`）也能找到 launcher。多个词用空格分开，每个词都要命中。

## 键盘操作

| 按键 | 作用 |
| --- | --- |
| ↑ ↓ | 选择结果 |
| ↵ | 打开笔记，或运行命令 |
| ⌘↵ / ⌘⌥↵ | 在新标签页 / 右侧打开 |
| → | 正文命中多行时，列出这篇笔记里的每一行；← 或 Esc 返回 |
| ⌥↵ | 把选中的笔记作为链接插入正在编辑的笔记，选中的文字作为显示文字 |
| ⇧↵ | 用搜索词新建笔记 |
| ⌘K | 操作菜单：打开方式、复制链接、复制命令 ID；「更多操作…」打开右键菜单 |
| Esc | 关闭菜单或面板 |

在结果上右键，除了打开方式和复制链接，还有 Obsidian 文件菜单里的全部操作：在访达中显示、复制路径、收藏、移动文件等，其他插件加到文件菜单里的项也在。

Windows 上 ⌘ 对应 Ctrl。插件不设默认快捷键，在「设置 → 快捷键」里搜索「Crisp Search: 打开搜索面板」绑定一个即可。

## 排序与新建

结果分两组：笔记名命中在前，正文命中在后。组内的排序在设置页选，面板左下角的菜单按钮（三横线）里可以临时换一种：

- **相关度 + 最近修改**（默认）：按相关度排，最近改过的笔记稍微靠前，一周前的加成减半。
- **相关度**、**最近修改**、**最近创建**、**名称**。

搜索词没有对应的同名笔记时，列表末尾会有一行「新建笔记」，回车或在任意一行按 ⇧↵ 新建并打开。新建位置默认跟随 Obsidian「文件与链接」里的设置，也可以在插件设置里指定文件夹。

这个菜单里还能查看索引进度、重建索引、打开插件设置。

打开过结果的搜索词会记在「最近搜索」里，输入框为空时显示最近 3 条，⌘K 可以移除，设置页可以全部清除。

## 索引

启用后在后台分段建立索引，不卡输入；之后跟着笔记的新建、修改、改名和删除自动更新。Obsidian「文件与链接 → 排除的文件」里的路径不会进入索引；插件设置里的「排除的文件夹」可以再排除一些，改完自动重建。索引只保存在内存里，每次启动重新建立，几千篇笔记的库大约需要 10 秒；建立期间可以先搜到已完成的部分。命令面板里的「Crisp Search: 重建搜索索引」可以手动重建。

## 激活

Crisp Search 需要激活后才能搜索。未激活时面板只显示激活入口，也不会建立索引。

- 支持 Crisp Suite 全家桶授权码，在设置页「软件授权与激活」里输入。
- 库里已经激活过其他 Crisp 插件时，Crisp Search 启动后会自动继承授权。
- 授权码先在本地用内置的 Ed25519 公钥验签。激活时和每次启动后，会在后台向 `https://license.letschips.xyz/api/verify-device` 核对一次吊销状态与设备数；网络不可用、超时（2.5 秒）或服务暂不可用时，降级为本地验签，不影响使用。
- 除上述授权核对外，插件不发出任何网络请求，不收集使用数据；笔记内容只在本机内存里建索引。

## 安装

### 通过 BRAT 安装

1. 安装并启用 Obsidian42 - BRAT 插件。
2. 命令面板执行 `BRAT: Add a beta plugin for testing`。
3. 输入 `letschips/crisp-search`，添加后在「第三方插件」里启用 Crisp Search。

### 手动安装

1. 从 [Releases](https://github.com/letschips/crisp-search/releases) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放进库目录下的 `.obsidian/plugins/crisp-search/`。
3. 重启 Obsidian 或在设置里重新加载插件，然后启用 Crisp Search。

当前版本只在 macOS 桌面端测试过，manifest 声明为仅桌面端。

## 授权与许可

Crisp Search 是专有商业软件，版权归作者 letschips 所有。详细条款见 [LICENSE](LICENSE)。搜索引擎基于 [MiniSearch](https://github.com/lucaong/minisearch)（MIT），拼音转换基于 [pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT）。

- 作者主页：小红书 [@letschips](https://xhslink.cn/m/3MwtKu4822b)
- 公众号：来吃薯条儿
