# NPi CLI Linux 适配计划（x64 优先／Ubuntu 22.04 LTS 基线／deb）

- 日期：2026-11-08
- 维护仓库：NPi-Kernel（`omp/` 独立仓库）
- 规划基线分支：`kernel.2.0.10-universal`
- 状态：计划文档；适配尚未实施，本轮仅将计划保存为 Markdown。

## 分发形式变更（2026-11-08，用户决定）

首批 Linux x64 交付由 `deb` 改为**单个自解压 `.run` 安装器**（`scripts/build-linux-run.ts` → `dist/run/npi-<version>-linux-x64.run`＋`.sha256`），原因是面向大陆同学分发时需要免 root、并把 Chrome for Testing 随包提供。因此：

- 下文各处“deb／APT／dpkg”均已被本节取代；`scripts/build-linux-deb.ts` 已删除，不再发 deb，APT／dpkg 不再负责安装、升级和卸载。
- `.run` 安装到 `~/.local/opt/npi`（`--prefix` 可改），链接 `~/.local/bin/npi`（`--bin-dir` 可改）；重新运行即原位升级，`--uninstall` 或 `<prefix>/uninstall.sh` 卸载，`~/.local/share/npi` 与 `~/.cache/npi` 永远保留。载荷含二进制、Python 运行时（`lib/npi`）和 Chrome for Testing 150.0.7871.24（`lib/npi/chrome-linux64`，固定 SHA-256，须与 puppeteer-core 的 `PUPPETEER_REVISIONS.chrome` 一致）。安装前校验载荷 SHA-256，损坏或截断的文件被拒绝且不留残留。
- Chrome 的 15 个系统库无法在免 root 安装器里安装；安装结束时用 `ldd` 检测，缺失则打印 `sudo apt install …` 命令。
- `npi update` 在 Linux 提示“新版本以新的 .run 安装器发布，重新运行即升级”。
- Chrome for Testing 的再分发受 Google 使用条款约束，仅适合小范围分发，不适合公开发布；公开发布前需另行评估许可。
- Linux 登录不启动任何浏览器：仅 Perplexity 提供浏览器 SSO，Linux 上该入口已取消，直接走邮箱验证码；已在 MateBook 上验证选择 Perplexity 后直接出现邮箱输入框且无 Chrome 进程。OAuth 授权页仍按原规则用 xdg-open 打开并同时打印链接。
- 体积：约 358 MB（二进制 287 MB、Python 84 MB、Chrome 187 MB 压缩后合并）。
- 验证（MateBook，真实 x64，Ubuntu 24.04，独立 prefix）：安装、`--version`、Python 工具、浏览器工具（使用随包 Chrome，未触发下载）、原位重装、卸载、截断文件被校验拒绝均通过。

## 1. 目标与范围

交付可独立运行的 Linux CLI，复用现有内核和终端界面，不要求安装 NPi Desktop，不复制一套 Linux 专用 CLI 实现。先完成 x64 的完整适配与 deb 交付，再推进 arm64；arm64 不作为首批 x64 发布的前置条件。

### 支持范围

| 项目 | 范围 |
| --- | --- |
| CPU 架构 | 首阶段 x86_64（x64，对应 deb 的 `amd64`）；后续 aarch64（arm64，对应 deb 的 `arm64`） |
| 系统基线 | Ubuntu 22.04 LTS（Jammy）这一代的用户态与系统依赖，以 Ubuntu 22.04 LTS 作为最低支持与首要验收基线 |
| 包格式 | 仅提供 `.deb`，由 APT／dpkg 管理安装、升级和卸载 |
| 运行方式 | 本地终端、SSH、tmux |
| 主工作界面 | 对话与输入区、Common／Wide、右侧信息栏、设置和命令菜单 |
| Agent 功能 | 模型调用、文件工具、bash／PTY、审批、子 Agent、停止、会话持久化与恢复 |
| 配置与认证 | NPi 配置、profile、模型角色、订阅登录与认证持久化 |
| 扩展工具 | 独立 Python 运行与环境管理、浏览器工具 |

### 不在本次范围

