// ==UserScript==
// @name         小雅自动学习助手 (河中医)
// @namespace    https://github.com/mahe-404/xuexitong-assistant
// @version      0.1.0
// @description  小雅平台（ai-augmented.com）自动连播：视频自动播放、播完自动切下一个资源点、跨讲自动推进、维持操作活跃度避免"长时间未操作"中断。只加速自然播放，不伪造上报。
// @author       xuexitong-assistant contributors
// @match        *://*.ai-augmented.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 小雅平台结构（2026-11-05 实测，河南中医药大学实例）
   * ------------------------------------------------------------
   * 页面分三列：左侧全局导航 / 中间资源列 / 右侧播放器
   *
   * 资源列（当前讲的资源列表）：
   *   div.sider_items
   *     div.node-item
   *       div.group-resource-node
   *         div.node-resource-title
   *           i > svg > use[href="#icon-shipin"]     ← 资源类型（视频）
   *           div.node-inner                          ← 名称
   *         div.render_status > span.node_status      ← 状态（自主观看/空）
   *
   * 章节列（/resource 路由）：
   *   use[href="#icon-resource-folder"]               ← 章节图标
   *
   * 播放器：
   *   .prism-player video                             ← 原生 video（AliPlayer 底层）
   *
   * 平台的风控（从 bundle 逆向）：
   *   - learningRecorderSaga 每 10s 检查一次，每 50s 上报一次学习时长
   *   - 若 now - userOperateObj.lastAt > 3600s（生产环境），学生会被
   *     stopAllMedia() + 弹窗「长时间未操作」，且本次学习时长不记录
   *   - 视频时长每 30s 上报，条件是 !paused && !seeking
   *
   * 所以本脚本只做三件事：让它真的播、播完切下一个、定期产生真实操作。
   * 不碰 SignatureHelper，不伪造任何上报。
   * ============================================================ */

  const CFG = {
    speed: GM_getValue('xy_speed', 1),          // 倍速（平台允许范围内）
    autoPlay: GM_getValue('xy_autoplay', true),
    autoNext: GM_getValue('xy_autonext', true),
    mute: GM_getValue('xy_mute', true),
    keepAlive: GM_getValue('xy_keepalive', true),
    keepAliveSec: GM_getValue('xy_keepalive_sec', 300),   // 5 分钟一次，远小于 3600s 闸门
    endedWaitMs: GM_getValue('xy_ended_wait', 8000),      // 播完后等上报再切
    clickComplete: GM_getValue('xy_click_complete', false), // 是否点「点我完成任务」
    debug: GM_getValue('xy_debug', false),
  };

  const SEL = {
    video: '.prism-player video',
    siderItems: '.sider_items',
    nodeItem: '.node-item',
    nodeInner: '.node-inner',
    nodeTitle: '.node-resource-title',
    status: '.render_status .node_status',
    typeIcon: 'svg use',
    completeBtn: 'div.ta_icon_btn',
    headerFile: '.header-file',
    progress: '.progress_container',
    breadcrumb: 'a.header-title-path',
  };

  const stats = {
    action: '待命中',
    videoState: '—',
    progress: '—',
    nextIn: '—',
    keepAliveAt: 0,
  };

  const log = (...a) => { if (CFG.debug) console.log('[小雅]', ...a); };

  /* ---------------- 工具 ---------------- */

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* 取资源类型图标。
   * 注意：.node-item 里第一个 svg 是 .teaching-status 内的 #icon-shoucang（收藏星标），
   * 不是类型图标。类型图标只在 .node-resource-title 里。
   * 实测（2026-11-05）：
   *   视频  → #icon-shipin
   *   章节  → #icon-resource-folder
   */
  function iconOf(el) {
    const title = el && el.querySelector(SEL.nodeTitle);
    if (!title) return '';
    const use = title.querySelector(SEL.typeIcon);
    if (!use) return '';
    return use.getAttribute('xlink:href') || use.getAttribute('href') || '';
  }

  // 资源条目（只保留视频类，排除章节文件夹）
  function resourceItems() {
    return $$(SEL.nodeItem).filter((it) => {
      const ic = iconOf(it);
      return ic && ic.indexOf('folder') < 0;   // 排除 #icon-resource-folder（章节）
    });
  }

  function itemName(it) {
    const n = it.querySelector(SEL.nodeInner);
    return n ? (n.textContent || '').trim() : '';
  }

  function itemStatus(it) {
    const s = it.querySelector(SEL.status);
    return s ? (s.textContent || '').trim() : '';
  }

  // 当前正在播放的资源名（优先 header，其次 URL 兜底）
  function currentName() {
    const h = $(SEL.headerFile);
    if (h && (h.textContent || '').trim()) return (h.textContent || '').trim();
    const items = resourceItems();
    const active = items.find((it) => it.querySelector('.node-resource-title') &&
      String(it.className).indexOf('active') >= 0);
    return active ? itemName(active) : '';
  }

  function currentIndex() {
    const name = currentName();
    if (!name) return -1;
    const items = resourceItems();
    for (let i = 0; i < items.length; i++) {
      const n = itemName(items[i]);
      if (n && (n === name || n.indexOf(name) >= 0 || name.indexOf(n) >= 0)) return i;
    }
    return -1;
  }

  /* ---------------- 播放器控制 ---------------- */

  function getVideo() {
    return $(SEL.video);
  }

  function tickVideo() {
    const v = getVideo();
    if (!v) { stats.videoState = '未检测到视频'; return null; }

    if (CFG.mute && !v.muted) { try { v.muted = true; } catch (e) {} }
    if (CFG.speed && v.playbackRate !== CFG.speed) {
      try { v.playbackRate = CFG.speed; } catch (e) {}
    }
    if (CFG.autoPlay && v.paused && !v.ended) {
      const p = v.play();
      if (p && p.catch) p.catch(() => { /* 需要用户手势时忽略 */ });
    }

    const dur = v.duration || 0;
    const cur = v.currentTime || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    stats.videoState = v.ended ? '已播完' : (v.paused ? '已暂停' : '播放中');
    stats.progress = dur > 0 ? pct.toFixed(1) + '%' : '—';
    return { v, dur, cur, pct, ended: v.ended };
  }

  /* ---------------- 自动切下一个 ---------------- */

  let lastSwitchAt = 0;

  /* 当前"讲"的名字：面包屑第 3 层（我学的课程 / 课程名 / 第N讲 XXX / 第N讲视频）。
   * 章节条目本身没有 id 属性，只能靠名字匹配。 */
  function currentSectionName() {
    const crumbs = $$(SEL.breadcrumb);
    if (crumbs.length >= 3) return (crumbs[2].textContent || '').trim();
    if (crumbs.length >= 2) return (crumbs[crumbs.length - 1].textContent || '').trim();
    return '';
  }

  function switchToNext() {
    const items = resourceItems();
    if (!items.length) { stats.action = '未找到资源列表'; return false; }

    const idx = currentIndex();
    if (idx < 0) { stats.action = '定位不到当前资源（' + currentName() + '）'; return false; }

    if (idx < items.length - 1) {
      const next = items[idx + 1];
      const titleEl = next.querySelector(SEL.nodeTitle);
      if (!titleEl) { stats.action = '下一个条目不可点'; return false; }
      stats.action = '切到下一个：' + itemName(next);
      log(stats.action);
      activateNode(next, false);   // 资源用单击
      lastSwitchAt = Date.now();
      return true;
    }

    /* 当前层最后一个播完 → 回上一层（树回溯），不是直接回课程根。
     * 只有根目录的第4讲才是"全部完成"。 */
    const sec = currentSectionName();
    if (sec) { GM_setValue('xy_last_section', sec); }
    stats.action = '本层已播完，回上一层' + (sec ? '（记住：' + sec + '）' : '');
    log(stats.action);
    const ok = goUpOneLevel();
    if (!ok) stats.action = '已在最顶层，无法再上溯';
    return ok;
  }

  /* 点一个树节点。
   * 实测（2026-11-05）交互不一致：
   *   资源条目（视频）→ 单击就跳转
   *   章节条目（folder）→ 单击被禁用（cursor:not-allowed），必须**双击**才进入
   * 所以先发完整鼠标序列，再补一个 dblclick 兜底。 */
  function activateNode(el, isFolder) {
    const target = el.querySelector(SEL.nodeInner) || el.querySelector(SEL.nodeTitle) || el;
    const fire = (ty) => {
      try { target.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    };
    if (isFolder) {
      fire('mousedown'); fire('mouseup'); fire('click');
      fire('mousedown'); fire('mouseup'); fire('click');
      fire('dblclick');
    } else {
      fire('mousedown'); fire('mouseup'); fire('click');
    }
  }

  /* 课程目录页（/resource 结尾，没有 sectionId）→ 找到上次那讲，点下一个 */
  function advanceSectionOnCatalog() {
    if (!/\/resource\/?$/.test(location.pathname)) return false;
    const last = GM_getValue('xy_last_section', '');
    if (!last) { stats.action = '目录页：没有上次记录，等你选一讲'; return false; }

    // 章节条目 = 带 folder 图标的 node-item
    const secs = $$(SEL.nodeItem).filter((it) => iconOf(it).indexOf('folder') >= 0);
    if (!secs.length) { stats.action = '目录页：未找到章节列表'; return false; }

    let at = -1;
    for (let i = 0; i < secs.length; i++) {
      if (itemName(secs[i]) === last) { at = i; break; }
    }
    if (at < 0) {
      stats.action = '目录页：找不到「' + last + '」，请手动选';
      return false;
    }
    if (at >= secs.length - 1) {
      stats.action = '目录页：「' + last + '」已是最后一讲，全部完成';
      return false;
    }

    const target = secs[at + 1];
    const name = itemName(target);
    stats.action = '进入下一讲：' + name;
    log(stats.action);
    GM_setValue('xy_last_section', name);
    activateNode(target, true);   // 章节用双击
    return true;
  }

  /* ---------------- 活跃度维持 ----------------
   * 平台靠 userOperateObj.lastAt 判断"用户是否在操作"，
   * 超过 3600s 会 stopAllMedia + 弹窗且不记录时长。
   * 我们定期产生真实事件（每 5 分钟），远小于闸门。
   * 这是"产生操作"，不是伪造时长——时长仍由平台按真实播放上报。
   */
  function keepAlive() {
    if (!CFG.keepAlive) return;
    const now = Date.now();
    if (now - stats.keepAliveAt < CFG.keepAliveSec * 1000) return;
    stats.keepAliveAt = now;
    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      document.dispatchEvent(new MouseEvent('mousemove', Object.assign({
        clientX: 200 + Math.floor(Math.random() * 400),
        clientY: 200 + Math.floor(Math.random() * 300),
      }, opts)));
      window.dispatchEvent(new MouseEvent('mousemove', opts));
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
      // 兜底：如果平台挂的是 document.onXxx，也直接刷新一次
      if (window.userOperateObj && window.userOperateObj.lastAt) {
        log('发现 window.userOperateObj，跳过直接改写（不伪造）');
      }
    } catch (e) { log('keepAlive 失败', e); }
  }

  /* ---------------- 面板 ---------------- */

  let hud = null;

  function createHud() {
    if (hud) return;
    hud = document.createElement('div');
    hud.style.cssText =
      'position:fixed;right:14px;bottom:14px;z-index:2147483000;width:250px;' +
      'padding:10px 12px;border-radius:10px;background:rgba(17,24,39,.94);color:#e5e7eb;' +
      'font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
      'user-select:none;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:6px;cursor:pointer;';
    title.textContent = '小雅助手 v0.1.0 ▾';

    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;';

    const rows = document.createElement('div');
    rows.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';

    const mk = (text, onClick, bg) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'padding:4px 8px;border:0;border-radius:6px;cursor:pointer;color:#fff;font-size:12px;background:' + (bg || '#4b5563');
      b.onclick = onClick;
      return b;
    };

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    row1.appendChild(mk('切下一个', () => switchToNext(), '#1d4ed8'));
    row1.appendChild(mk('重载', () => location.reload()));

    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    row2.appendChild(mk('自动连播：' + (CFG.autoNext ? '开' : '关'), (e) => {
      CFG.autoNext = !CFG.autoNext;
      GM_setValue('xy_autonext', CFG.autoNext);
      e.target.textContent = '自动连播：' + (CFG.autoNext ? '开' : '关');
      e.target.style.background = CFG.autoNext ? '#2e7d32' : '#4b5563';
    }, CFG.autoNext ? '#2e7d32' : '#4b5563'));
    row2.appendChild(mk('活跃度：' + (CFG.keepAlive ? '开' : '关'), (e) => {
      CFG.keepAlive = !CFG.keepAlive;
      GM_setValue('xy_keepalive', CFG.keepAlive);
      e.target.textContent = '活跃度：' + (CFG.keepAlive ? '开' : '关');
      e.target.style.background = CFG.keepAlive ? '#2e7d32' : '#4b5563';
    }, CFG.keepAlive ? '#2e7d32' : '#4b5563'));

    const row3 = document.createElement('div');
    row3.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
    const speedBtn = mk(CFG.speed + 'x', (e) => {
      const list = [1, 1.25, 1.5, 1.75, 2];
      const i = list.indexOf(CFG.speed);
      CFG.speed = list[(i + 1) % list.length];
      GM_setValue('xy_speed', CFG.speed);
      e.target.textContent = CFG.speed + 'x';
      const v = getVideo();
      if (v) { try { v.playbackRate = CFG.speed; } catch (x) {} }
    });
    row3.appendChild(speedBtn);
    row3.appendChild(mk('静音：' + (CFG.mute ? '开' : '关'), (e) => {
      CFG.mute = !CFG.mute;
      GM_setValue('xy_mute', CFG.mute);
      e.target.textContent = '静音：' + (CFG.mute ? '开' : '关');
      const v = getVideo();
      if (v) { try { v.muted = CFG.mute; } catch (x) {} }
    }, CFG.mute ? '#2e7d32' : '#4b5563'));

    hud.appendChild(title);
    hud.appendChild(body);
    hud.appendChild(row1);
    hud.appendChild(row2);
    hud.appendChild(row3);

    let collapsed = GM_getValue('xy_collapsed', false);
    const applyCollapsed = (c) => {
      collapsed = !!c;
      GM_setValue('xy_collapsed', collapsed);
      [body, row1, row2, row3].forEach((el) => { el.style.display = collapsed ? 'none' : ''; });
      title.textContent = collapsed ? '' : '小雅助手 v0.1.0 ▾';
    };
    title.onclick = () => applyCollapsed(!collapsed);

    const refresh = () => {
      if (collapsed) {
        title.textContent = '小雅助手 ▸ ' + stats.videoState + ' ' + stats.progress;
      }
      body.textContent = [
        '状态：' + stats.action,
        '视频：' + stats.videoState,
        '进度：' + stats.progress,
        '当前：' + (currentName() || '—').slice(0, 28),
        '资源数：' + resourceItems().length + ' 个（第 ' + (currentIndex() + 1) + ' 个）',
        '倍速：' + CFG.speed + 'x｜静音：' + (CFG.mute ? '开' : '关'),
        '自动连播：' + (CFG.autoNext ? '开' : '关') + '｜活跃度：' + (CFG.keepAlive ? '开' : '关'),
      ].join('\n');
    };

    const attach = () => {
      if (document.body) document.body.appendChild(hud);
      else setTimeout(attach, 200);
    };
    attach();
    applyCollapsed(collapsed);
    refresh();

    setInterval(refresh, 1000);
  }

  /* ---------------- 树形结构导航 ----------------
   * 实测（2026-11-05）：资源是**多层树**，不是平铺。
   *   /resource                          课程根（第1讲/第2讲/...）
   *   /resource/{id}                     某一讲（可能含 pptx/讨论/子文件夹/作业）
   *   /resource/{id}/{id2}               子文件夹（如「第4讲视频」里才是真视频）
   *   /resource/{id}/{id2}/{id3}?        更深层
   * 所以要走"有视频就播，有子文件夹就下钻，都不行就回上一级"的遍历。
   */
  function urlIds() {
    const m = location.pathname.match(/\/resource((?:\/\d+)*)\/?$/);
    if (!m) return null;
    return (m[1] || '').split('/').filter(Boolean);
  }

  function isCatalogPage() { const ids = urlIds(); return ids !== null && ids.length === 0; }
  function isSectionPage() { const ids = urlIds(); return ids !== null && ids.length >= 1; }
  function isPlayingPage() { return !!getVideo(); }

  /* 回上一级（树遍历的回溯） */
  function goUpOneLevel() {
    const ids = urlIds();
    if (!ids || ids.length === 0) return false;
    const base = location.pathname.replace(/\/resource((?:\/\d+)*)\/?$/, '/resource');
    const up = ids.slice(0, ids.length - 1);
    location.href = location.origin + base + (up.length ? '/' + up.join('/') : '');
    return true;
  }

  /* 当前层：自动挑一个该做的
   * 优先级：未完成的视频 > 任何视频 > 未完成的子文件夹（下钻）> 未完成的其他类型 */
  function autoplayFirstInSection() {
    const ids = urlIds();
    if (!ids || ids.length === 0) return false;      // 根目录交给 advanceSectionOnCatalog
    if (getVideo()) return false;                    // 已在播

    const items = $$(SEL.nodeItem);
    if (!items.length) { stats.action = '本层无条目'; return false; }

    const kindOf = (it) => iconOf(it);
    const isVideo = (it) => kindOf(it).indexOf('shipin') >= 0;
    const isFolder = (it) => kindOf(it).indexOf('folder') >= 0;
    const isDone = (it) => {
      const s = itemStatus(it);
      return s.indexOf('已完成') >= 0 || s.indexOf('已看完') >= 0;
    };

    let pick = items.find((it) => isVideo(it) && !isDone(it));
    let why = '未看的视频';
    if (!pick) { pick = items.find(isVideo); why = '视频（重播）'; }
    if (!pick) { pick = items.find((it) => isFolder(it) && !isDone(it)); why = '子文件夹（下钻）'; }
    if (!pick) { pick = items.find((it) => !isFolder(it) && !isVideo(it) && !isDone(it)); why = '其他类型'; }

    if (!pick) {
      stats.action = '本层没有可做的了，回上一级';
      goUpOneLevel();
      return false;
    }

    stats.action = '选' + why + '：' + itemName(pick);
    log(stats.action, '图标=', kindOf(pick));
    activateNode(pick, isFolder(pick));   // 文件夹要双击
    return true;
  }

  /* ---------------- 主循环 ---------------- */

  let endedSince = 0;
  let catalogHandled = false;
  let sectionAutoplayed = false;
  let lastUrlKey = '';

  function tick() {
    /* URL 一变就重置"本层已尝试"标志 —— 树遍历要能一层层往下钻，
     * 每进一层都要重新挑一次，否则会在子文件夹前卡住。 */
    const ids0 = urlIds();
    const urlKey = ids0 === null ? 'none' : ids0.join('/');
    if (urlKey !== lastUrlKey) {
      lastUrlKey = urlKey;
      sectionAutoplayed = false;
      catalogHandled = false;
    }

    // 课程根目录：进下一讲（只尝试一次，避免反复点）
    if (isCatalogPage()) {
      if (!catalogHandled) {
        catalogHandled = true;
        stats.videoState = '课程目录（无视频）';
        setTimeout(() => { advanceSectionOnCatalog(); }, 2500);
      }
      return;
    }

    // 没有视频的层级（讲 / 子文件夹）：在这一层挑一个做
    if (isSectionPage() && !isPlayingPage()) {
      if (!sectionAutoplayed) {
        sectionAutoplayed = true;
        stats.videoState = '资源列表（选片）';
        setTimeout(() => { autoplayFirstInSection(); }, 2000);
      }
      return;
    }

    const st = tickVideo();
    keepAlive();

    if (!st) return;

    if (st.ended) {
      if (!endedSince) {
        endedSince = Date.now();
        stats.action = '已播完，等 ' + Math.round(CFG.endedWaitMs / 1000) + ' 秒让平台上报…';
      } else if (Date.now() - endedSince >= CFG.endedWaitMs) {
        if (CFG.autoNext && Date.now() - lastSwitchAt > 3000) {
          endedSince = 0;
          switchToNext();
        }
      }
    } else {
      endedSince = 0;
    }
  }

  function start() {
    createHud();
    setInterval(tick, 1000);
    log('已启动');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 暴露给控制台调试
  try {
    window.__XY = { stats, CFG, tick, switchToNext, resourceItems, currentName, currentIndex, getVideo };
  } catch (e) {}
})();
