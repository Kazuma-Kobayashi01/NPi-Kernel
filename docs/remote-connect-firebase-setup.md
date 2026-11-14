# NPi Remote Connect Firebase (FCM) 配置操作指南

> 适用对象：NPi Remote Connect 个人开发者（日本环境，首次配置 Firebase）。
> 目标：为已部署在东京节点（`wss://35.213.93.187/relay`，SSH 别名 `labserver-relay`）的 Go Relay 启用 **FCM HTTP v1** 后台推送唤醒，并为后续 Flutter（Android）客户端准备好应用注册配置。

---

## 目录

1. [前置准备：账号、费用与包名](#1-前置准备账号费用与包名)
2. [创建 Firebase 项目（或关联现有 GCP 项目）](#2-创建-firebase-项目或关联现有-gcp-项目)
3. [确认已启用 Firebase Cloud Messaging API (V1)](#3-确认已启用-firebase-cloud-messaging-api-v1)
4. [生成服务端凭据（推荐专用最小权限 Service Account）](#4-生成服务端凭据推荐专用最小权限-service-account)
5. [部署密钥到服务器并启用 Relay 推送](#5-部署密钥到服务器并启用-relay-推送)
6. [注册 Android 应用并获取 `google-services.json`](#6-注册-android-应用并获取-google-servicesjson)
7. [Flutter 端接入概要（不写完整代码）](#7-flutter-端接入概要不写完整代码)
8. [端到端验证与常见排错](#8-端到端验证与常见排错)
9. [完成后需要交给助手的清单](#9-完成后需要交给助手的清单)

---

## 1. 前置准备：账号、费用与包名

### 1.1 Google 账号要求
- 准备一个常用的个人 Google 账号（如 `@gmail.com`）。
- **不建议**使用公司或学校的 Google Workspace 组织账号：自 2024 年 5 月 3 日起新建的 Google Cloud 组织默认禁止下载 Service Account 私钥 JSON（详见第 4 步组织策略说明），个人 `@gmail.com` 账号无组织限制。

### 1.2 费用与计费方案结论（无需绑定信用卡）
- **Firebase Cloud Messaging (FCM) 完全免费（No-cost）**，在免费方案 **Spark plan**（无需付款方式）和按量付费方案 **Blaze plan** 中均不收费。
- **不需要升级到 Blaze 方案**，也不需要为开启推送绑定结算账号。
- 免费版 Spark plan 对单账号的限制主要在于可创建的项目总数（通常约 5–10 个，按 Google Cloud 项目配额计算），对个人开发完全够用。
- 官方依据：[Firebase Pricing](https://firebase.google.com/pricing)、[Understanding Firebase Projects（项目配额说明）](https://firebase.google.com/docs/projects/learn-more)

### 1.3 先确定 Android 包名（Application ID）
- 在注册 Firebase Android 应用前，必须先定好应用的 **Android 包名**。**已确定：`com.kazuma.npiremote`**。
- 格式要求：反向域名格式、全小写字母与数字分段，需与后续 Flutter 项目 `android/app/build.gradle`（或 `build.gradle.kts`）里的 `applicationId` **完全一致**。
- **重要**：包名区分大小写，**一旦在 Firebase 控制台注册到项目中就无法更改**（只能删掉重建或新增另一个 App 条目）。
- 官方依据：[Add Firebase to your Android project](https://firebase.google.com/docs/android/setup)

**怎么确认前置完成**：已经确定要用的个人 Google 账号；包名固定为 `com.kazuma.npiremote`。

---

## 2. 创建 Firebase 项目（或关联现有 GCP 项目）

一个 Firebase 项目本质上就是一个启用了 Firebase 服务的 Google Cloud (GCP) 项目。你可以**二选一**：
- **方式 A（推荐，独立干净）**：直接在 Firebase 创建一个全新项目（默认即免费 Spark 方案）。
- **方式 B（复用同一 GCP 项目）**：如果你希望和东京 Relay 所在的现有 GCP 项目放在一起管理，可以把 Firebase 添加到现有 GCP 项目中。注意：添加到现有 GCP 项目后**无法完全撤销**；如果该 GCP 项目已绑定结算账号，Firebase 侧也会自动显示为 Blaze 方案（但 FCM 本身仍免费）。

### 操作步骤
- **在哪里点**：打开 [Firebase 控制台](https://console.firebase.google.com/)，使用你的 Google 账号登录。
- **执行什么**：
  1. 点击 **Create a Firebase project（创建 Firebase 项目）**（若已有项目则点击 **Add project / 添加项目**）[界面可能不同]。
  2. **若选方式 A（新建项目）**：
     - 输入项目名称（例如 `npi-remote-connect`）。
     - 在输入框下方留意自动生成的 **Project ID（项目 ID）**，若想自定义可此时点击旁边的编辑图标修改——**一旦创建并初始化资源，Project ID 无法再修改**。
     - 如提示接受条款，勾选同意并继续。
  3. **若选方式 B（关联现有 GCP 项目）**：
     - 在创建页底部点击 **Add Firebase to Google Cloud project（将 Firebase 添加到 Google Cloud 项目）**[界面可能不同]，从下拉列表中选择你的现有 GCP 项目并点击 **Open project / Continue**。
  4. （可选）提示是否启用 **Gemini in Firebase** 时，按个人喜好开启或跳过。
  5. **是否开启 Google Analytics（Google 分析）的取舍**：
     - **不开启（个人自用推荐）**：Relay 仅用 FCM 推送密文唤醒，完全不依赖 Analytics；关闭后无额外埋点与数据收集，创建更快，后续随时可在 **Project settings（项目设置）> Integrations（集成）** 中补开。
     - **开启**：如果想在控制台的 **Messaging > Reports** 查看推送送达率、展示次数和打开漏斗报表，或使用 A/B 测试，才需要开启（创建时需选分析报告国家/地区，如 Japan）。
  6. 点击 **Create project（创建项目）**（或 **Add Firebase**），等待几十秒初始化完成。
- **怎么确认成功**：浏览器自动跳转到该项目首页（Project Overview），左上角项目下拉框能看到你的项目名，点击左上角齿轮图标 > **Project settings（项目设置）> General（常规）** 可以看到固定的 **Project ID** 与 **Project number**。
- 官方依据：[Understand Firebase Projects](https://firebase.google.com/docs/projects/learn-more)、[Add Firebase to an existing Google Cloud project](https://firebase.google.com/docs/projects/use-firebase-with-existing-cloud-project)

---

## 3. 确认已启用 Firebase Cloud Messaging API (V1)

我们的 Relay（`omp/relay/push.go`）直接请求 **FCM HTTP v1 API**：
`https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`，
并使用服务账号私钥签发 OAuth 2.0 短期令牌（scope：`https://www.googleapis.com/auth/firebase.messaging`）。

> **不要使用旧版 Server key（服务器密钥）**：旧版 `Cloud Messaging API (Legacy)`（HTTP / XMPP 与 Server key）已全面停用与下线，新接入一律使用 **Firebase Cloud Messaging API (V1)**。

### 操作步骤
- **在哪里点**：在 Firebase 控制台左上角点击 **⚙️（Project settings / 项目设置）** > 顶部切换到 **Cloud Messaging** 标签页（直达模板链接：`https://console.firebase.google.com/project/_/settings/cloudmessaging`）[界面可能不同]。
- **执行什么**：
  1. 查看 **Firebase Cloud Messaging API (V1)** 这一栏。
  2. 如果显示 **Disabled（已停用）**，点击右侧 `⋮` 菜单 > **Manage API in Google Cloud Console**，在跳转的 Google Cloud 页面点击 **Enable（启用）**（对应 API 为 `fcm.googleapis.com`）[界面可能不同]。
  3. 回到刚才的 **Cloud Messaging** 页面刷新，并顺手记下该页面显示的 **Sender ID**（即纯数字的 Project number，后面排错会用到）。
- **怎么确认成功**：**Firebase Cloud Messaging API (V1)** 旁边显示绿色的 **Enabled（已启用）**。
- 官方依据：[Send a message using FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[Send a message using Firebase Admin SDK](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)、[FCM deprecation & troubleshooting](https://firebase.google.com/docs/cloud-messaging/troubleshooting)

---

## 4. 生成服务端凭据（推荐专用最小权限 Service Account）

### 4.1 两种方案对比

| 对比维度 | 方案一：Firebase Admin SDK 默认服务账号 | 方案二：新建专用服务账号（**推荐**） |
|---|---|---|
| 生成位置 | Firebase 控制台 > Project settings > Service accounts | Google Cloud Console > IAM & Admin > Service Accounts |
| 账号形态 | `firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com` | 自定义，例如 `npi-relay-fcm@<project-id>.iam.gserviceaccount.com` |
| 默认权限 | 拥有 `Firebase Admin SDK Administrator Service Agent` (`roles/firebase.sdkAdminServiceAgent`)，可读写项目内 Auth、Firestore、Storage 等几乎全部服务 | **仅授予 `Firebase Cloud Messaging API Admin`（`roles/firebasecloudmessaging.admin`）** |
| 安全性 | 若密钥泄露，攻击者拿到项目级后台管理权限 | 遵循**最小权限原则**，密钥仅含 `cloudmessaging.*`、`fcmdata.deliverydata.list` 和 `resourcemanager.projects.get/list`，无任何数据库/用户权限 |

**推荐结论**：使用**方案二（新建专用服务账号）**，只授予预定义角色 **`Firebase Cloud Messaging API Admin`**（角色 ID：`roles/firebasecloudmessaging.admin`）。该角色包含 FCM HTTP v1 `messages:send` 接口唯一必需的 IAM 权限 `cloudmessaging.messages.create`。（注：Firebase 文档里 `roles/firebasenotifications.admin` 现已标记为 deprecated，不要选错成旧角色。）

- 官方依据：[Firebase Cloud Messaging roles and permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)、[Firebase Product-level predefined roles](https://firebase.google.com/docs/projects/iam/roles-predefined-product)、[FCM HTTP v1 `projects.messages.send` IAM Permissions](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send)、[Overview of Firebase service accounts](https://firebase.google.com/support/guides/service-accounts)

### 4.2 创建专用服务账号并下载 JSON 私钥
- **在哪里点**：打开 [Google Cloud Console — Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)，在顶部项目选择器中选中你刚创建的项目（Project ID 与第 2 步一致）。
- **执行什么**：
  1. 点击顶部的 **+ CREATE SERVICE ACCOUNT（创建服务账号）**[界面可能不同]。
  2. 填写 **Service account name**（例如 `npi-relay-fcm`），Service account ID 会自动生成，点击 **CREATE AND CONTINUE（创建并继续）**。
  3. 在 **Permissions / Grant this service account access to project** 这一步：
     - 搜索并选择角色：**`Firebase Cloud Messaging API Admin`**（注意不是 `Viewer`，也不是带旧字样的 `Firebase Cloud Messaging Admin`）。
     - 点击 **CONTINUE**，最后点击 **DONE**。
  4. 回到 Service Accounts 列表，点击刚创建的 `npi-relay-fcm@...` 邮箱进入详情页。
  5. 切换到顶部 **KEYS（密钥）** 标签页 > 点击 **ADD KEY（添加密钥）** > **Create new key（创建新密钥）** > 选择 **JSON** > 点击 **CREATE（创建）**[界面可能不同]。
  6. 浏览器会自动下载一个 `.json` 文件（例如 `~/Downloads/<project-id>-xxxxxxxx.json`）。
- **怎么确认成功**：
  - 本地下载目录下出现 `.json` 文件，用编辑器或 `jq`（**仅本机自己核对，不要贴到聊天里**）确认其中包含 `"type": "service_account"`、正确的 `"project_id"`、`"private_key"` 和 `"client_email"`（`omp/relay/push.go` 会读取 `project_id` 并用私钥签发 JWT）。
  - Google Cloud Console 该服务账号的 **KEYS** 列表中出现一条状态为 Active 的密钥记录。

> **组织策略提醒（若遇无法创建密钥报错）**：
> 如果步骤 5 按钮置灰或提示受限于 `iam.disableServiceAccountKeyCreation`，说明你使用的账号隶属于某 Google Cloud 组织且该组织启用了“禁止创建服务账号密钥”策略（2024 年 5 月 3 日及之后创建的组织默认强制启用）。个人开发者请改用**无组织的个人 `@gmail.com` 账号**重建项目，或联系组织管理员对当前项目配置 tag 豁免。
> 官方依据：[Create and delete service account keys](https://docs.cloud.google.com/iam/docs/keys-create-delete)、[Restrict IAM service account usage](https://docs.cloud.google.com/organization-policy/restrict-service-accounts)

### 4.3 密钥保管、轮换与紧急吊销
- **保管**：私钥 JSON 只能在创建时下载一次，等同于长期凭证。**绝对不要提交到 git 仓库**，也不要发到聊天窗口；上传到服务器后建议从 `~/Downloads/` 删除本地明文副本（或只保留在个人加密密码库中）。
- **常规轮换（官方建议至少每 90 天一次）**：
  1. 在 Google Cloud Console > Service Accounts > **KEYS** 页面新增一把新 JSON 密钥。
  2. 按第 5 步把新 JSON 覆盖部署到服务器 `/opt/npi-relay/secrets/firebase-service-account.json`，并重启容器 `ssh labserver-relay 'cd /opt/npi-relay && sudo docker compose restart npi-relay'`。
  3. 先在控制台对旧密钥点击 **Disable（禁用）**，确认 Relay 推送仍正常。
  4. 确认无误后对旧密钥点击 **Delete（删除）**（删除不可恢复）。
- **紧急吊销**：如怀疑密钥泄露，立刻在控制台 **KEYS** 页面删除该密钥；并注意官方提示——删除密钥不会立即使已签发且尚未过期的短期 OAuth 2.0 Access Token（最长约 1 小时）失效，如需立刻阻断一切访问，请在服务账号详情页**暂时禁用或删除该 Service Account**。
- 官方依据：[Service account key rotation](https://docs.cloud.google.com/iam/docs/key-rotation)、[Create and delete service account keys](https://docs.cloud.google.com/iam/docs/keys-create-delete)

---

## 5. 部署密钥到服务器并启用 Relay 推送

先理解仓库里的两个关键设计（对照 `omp/relay/compose.yaml`、`omp/relay/Dockerfile` 与 `omp/relay/deploy.sh`）：
1. **为什么不要把 JSON 放进本地仓库目录**：`omp/.gitignore` 目前**没有**忽略 `*.json` 或 `relay/secrets/`，把密钥放在本地仓库下极易误提交。密钥只需放在服务器 `/opt/npi-relay/secrets/firebase-service-account.json`，且容器内进程以 distroless nonroot 用户 `65532:65532` 运行，因此宿主机文件属主必须是 `65532:65532`、权限为 `0400`。
2. **为什么必须改本地的 `omp/relay/compose.yaml`**：`omp/relay/deploy.sh` 每次部署都会把本地仓库的 `compose.yaml` 覆盖上传到服务器 `/opt/npi-relay/compose.yaml`。如果只改服务器上的文件，下次部署会被覆盖回禁用状态。

### 操作步骤（命令可直接复制，替换 `<你的密钥文件名>.json`）
- **在哪里执行**：本机 macOS 终端（确保本机 Docker / OrbStack 已启动，因 `deploy.sh` 会在本地交叉编译 `linux/amd64` 镜像）。
- **执行什么**：

  1. **把下载的私钥 JSON 上传到服务器 `/tmp`**：
     ```bash
     scp ~/Downloads/<你的密钥文件名>.json labserver-relay:/tmp/fcm.json
     ```

  2. **在服务器上安装密钥到 `/opt/npi-relay/secrets/` 并删除 `/tmp` 临时副本**：
     ```bash
     ssh labserver-relay 'sudo install -d -m 755 /opt/npi-relay/secrets && sudo install -D -o 65532 -g 65532 -m 0400 /tmp/fcm.json /opt/npi-relay/secrets/firebase-service-account.json && rm -f /tmp/fcm.json'
     ```
     核对服务器文件权限（应显示 `-r-------- 1 65532 65532`）：
     ```bash
     ssh labserver-relay 'sudo ls -la /opt/npi-relay/secrets/firebase-service-account.json'
     ```
     确认无误后，清理本地 `~/Downloads/<你的密钥文件名>.json`（如需备份请存入加密密码管理器）。

  3. **修改本地 `omp/relay/compose.yaml`**：
     打开 `omp/relay/compose.yaml`，取消第 13 行和第 16 行的注释（去掉行首 `# `），修改后这两块如下：
     ```yaml
         environment:
           RELAY_MAX_HOSTS: "16"
           # Set once secrets/firebase-service-account.json exists (and uncomment the mount below).
           RELAY_FCM_CREDENTIALS: /run/secrets/fcm.json
         volumes:
           - npi-relay-data:/data
           - ./secrets/firebase-service-account.json:/run/secrets/fcm.json:ro
     ```

  4. **运行部署脚本**（在 `omp/relay` 目录下）：
     ```bash
     cd omp/relay && ./deploy.sh
     ```
     `deploy.sh` 会自动构建镜像、推送到 `labserver-relay`、覆盖 `/opt/npi-relay/compose.yaml`、启动容器并等待健康检查和 `https://35.213.93.187/relay/healthz` 返回 `ok`（若 60 秒未健康会自动回滚）。

  5. **查看容器日志确认推送已启用**：
     ```bash
     ssh labserver-relay 'docker logs --tail 30 npi-relay'
     ```

- **怎么确认成功**：
  - `deploy.sh` 末尾输出 `public https://35.213.93.187/relay/healthz ok`。
  - `docker logs` 输出中包含 JSON 日志 `"msg":"push enabled"`，不再出现 `RELAY_FCM_CREDENTIALS not set; push disabled`。
  - 运行 `git -C omp status` 检查未把任何 `.json` 私钥放进仓库目录。

---

## 6. 注册 Android 应用并获取 `google-services.json`

### 操作步骤
- **在哪里点**：回到 [Firebase 控制台](https://console.firebase.google.com/) > 进入你的项目 > 项目概览页点击 **Android 图标**（若已有其他应用，则进 **⚙️ Project settings > General > Your apps > Add app > Android**）[界面可能不同]。
- **执行什么**：
  1. **Android package name**：填入 `com.kazuma.npiremote`，核对大小写无误（**注册后不可更改**）。
  2. **App nickname（可选）**：例如 `NPi Remote Android`。
  3. **Debug signing certificate SHA-1（可选）**：**留空即可**。
     - 官方明确说明：SHA-1 仅在使用 Firebase Authentication（Google 登录 / 手机号登录）和 Dynamic Links 时必需；**仅使用 FCM 推送不需要填写 SHA-1**（[Android Troubleshooting & FAQ](https://firebase.google.com/docs/android/troubleshooting-faq)）。
  4. 点击 **Register app（注册应用）**。
  5. 在下一步点击 **Download google-services.json**，保存到本地安全目录（注意文件名必须是 `google-services.json`，不要保留浏览器自动重命名的 `(1)` 后缀）。
  6. 后续步骤（Add Firebase SDK）在控制台可直接点 **Next / Continue to console** 跳过，下一节按 Flutter 方式接入即可。
- **怎么确认成功**：
  - 在 **Project settings > General > Your apps** 下能看到刚注册的 Android 应用与对应的 App ID（格式 `1:<project_number>:android:<hash>`），且随时可以重新下载 `google-services.json`。

### 关于 `google-services.json` 的安全属性
- `google-services.json` **不是服务端私钥/秘密**：官方明确说明它包含的是公开的项目与客户端标识符（`project_id`、`mobilesdk_app_id`、客户端 API key 等），最终会打包进 APK 中（[Understand Firebase Projects](https://firebase.google.com/docs/projects/learn-more#config-files-objects)）。
- 它与你在控制台填写的 **Android 包名强绑定**。如果计划把手机端代码开源，官方不建议把个人项目的 `google-services.json` 提交到公开仓库（避免他人使用你的项目配置）；私有仓库或本地构建时放入 `android/app/google-services.json` 即可。

---

## 7. Flutter 端接入概要（不写完整代码）

将来新建 Flutter 客户端仓库（Android 优先，参考 `omp/docs/plan-android-remote-connect.md` §5 与 §6.3）时，按以下概要完成接入：

1. **配置接入方式（二选一，推荐方式 A）**：
   - **方式 A（官方推荐 `flutterfire configure`）**：安装 Firebase CLI 并执行 `firebase login`，再运行 `dart pub global activate flutterfire_cli`；在 Flutter 工程根目录运行 `flutterfire configure`，选中你的 Firebase 项目和 Android 平台，CLI 会自动生成 `lib/firebase_options.dart`、同步 `android/app/google-services.json` 并配置 Gradle 插件（[Add Firebase to your Flutter app](https://firebase.google.com/docs/flutter/setup?platform=android)）。
   - **方式 B（手动配置）**：直接把第 6 步下载的 `google-services.json` 放到 `android/app/google-services.json`，在项目级与 app 级 Gradle 文件添加 `com.google.gms:google-services` 插件，并按常规方式初始化 `Firebase.initializeApp()`（[Add Firebase to your Android project](https://firebase.google.com/docs/android/setup)）。

2. **引入依赖并获取 Token**：
   - 在 Flutter 工程添加 `firebase_core` 与 `firebase_messaging`（[pub.dev: firebase_messaging](https://pub.dev/packages/firebase_messaging)）。
   - 初始化 Firebase 后调用 `FirebaseMessaging.instance.getToken()` 获取注册 token，并订阅 `FirebaseMessaging.instance.onTokenRefresh` 在 token 刷新时同步更新。
   - *文档版本提示*：Firebase 最新文档已开始将 `getToken()` / `token` 标注为 deprecated 并推广基于 Firebase Installation ID（`FID`）的 `register()`/`onRegistered`，但官方同时明确两者当前完全共存支持（[Best practices for FCM registration management](https://firebase.google.com/docs/cloud-messaging/manage-tokens)）。由于我们当前的 Relay（`omp/relay/push.go`）发送请求使用 `message.token` 且接口接收 `fcmToken`，Flutter 端目前继续使用 `getToken()` / `onTokenRefresh` 即可。

3. **后台 Data-only 消息处理**：
   - 我们的 Relay **只发送 data-only 消息**（不附带 `notification` 字段，见 `omp/relay/push.go:72-74`），以便锁屏/后台时先在手机端用静态 `notification` 密钥解密 `cipherSummary` 再弹出本地通知（配合 `flutter_local_notifications`）。
   - 前台监听 `FirebaseMessaging.onMessage`；后台/杀进程监听 `FirebaseMessaging.onBackgroundMessage(_handler)`。
   - Android 后台消息会启动独立 Dart Isolate，处理函数**必须是顶层函数**（不能是匿名函数或类实例方法）、必须加 **`@pragma('vm:entry-point')`** 注解以防 Release 构建被裁剪，函数体开头需先 `await Firebase.initializeApp()`，并尽快（30 秒内）完成解密与本地通知展示（[Receive messages in a Flutter app](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages)）。

4. **Android 13+ 运行时通知权限**：
   - `firebase_messaging` 会自动向 Manifest 合并 `android.permission.POST_NOTIFICATIONS`，但在 Android 13（API 33）及更高版本上，App 必须显式调用 `FirebaseMessaging.instance.requestPermission(...)` 请求用户授权后才能弹出通知（[FCM Android Setup](https://firebase.google.com/docs/cloud-messaging/android/get-started)、[FCM Flutter Receive Messages](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages)）。
   - 同时按 `omp/docs/plan-android-remote-connect.md` §5 要求，在 `AndroidManifest.xml` 中禁用敏感配对数据的自动备份（如 `android:allowBackup="false"` 或排除备份规则），防止备份恢复后双设备冲突触发 FCM 404。

5. **运行环境（真机与模拟器）要求**：
   - 需要 Android 7.0（API 24）及以上设备；**如果用 Android 模拟器调试推送，必须选择带有 Google Play 的系统镜像**（官方原文：*Emulators must use an emulator image with Google Play*，[Flutter Firebase Setup](https://firebase.google.com/docs/flutter/setup?platform=android)）。

6. **把 Token 上报给我们的 Relay**：
   - App 配对拿到 `deviceToken` 并取得 `fcmToken` 后（以及每次 `onTokenRefresh` 时），调用 Relay 接口（对照 `omp/relay/README.md` 与 `omp/relay/server.go:632-663`）：
     - **接口**：`POST https://35.213.93.187/relay/api/devices/fcm-token`
     - **请求头**：
       - `Authorization: Bearer <deviceToken>`
       - `Content-Type: application/json`
     - **请求体**：
       ```json
       {
         "hostId": "<hostId>",
         "deviceId": "<deviceId>",
         "fcmToken": "<fcmToken>"
       }
       ```
       （当 `fcmToken` 传 `""` 空字符串时，表示主动清除服务器保存的该设备 token。）
     - **返回值**：成功为 **`204 No Content`**；Bearer 鉴权失败或设备已吊销为 `401`；字段格式不符合（如 `hostId`/`deviceId` 非 `[A-Za-z0-9_-]{8,64}` 或 token 超过 4096 字节）为 `400`。

---

## 8. 端到端验证与常见排错

### 8.1 用 Firebase 控制台发测试消息的局限
- 在 Firebase 控制台 **Messaging > Notifications composer** 点击 **Send test message** 输入 token 发送的，是 **Notification message**（带预设 `notification` 载荷，且无法替代 Relay 的 `cipherSummary` 加密 data 载荷）。
- 当 App 处于后台时，控制台发出的 Notification message 会由系统直接把文本放进通知栏，**不会走**纯 data 消息的后台解密处理路径；因此它**只能用来粗略验证“设备已连上 Google Play/FCM 且 token 有效”**。
- **真正的端到端验证**：需在 Flutter 客户端接入后，完成扫码配对并通过 `POST /api/devices/fcm-token` 注册 token（返回 `204`），然后把 App 切到后台或锁屏，在宿主机触发需要审批的工具调用（`pushHint` 为 `approval` 或 `ask`），等待 `RELAY_PUSH_ACK_TIMEOUT`（默认 2 秒）超时后由 Relay 真实发出 FCM data-only 消息，确认手机 3 秒左右弹出本地解密通知。
- 官方依据：[About FCM messages（Notification vs Data）](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type)

### 8.2 解读 Relay 日志（`ssh labserver-relay 'docker logs --tail 100 npi-relay'`）
对照 `omp/relay/server.go:620-627` 与 `omp/relay/push.go:97-116`：

| 日志 `"msg"` 字段 | 含义与 Relay 行为 |
|---|---|
| `push enabled` | Relay 启动成功读取了 `/run/secrets/fcm.json` 中的 `project_id` 与私钥，推送通道就绪。 |
| `fcm token rejected; clearing` | FCM 返回 **HTTP 404**，或 **HTTP 400** 且错误内容表明 token 无效（`errorCode == "UNREGISTERED"` 或错误消息包含 `"registration token"`）。Relay **已自动从 SQLite 清空**该设备的 `fcm_token`，等待 App 重新注册新 token。 |
| `fcm send failed` | 其他发送失败（如 HTTP 403、非无效 token 类的 HTTP 400、或 429/5xx 退避重试 3 次后仍失败）。Relay **保留**现有 token，需查看同条日志中的 `"err"` 字段排查。 |

### 8.3 常见错误码与排查（对照 [FCM v1 ErrorCode](https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode)）

| HTTP 状态 / 错误码 | 常见原因 | 排查与处理 |
|---|---|---|
| **`403` (`PERMISSION_DENIED`)** | 1. 专用 Service Account 没授予 `roles/firebasecloudmessaging.admin`；<br>2. Firebase 项目未启用 **Firebase Cloud Messaging API (V1)**（`fcm.googleapis.com`）。 | 回第 3 步确认 API 已启用；回第 4 步在 GCP IAM 页核对服务账号角色并等待权限生效（IAM 变更通常需数分钟传播）。 |
| **`403` (`SENDER_ID_MISMATCH`)** | 服务端上传的私钥 JSON 所属项目，与客户端 `google-services.json` 生成 token 时所属项目**不是同一个**。 | 核对服务账号 JSON 里的 `project_id` 与 Firebase 控制台下载 `google-services.json` 的项目是否一致（Sender ID 应为同一个 Project number）。 |
| **`404` (`UNREGISTERED`)** | 手机端卸载重装 App、清除了应用数据、token 过期轮换，或系统备份恢复导致实例冲突。 | Relay 会自动清理旧 token（日志 `fcm token rejected; clearing`）；重新打开 App 触发获取新 token 并调 `POST /api/devices/fcm-token`。 |
| **`400` (`INVALID_ARGUMENT`)** | 客户端传给 Relay 的 `fcmToken` 被截断、含多余空格/换行，或测试载荷非法。 | 检查客户端上报 `fcmToken` 时是否完整透传了 `getToken()` 返回值。 |

### 8.4 日本网络与国内网络差异（简述）
- **日本环境（当前主链路）**：你的手机和东京 Relay 均位于日本，Google FCM 基础设施与东京 `asia-northeast1` 机房直连互通（客户端通过 TCP `5228`/`5229`/`5230` 维持长连接，Relay 通过 HTTPS 出站访问 `fcm.googleapis.com`），无需国内厂商推送通道或额外代理，延迟极低（[FCM Network Configuration](https://firebase.google.com/docs/cloud-messaging/troubleshooting)）。
- **中国大陆网络环境（若日后跨境测试）**：大陆直连网络通常无法稳定连接 Google Play 服务与 FCM 端口 `5228–5230`；若设备未接入可用代理，推送无法送达属于网络连通性问题，而非本配置出错。

---

## 9. 完成后需要交给助手的清单

当你按上述步骤操作完毕后，把下面 **4 项信息**发给助手，即可继续推进 Flutter Android 客户端实现与真机联调：

- [x] **最终确定的 Android 包名（Application ID）**：`com.kazuma.npiremote`（已定，无需再提供）
- [ ] **Firebase Project ID**（可选附纯数字的 Sender ID / Project number）
- [ ] **`google-services.json` 的本地存放位置**（例如 `~/Downloads/google-services.json` 或后续放到新 Flutter 仓库的 `android/app/google-services.json`；无需把文件全文贴到聊天里）
- [ ] **服务器推送启用确认**：确认以下三点已完成——
  1. 服务器 `/opt/npi-relay/secrets/firebase-service-account.json` 已就位（属主 `65532:65532`，权限 `0400`）
  2. 本地 `omp/relay/compose.yaml` 已取消注释并通过 `./deploy.sh` 部署
  3. `ssh labserver-relay 'docker logs --tail 30 npi-relay'` 已看到 `"msg":"push enabled"`
  > **安全提醒：请勿在聊天记录中粘贴任何 Service Account 私钥 JSON 的原文或 `private_key` 内容。**