- Alpine／musl。
- RPM、AppImage、Snap、Flatpak、独立二进制或 tar 包等其他发布格式；构建中间二进制不作为用户安装入口。
- 比 Ubuntu 22.04 LTS 更旧的系统兼容；不因同用 deb 就默认承诺所有 Debian／Ubuntu 衍生发行版可用。
- Linux Desktop GUI、托盘、全局快捷键、桌面电脑控制。
- macOS 专属系统服务与 Apple 专属模型。
- Bot Gateway、服务端部署或远程访问协议改造。
- 自动同步不同机器之间的配置和登录凭据。

## 2. 已核实的基础与验证边界

### 现有代码基础

- [本地内核构建脚本](../packages/coding-agent/scripts/build-binary.ts)已定义 `linux-x64`、`linux-arm64` 目标；x64 使用 Bun baseline 目标。
- [发布构建脚本](../scripts/ci-release-build-binaries.ts)包含 Linux 双架构目标，但产物命名仍有上游 OMP 遗留。
- 原生模块加载器已有 Linux 平台及 x64 baseline／modern 选择逻辑；本地已有 Linux x64 两套原生模块。
- 现有 Linux x64 二进制生成于 2026-11-01，不代表最新源码或本次 Wide 档位已经完成 Linux 验收。
- CLI 已有 Linux/XDG 路径处理、终端登录、Linux 浏览器查找，以及 Wayland／X11／OSC 52 相关剪贴板路径。

### 本机 OrbStack 状态

本次只读检查结果：

- OrbStack 已安装且正在运行。
- Docker 服务报告为 `linux/arm64`，版本 `29.8.2`。
- `orb list --format json` 返回空列表；Docker 容器列表为空。
- 未创建 Linux machine、容器或安装依赖，未读取真实凭据。

以上是检查时的环境快照，实施前应重新检查，不当作永久状态。

### 尚未证明的事项

- 当前源码在 Ubuntu 22.04 LTS x64 上的完整运行结果，以及后续 arm64 的对应结果。
- 独立 CLI 的托管 Python 全链路。
- 无桌面环境中的真实订阅 OAuth 完成与刷新。
- 真实 x64 CPU 上的兼容性和性能。
- NPi deb 安装、升级、卸载及依赖声明的完整闭环。

## 3. 实施原则

1. 全部适配代码、Linux 构建／安装脚本与文档维护在 `omp/`，不修改 Desktop 根仓库来承载 Linux 适配。
2. 平台差异集中在现有构建、运行时解析和平台分支中；不复制 Agent、TUI 或工具实现。
3. 修改、删除、重构和构建前确认目标分支；不擅自提交或推送。
4. 使用隔离 HOME、配置、缓存与工作目录，不读写真实凭据或日常会话。
5. Rust 操作继续使用 DevStore 管理的环境；不在容器另装独立 rustup 绕过该约束。
6. 原生模块优先复用同版本产物；缺失时通过符合 DevStore 约束的构建链路补齐。容器主要承担运行与验收。
7. 定向验证实际行为，不反复运行低收益全量测试。
8. 不替换当前运行的 macOS 应用或内核，不把跨平台适配变成现有功能裁剪。
9. 构建产物和随包运行时不能要求比 Ubuntu 22.04 LTS 更新的 glibc／系统库；在干净的 22.04 LTS 环境检查依赖，不能只在较新系统通过就认定满足基线。
10. Linux 用户交付仅走 deb，包拥有的程序与资源由 APT／dpkg 管理；不得由内置自更新直接覆盖包管理器拥有的文件。

## 4. 实施阶段

### 阶段一：隔离验证环境

- [ ] 检查 OrbStack、Docker 和现有环境，先建立隔离的 Ubuntu 22.04 LTS amd64 仿真运行环境；arm64 环境在后续阶段准备。
- [ ] 建立临时 HOME、NPi 配置、缓存和测试工作目录。
- [ ] 准备本地确定性模型端点与合成认证信息，不调用付费模型。
- [ ] 提供可重复的 x64 运行入口，记录发行版、架构、libc 与仿真情况，并准备真实 x64 的发布前检查环境。

**完成标准：** Ubuntu 22.04 LTS x64 有明确的运行入口，验证不接触真实凭据和日常会话。OrbStack 仿真结果必须标明仿真，不能写成真实 x64 硬件验收；不以 arm64 先跑通代替 x64 验收。

