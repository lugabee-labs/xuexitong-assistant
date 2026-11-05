# 小雅平台适配（河南中医药大学实例）

> 调研时间：2026-11-05
> 目标：`https://hactcm.ai-augmented.com/app/jx-web/`
> 证据来源：平台 JS bundle 静态分析 + 登录后真实 DOM 探测（CDP 接管已登录 Edge）

---

## 0. 这是什么平台

**小雅**（华中师范大学出品，各校私有部署）。与超星是**两套完全不同的技术栈**：

| | 超星 | 小雅 |
|---|---|---|
| 前端 | 老式多 iframe | React SPA（Vite 构建） |
| 播放器 | video.js + `ans.VideoJs` | **AliPlayer**（底层仍是原生 `<video>`） |
| 进度上报 | `multimedia/log` 60s 心跳 + `isdrag` | `/vod/duration/{id}/v2` 每 30s |
| 反爬设计 | **字体混淆**（font-cxsecret） | **操作活跃度检测**（1 小时无操作就停） |
| 签名 | `enc` 参数 | `SignatureHelper`（message+nonce+timestamp） |

**结论**：不需要字体解码（无字体混淆），但需要处理"操作活跃度"。

---

## 1. 学习时长心跳（bundle 逆向）

```js
// learningRecorderSaga
antiCheatLen = backendName === "testing" ? 5*60 : 60*60;   // 生产环境 3600 秒

for (;;) {
  yield delay(10000);                          // 每 10 秒检查

  const 超时 = (now - userOperateObj.lastAt) / 1000 > antiCheatLen;

  if (inOneCourse) {
    if (超时) {
      if (学生) {
        stopAllMedia();                        // 停掉所有媒体
        XyModalV2.asyncInfo({ title:'提醒', content:'长时间未操作', okText:'继续学习' });
        userOperateObj.lastAt = now;
        // 本次学习时长不记录
      }
    } else {
      // 正常上报
      SignatureHelper.createSignature({ message, nonce, timestamp });
      POST ${resourceUrl}/learnLength/learnRecord
      // body: { user_id, group_id, clientType:1, roleType, resourceId }
    }
  }
  yield delay(50000);                          // 再等 50 秒
}
```

**关键**：`antiCheatLen = 3600 秒`（1 小时）。只要每小时内产生一次真实操作就能持续记录。

## 2. 视频时长上报

```js
handleTimeUpdate = (e) => {
  if (player && !player.paused && !player.seeking) {
    const t = player.currentTime;
    if (t - watched_duration_buf > 30) {
      watched_duration_buf = t;
      recordPlayDuration(round(watched_duration, 2));
    }
  }
};

recordPlayDuration = async () => {
  const url = `${resourceUrl}/vod/duration/${oe}/v2`;
  const body = { played: player.currentTime, media_type: 2, duration, watched_duration };
  const sig = SignatureHelper.createSignature({ message: JSON.stringify(body), nonce, timestamp });
  await xyApiPost(url, sig);
  watched_duration = 0;
};
```

**关键**：`!player.seeking` —— **拖拽进度条期间的时长不计入**。

## 3. API 端点

```js
statUrl       : /api/jx-stat
lrsFrontUrl   : /api/jx-lrs
resourceUrl   : /api/jx-iresource
outerResource : /api/jx-oresource
iCourseUrl    : /api/jx-icourse
pyDocUrl      : /api/jx-pydoc
```

---

## 4. DOM 结构（实测）

### 4.1 页面分三列

```
左侧：全局导航 ul.ant-menu.menu_v2（课程内容/作业任务/学情/画像/概况/公告）
中间：资源列 div.group-resource-sider
右侧：播放器 .ali_player_wrapper
```

### 4.2 资源是**多层树**（关键）

```
/resource                          课程根：第1章 / 第2章 / 第3讲 / 第4讲
/resource/{id}                     某一讲：pptx / 讨论 / 子文件夹 / 作业自测
/resource/{id}/{id2}               子文件夹（如「第4讲视频」里才是真视频）
```

实测第4讲这一层：

| 名称 | 图标 |
|---|---|
| 第4讲 人工智能的算力支持.pptx | `#icon-ppt1` |
| 游戏加载一般都需要时间… | `#icon-taolun`（讨论） |
| 讨论：1、英伟达的股票市值… | `#icon-taolun` |
| **第4讲视频** | `#icon-resource-folder`（子文件夹） |
| 第4章课后自测 | `#icon-zuoyecelian`（作业） |

### 4.3 条目结构

```html
div.sider_items
  div.node-item
    div.group-resource-node (.no_border 表示资源，无此class表示文件夹)
      div.teaching-status.student-status
        svg use[href="#icon-shoucang"]        ← 收藏星标（注意：不是类型图标！）
      div.node-resource
        div.node-resource-title
          svg use[href="#icon-shipin"]        ← 类型图标在这里
          div.node-inner                      ← 名称
          div.node-option                     ← "..." 更多
        div.render_status
          span.node_status "自主观看"          ← 状态
```

