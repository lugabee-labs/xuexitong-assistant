// ==UserScript==
// @name         脚本猫注入自检
// @namespace    https://scriptcat.org/scripts/inject-selfcheck
// @version      1.0.0
// @description  仅用于排查脚本猫是否能正常注入脚本：在任意网页左上角显示红色徽标。
// @author       学习通助手
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 用法：在脚本猫里新建脚本，粘贴本文件并保存。
 * 然后打开任意普通网站（例如 baidu.com）：
 *   - 看到红色徽标「自检：脚本猫已注入」=> 脚本猫注入正常，问题出在域名匹配
 *   - 看不到红色徽标                => 脚本猫本身没有在注入脚本
 */

(function () {
  'use strict';

  const show = () => {
    if (document.getElementById('inject-selfcheck-badge')) return;
    const b = document.createElement('div');
    b.id = 'inject-selfcheck-badge';
    b.textContent = '自检：脚本猫已注入 · ' + location.host;
    b.style.cssText =
      'position:fixed;left:10px;top:10px;z-index:2147483647;padding:4px 10px;border-radius:12px;' +
      'background:#c62828;color:#fff;font:12px/1.4 -apple-system,"Microsoft YaHei",sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none;opacity:.95;';
    if (document.body) document.body.appendChild(b);
    else setTimeout(show, 200);
  };

  show();
  console.log('[自检] 脚本猫已注入', location.href);
})();