### 阶段二：x64 构建与基线兼容

- [ ] 先沿用 `linux-x64` 编译目标，使用 x64 baseline 并统一 NPi 产物命名；暂不要求同步完成 arm64 产物。
- [ ] 核对原生模块版本、架构、CPU 档位与构建输入。
- [ ] 补齐缺失的同版本原生模块，确认运行时可提取和加载。
- [ ] 在 Ubuntu 22.04 LTS 中检查主程序、原生模块和随包运行时的动态库依赖，记录实际兼容性要求，不能引入更新系统库的硬性依赖。
- [ ] 在目标环境运行启动握手、worker 和实际原生工具探针。

**完成标准：** x64 能在 Ubuntu 22.04 LTS 上启动并执行真实原生能力，不能只通过 `--version`。用户安装 deb 不应需要 Rust 或完整源码构建环境；独立二进制仅是后续组装 deb 的中间产物。

### 阶段三：独立运行补齐

- [x] 排查 CLI 启动和工具执行中对 Desktop 宿主、macOS 路径或系统服务的必要依赖。（以实际运行为准：干净 22.04 VM 中启动、全部原生能力、Python、浏览器均无需 Desktop；唯一缺口 Python 宿主已补齐，浏览器需要系统库，已记录。`login1 Inhibit` 电源断言在无权限时仅 warn，不影响运行。）
- [x] 确定并实现独立 Linux Python 运行时方案，覆盖执行、环境健康检查、包查询和经审批的包安装。（已选“随 deb 附带 python-build-standalone”；`npi --npi-python-host` 由 `src/eval/py/linux-host.ts` 实现，运行时包由 `scripts/build-linux-python-runtime.ts` 构建。Ubuntu 22.04 amd64 仿真 VM 中已实测 `python` 工具 environment/execute/packages list、`eval` Python、`packages install`（six）；deb 内资源安放尚未做。）
- [x] 区分托管 Python 环境与用户显式配置的解释器，不静默混用。（宿主已配置时无系统解释器回退；沿用 `python.interpreter` 显式配置规则。）
- [x] 验证 Chromium 解析、启动、页面操作和关闭；记录必要系统依赖与无图形环境要求。（无系统 Chromium 时首次使用下载 Chrome for Testing 150；干净 22.04 缺少 libnss3、libnspr4、libatk1.0-0、libatk-bridge2.0-0、libcups2、libxkbcommon0、libasound2、libgbm1、libcairo2、libpango-1.0-0、libxcomposite1、libxdamage1、libxfixes3、libxrandr2、libatspi2.0-0，导致浏览器守护进程启动失败；安装后 `eval` js 的 `browser.open/title/evaluate/close` 在无图形 VM 中通过。deb 需声明这些依赖。）
- [x] 验证 Linux 路径、profile、缓存和配置解析，不意外切换存储目录。（配置/会话/日志在 `~/.local/share/npi/{agent,logs,run}`，缓存在 `~/.cache/npi`，托管 Python 在 `~/.local/share/npi/env`；未生成 `~/.omp`。）

**完成标准：** 无需安装 Desktop；Python 与浏览器工具实际可用，而非仅注册工具或展示入口。

### 阶段四：x64 Linux 交互与 Agent 验收

- [x] 验证中文输入、字符宽度、颜色、终端缩放、Common／Wide 和右侧信息栏。（tmux 120/80/200 列：≥116 列显示右侧栏，80 列收起并出现状态行，200 列居中；中文输入与回复显示正常。）
- [x] 验证设置／命令菜单、键盘交互、停止与退出后的终端状态恢复。（`/` 菜单、`/settings` 外观页、Esc 取消运行中的工具、双 Ctrl+C 退出；退出后 alt screen/鼠标模式已关闭，工作进程无残留。）
- [x] 验证读取、搜索、编辑、写入、bash／PTY 和工作目录处理。（脚本化确定性模型端点 `scripts/mock-model-server.ts` 驱动真实工具；TUI 中 PTY 为真实 `/dev/pts/*`，超时转后台。）
- [x] 验证原生审批、拒绝、取消及错误展示，保留现有权限边界。（`--approval-mode always-ask`：批准后文件落盘，拒绝后显示 `Tool call denied by user`。）
- [x] 验证子 Agent 启动、进度、结果、取消及进程清理。（`task` 子 Agent 写入文件并以后台任务汇报；退出后无残留进程。）
- [x] 验证会话保存、重启恢复与历史切换。（`-p` 后 `-c` 续写同一会话文件，两条用户消息；历史切换界面未单独覆盖。）
- [x] 覆盖 SSH／tmux 的使用方式，以及可用的文本复制路径；区分远端剪贴板与本地终端剪贴板。（tmux 内 `/copy` 经 OSC 52 写入 tmux 缓冲区；未配置真实 SSH 服务端，SSH 链路只覆盖到 OSC 52 转发的前提。）