**类型图标**（在 `.node-resource-title` 内）：

| 图标 | 含义 |
|---|---|
| `#icon-shipin` | 视频 |
| `#icon-resource-folder` | 文件夹/章节 |
| `#icon-ppt1` | PPT |
| `#icon-taolun` | 讨论 |
| `#icon-zuoyecelian` | 作业自测 |

### 4.4 其他

| 元素 | 选择器 |
|---|---|
| 播放器 | `.prism-player video`（`<video>` 无 controls，AliPlayer 自绘） |
| 播放器容器 | `div#stream_video_player_xxx.prism-player` |
| 当前文件名 | `.header-file` |
| 进度 | `.progress_container` → 「已观看:1.19%」 |
| 面包屑 | `a.header-title-path` × 4（我学的课程 / 课程名 / 第N讲 XXX / 第N讲视频） |
| 完成任务按钮 | `div.ta_icon_btn` 文本「点我完成任务」（图标 `icon-dianwowanchengrenwu`） |

---

## 5. 交互坑（重要）

| 操作 | 正确做法 | 说明 |
|---|---|---|
| **点视频资源** | 单击 | `.click()` 有效 |
| **点章节/文件夹** | **双击** | 单击被禁用（`cursor:not-allowed`），必须 `dblclick` 才进入 |
| 播放 | `video.play()` | 原生 API 有效 |
| 活跃度 | dispatch `mousemove`/`keydown` | 刷新 `userOperateObj.lastAt` |

**章节双击**是实测发现的：单击所有元素都试过无效，`cursor` 一直是 `not-allowed`，只有 `dblclick` 才触发路由跳转。

---

## 6. 适配方案

### 6.1 不做什么

- ❌ 不碰 `SignatureHelper`（不伪造签名）
- ❌ 不伪造 `learnRecord` / `vod/duration` 上报
- ❌ 不拖拽进度条（`seeking` 期间平台不计时长）

### 6.2 做什么

只做三件事，全部是"让真实播放发生"：

1. **自动播放**：`video.play()` + 静音 + 倍速
2. **自动遍历**：树形下钻（根 → 讲 → 子文件夹 → 视频），播完回上一层
3. **维持活跃度**：每 5 分钟 dispatch 真实鼠标事件（远小于 3600s 闸门）

时长仍由平台按真实播放上报，脚本不干预。

---

## 7. 实现（`xiaoya-assistant.user.js`）

核心函数：

| 函数 | 作用 |
|---|---|
| `urlIds()` | 解析 `/resource(/id)*` 层级 |
| `isCatalogPage()` / `isSectionPage()` / `isPlayingPage()` | 判断当前在哪一层 |
| `resourceItems()` | 资源条目（排除收藏图标干扰） |
| `iconOf(el)` | **只从 `.node-resource-title` 取图标** |
| `activateNode(el, isFolder)` | 文件夹双击、资源单击 |
| `advanceSectionOnCatalog()` | 根目录 → 下一讲 |
| `autoplayFirstInSection()` | 本层挑一个：未看视频 > 视频 > 子文件夹下钻 > 其他 |
| `switchToNext()` | 同层下一个；最后一个 → `goUpOneLevel()` |
| `goUpOneLevel()` | 去掉 URL 最后一段 |
| `keepAlive()` | 每 5 分钟产生真实事件 |
| `tick()` | 主循环，URL 变化时重置"本层已尝试"标志 |

---

## 8. 已验证

| 项 | 结果 |
|---|---|
| 面板显示 | ✓ |
| 资源识别（图标/名称/状态） | ✓ 5 个视频全部识别 |
| 视频自动播放 | ✓ 注入前 `paused:true` → 注入后播放 |
| 同层切下一个 | ✓ 算力引擎.mp4 → 中国算力.mp4 |
| 本层最后 → 回上一层 | ✓ URL 前缀正确保留 `/app/jx-web` |
| 根目录 → 下一讲 | ✓ 第3讲 → 第4讲（双击） |
| **树形下钻** | ✓ 第4讲 → 第4讲视频 → 东数西算.mp4 |

---

## 9. 未做 / 后续

- **PPT/PDF/音频** 类型：目前只"点开"，不做滚动推进（超星版有 `docface` 逻辑，这里还没实现）
- **讨论/作业**：跳过，不参与
- **「点我完成任务」按钮**：代码里有配置项 `clickComplete`，默认关闭——语义未完全确认（可能是学生主动声明完成），暂不自动点
- **多课程连刷**：需要在课程列表页遍历，未实现