**完成标准：** Ubuntu 22.04 LTS x64 上的真实工具操作、子 Agent 与历史恢复均正常；不能用模拟成功响应代替实际执行结果。

### 阶段五：x64 订阅、deb 安装与首批发布

- [x] 按认证方式区分浏览器行为：仅 OAuth 订阅授权流程（如 Codex、Claude、Antigravity）允许自动打开授权页面；API Key 等所有非 OAuth 认证方式不自动打开官网、控制台、购订阅或密钥申请页面，只提供输入提示与可手动打开的链接。同一提供商存在多种认证方式时，以本次选择的认证方式判断，不按提供商名称统一放行。（VM 内放置记录型 `xdg-open`：`npi login deepseek` 零次调用，只展示可手动打开的链接；`npi login openai-codex` 调用一次，同时打印授权 URL。）
- [x] 验证 API Key 输入，以及 OAuth 中适用的设备码和手动回调路径；无桌面／SSH 场景保留授权链接与操作提示，不仅依赖 `xdg-open` 自动启动浏览器。（OAuth 流程输出 URL、本机快捷链接和 `Paste the authorization code (or full redirect URL)` 手动路径；设备码流程未覆盖。）
- [ ] 核对认证存储和刷新逻辑；真实 OAuth 与订阅请求单列验收，经明确授权后执行。
- [x] 统一 deb 包名、版本、`Architecture: amd64`、依赖声明，以及 CLI 入口和随包资源的归属。（`scripts/build-linux-deb.ts`：包名 `npi`、版本取 `NPI_VERSION`、`/usr/bin/npi`、`/usr/lib/npi` 放 Python 运行时归档与清单；Depends `libc6 (>= 2.17)`、`tar`、`ca-certificates`，Recommends `git` 与 15 个 Chromium 系统库。）
- [x] 将安装／升级路径收敛到 NPi deb，通过 APT／dpkg 安装、升级和卸载；移除会获取上游 OMP 或直接替换包拥有文件的更新路径。（`npi update` 不再有自更新，Linux 上提示经 deb 升级；未改动继承的 `install.sh`／`build-service.ts`，它们不在 NPi 路径上，但文件仍在仓库中。）
- [x] 在干净的 Ubuntu 22.04 LTS 环境验证 deb 首次安装、依赖解析、升级、卸载、校验失败和配置／会话保留行为，明确清理用户数据的边界。（全新 amd64 VM：`sha256sum -c` 通过，`apt install ./npi.deb` 解析依赖并安装；从 `/usr/lib/npi` 供给 Python 和浏览器；升级 2.0.10→2.0.11 后会话、配置、托管 Python 保留；截断的 deb 被 dpkg 拒绝且已装版本不变；`apt remove` 删除 `/usr/bin/npi` 与 `/usr/lib/npi`，`~/.local/share/npi` 保留；重装后无需重新解压运行时。）
- [x] 生成 `npi_<version>_amd64.deb`、SHA-256 校验文件、依赖说明与 x64 验收记录。（`omp/dist/deb/npi_2.0.10_amd64.deb`，358,191,168 字节，SHA-256 `dfe55a331a303c65152ba2b2ca22b518b569609a9590e8745d4b0db9c554333e (.run)`；验收均在 OrbStack Rosetta 仿真 VM 完成。）
- [ ] 发布前完成真实 x64 硬件检查；确认构建及安装过程不依赖 arm64 首先完成。

**完成标准：** 用户能在 Ubuntu 22.04 LTS x64 上安装 NPi deb 并完成正常使用、升级和卸载；不会更新成上游非定制内核，也不会在普通升级或卸载时丢失配置和会话。首批交付仅为 amd64 deb。

### 阶段六：后续 arm64 适配与 deb 交付

- [ ] 在 x64 首批适配与验收完成后，准备 Ubuntu 22.04 LTS arm64 原生环境。
- [ ] 补齐同版本 arm64 原生模块和运行时，复用 x64 已确定的配置、Python、订阅和打包设计。
- [ ] 逐项执行同一验收清单，生成 `npi_<version>_arm64.deb`，不得用 arm64 通过结果回填 x64 验收。

**完成标准：** arm64 同样满足 Ubuntu 22.04 LTS 这一代基线，并以 deb 独立交付；不要求重新实现或复制 x64 的通用功能。

## 5. 重点设计项与风险

### Python 独立宿主

当前专用 `python` 工具依赖 `NPI_PYTHON_HOST`；运行时安装、环境和包管理主要由 Desktop 宿主承担。这是独立 Linux CLI 的主要功能缺口。

推荐在 `omp/` 内提供独立 Linux 运行时宿主，复用现有管理协议和审批边界。实现方式在阶段三前核定；不能把静默退回系统 Python 当作托管环境适配完成。`eval` 的 Python 路径与专用 `python` 工具必须分别验收。

### 登录与浏览器跳转

仅 OAuth 订阅登录可以为完成授权自动打开浏览器（如 Codex、Claude、Antigravity 的对应 OAuth 流程）。其他认证方式均不得自动打开对应官网或控制台；进入登录、选择提供商、输入或保存 API Key 时，不触发浏览器跳转。需要申请密钥或查看说明时，展示链接，由用户主动打开。

该规则按实际认证方式执行，不把“订阅产品”或提供商名称本身作为 OAuth 判据。验收覆盖非 OAuth 登录全程零自动浏览器调用、OAuth 授权入口保留，以及无桌面／SSH 下手动完成授权的路径；使用隔离配置和合成凭据，真实订阅授权仍需单独授权验收。

### 安装与更新来源

现有安装脚本仍有 `omp` 程序名，上游默认更新来源为 `build.stencil.so` 的 `omp` 产品。正式交付前切换为 NPi deb 安装与升级流程；不能只重命名二进制而保留原更新目标，也不能由内置自更新绕过 APT／dpkg 直接覆盖已安装程序。首批可通过本地 deb 安装／升级，不将搭建 APT 仓库作为首包前置条件；下载渠道和是否提供 APT 仓库另行确定，但不新增其他包格式。

### x64 仿真与硬件覆盖

OrbStack 上的 amd64 仿真可验证启动与功能，但不能证明真实 x64 的 CPU 指令兼容性或性能。正式发布前补充真实 x64 环境检查，重点验证 baseline 路径与原生模块选择；不能仅凭 modern 产物运行成功认定老 CPU 可用。

### Linux 环境组合

以 Ubuntu 22.04 LTS 这一代的 glibc 与系统依赖为基线，终端能力、SSH／tmux、Chromium 依赖和无桌面认证是主要兼容性风险。更高 Ubuntu 版本的兼容性须按实际覆盖记录；不因都支持 deb 就默认覆盖 Debian 或所有 Linux 发行版。

## 6. 最终验收清单

| 验收项 | x64：首批，Ubuntu 22.04 LTS | arm64：后续，同代基线 |
| --- | --- | --- |
| deb 安装、依赖解析、启动、原生模块加载 | 仿真通过 | 后续验证 |
| 模型请求与配置认证解析 | 仿真通过（确定性本地端点） | 后续验证 |
| 文件工具、bash／PTY、审批 | 仿真通过 | 后续验证 |
| 子 Agent、取消和进程清理 | 仿真通过 | 后续验证 |
| 会话保存、重启和历史恢复 | 仿真通过（历史切换界面未覆盖） | 后续验证 |
| Common／Wide、中文、缩放与退出恢复 | 仿真通过（Common／Wide 切换未单独覆盖） | 后续验证 |
| 独立 Python 执行与环境／包管理 | 仿真通过 | 后续验证 |
| 浏览器工具 | 仿真通过（依赖 Recommends 的系统库与首次联网下载） | 后续验证 |
| SSH／tmux 使用方式 | tmux＋OSC 52 通过；真实 SSH 未覆盖 | 后续验证 |
| 非 OAuth 登录不自动打开网站；OAuth 授权跳转与手动路径 | 仿真通过 | 后续验证 |
| 真实订阅登录及刷新 | 待授权验收 | 后续授权验收 |
| deb 升级、卸载、校验失败和用户数据保留 | 仿真通过 | 后续验证 |

补充要求：x64 的验收记录区分仿真与真实硬件；macOS 共享路径做最小定向回归，确保没有为 Linux 引入现有功能退化。

## 7. 交付物

- 首批：`npi-<version>-linux-x64.run`（见“分发形式变更”），放在根目录 `dist/kernel.<version>-linux-x64/`。
- 后续：`npi-<version>-linux-arm64.run`，保持同代系统基线。
- deb 包含程序及必需运行时资源，并声明必要的系统依赖；不另发独立二进制或 tar 包作为安装方式。
- 每个 deb 对应的 SHA-256 校验文件，以及基于 APT／dpkg 的安装、升级和卸载说明。
- 分架构验收记录，明确基线系统、libc、终端、仿真／真实硬件及未覆盖项；首批记录只要求 x64 完整闭环。
- 现有 macOS 应用和内核保持不被擅自替换。

## 8. 推荐执行顺序

Ubuntu 22.04 LTS x64 隔离环境 → x64 构建与独立 Python → x64 交互、订阅及真实硬件验收 → amd64 deb 安装／升级／卸载验收与首批交付 → 后续 Ubuntu 22.04 LTS arm64 适配与 arm64 deb 交付。

## 9. 真实 x64 硬件检查（华为 MateBook，Ubuntu 24.04.4，i7-13700H，glibc 2.39）

经 SSH 在隔离 HOME（`~/npi-test/home`）中运行，未使用 sudo，未安装系统包，未触及该机器的真实配置：

- 主程序与 `modern` 原生模块加载并执行；`PI_NATIVE_VARIANT=baseline` 时 `baseline` 模块同样加载并执行（该机有 AVX2，默认选 modern）。
- 工具：read、write、edit、grep、glob、bash 实测通过；TUI 内 PTY 为真实 `/dev/pts/1`。
- Python：运行时从 `<exe>/../lib/npi` 解压并执行（`dpkg-deb -x` 展开的 deb 载荷同样通过）。
- TUI（经 pty＋pyte 渲染）：中文输入、`/settings`、80／120／200 列缩放、Esc 取消、双 Ctrl+C 退出、无残留进程；`--approval-mode always-ask` 下批准写入、拒绝 bash。
- 浏览器：该机无法在合理时间内下载 Chrome for Testing（约 20 MB／4 分钟，命令超时）；从 Mac 下载并拷入缓存后，`browser.open/title/close` 通过，系统库齐全。**中国大陆网络下首次浏览器使用可能极慢，需要镜像、预置或随包提供 Chromium。**
- 未覆盖：该机 deb 的 `apt install`（需要 root，未经授权不安装）；Ubuntu 22.04 基线的真实硬件；subagent 在真实硬件上的完整运行（仅验证到审批提示）。

## 10. 当前进度（Ubuntu 22.04 amd64，OrbStack Rosetta 仿真 VM）

阶段一至五除下列项目外均已在仿真环境验收；所有结果均**不是**真实 x64 硬件验收（CPU 为 VirtualApple，无 AVX2，选中的是 baseline 原生模块）。

未完成或未覆盖：真实 x64 硬件检查；真实订阅 OAuth 与令牌刷新（需明确授权）；OAuth 设备码流程；真实 SSH 链路；历史切换界面与 Common／Wide 切换的单独验证；继承的 `scripts/install.sh`、`build-service.ts` 仍保留上游默认值但不在 NPi 的 deb 路径上；Debian 12／Ubuntu 24.04 未覆盖；arm64（阶段六）未开始。

可重复入口：`bun scripts/build-linux-python-runtime.ts x64`、`bun scripts/build-linux-run.ts`（先执行 `CROSS_TARGET=linux-x64` 构建二进制）、`bun scripts/mock-model-server.ts <scenario.json>`（本地确定性模型端点，VM 内经 `host.internal` 访问）。
