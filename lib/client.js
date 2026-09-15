/**
 * dsh-settings-nav-order — Client 半部（无自身 UI）。
 *
 * 给「设置面板左侧大项导航」加一个隐藏能力：**长按某个大项即可上下拖动排序**，
 * 松手即保存。不新增任何设置页、不注册任何 slot、不改变导航外观。
 *
 * 实现要点（参照社区先例 dsh-settings-nav-organizer / dsh-footer-order 的成熟做法）：
 *
 * 1. **导航列表不是 Slot**，是设置面板内部直接渲染的 DOM。
 *    定位靠稳定选择器：
 *      [role="dialog"][aria-modal="true"] > nav > div:last-child
 *    其子节点就是每个大项对应的 <button>。
 * 2. **id 配对**：按钮本身没有任何 data 属性，但它们的顺序与
 *    `ctx.slots.entries('settings.section')` 台账（按 order 升序）一致。
 *    先按 label 文本配对；全部失配时才退化为按位置一一对应。
 * 3. **拖动 = 直接搬 DOM**。React 下次重渲染会按官方 order 重建按钮，
 *    所以用 MutationObserver 跟随重渲染并重新施加用户顺序；
 *    观察器带风暴看门狗，异常时挂起 2 秒，不会把页面卡死。
 * 4. **卸载即还原**：所有样式、监听、观察器挂在插件 fiber 上；
 *    卸载时把 DOM 顺序显式还原为台账原序（不依赖 React 恰好重渲染）。
 * 5. **持久化**：顺序记录 POST 给本插件自己的 Host 路由，
 *    落在插件目录内的 data/order.json —— 不写 settings.yaml，不碰任何外部数据。
 *
 * @module dsh-settings-nav-order/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-settings-nav-order',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 设置面板导航列表的稳定选择器（与社区先例一致）。 */
    const NAV_SEL = '[role="dialog"][aria-modal="true"] > nav > div:last-child';
    /** Host 侧持久化路由。 */
    const API = '/api/settings-nav-order';
    /** 长按判定时长：按住这么久且未明显移动才进入拖动。 */
    const LONG_PRESS_MS = 300;
    /** 长按期间的位移容忍（px）：超过即视为滚动/点击，取消拖动。 */
    const MOVE_TOLERANCE = 6;
    /** 拖动结束后抑制 click 的时长（ms），避免松手时误切换设置页。 */
    const CLICK_SUPPRESS_MS = 400;
    /** 观察器风暴阈值：1 秒内超过这么多次同步就挂起观察器。 */
    const STORM_LIMIT = 20;
    const STORM_COOLDOWN_MS = 2000;
    const STYLE_ID = 'dsh-navorder-style';

    const CSS = `
.dsh-navorder-dragging{position:relative;z-index:1000;opacity:.5;outline:2px solid var(--dsw-alias-label-primary,#8a8a93);outline-offset:2px;border-radius:12px;cursor:grabbing!important;box-shadow:0 8px 20px rgba(0,0,0,.3);transition:none!important}
body.dsh-navorder-active,body.dsh-navorder-active *{cursor:grabbing!important}
body.dsh-navorder-active{user-select:none!important;-webkit-user-select:none!important}
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return null;
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      el.textContent = CSS;
      return el;
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      const styleEl = ensureStyle();

      /** 用户保存的顺序（id 数组）；空 = 未自定义，走官方原序。 */
      let savedOrder = [];
      /** 顺序记录是否已从 Host 读到（未读到前不重排，避免闪动）。 */
      let loaded = false;
      /** 正在由本插件搬动 DOM：忽略自身引发的 mutation。 */
      let applying = false;
      /** 拖动中：抑制 click 的截止时间戳。 */
      let suppressClickUntil = 0;

      const log = (...a) => { try { console.info('[settings-nav-order]', ...a); } catch { /* noop */ } };
      const warn = (...a) => { try { console.warn('[settings-nav-order]', ...a); } catch { /* noop */ } };

      /* ---------------- 台账（官方原始顺序） ---------------- */

      const resolveLabel = (l) => {
        try { return typeof l === 'function' ? (l() ?? '') : (l ?? ''); } catch { return ''; }
      };

      /** 台账行：按官方 order 升序，这就是「原始顺序」。 */
      function ledgerRows() {
        if (slots === undefined || typeof slots.entries !== 'function') return [];
        try {
          return slots.entries('settings.section')
            .map((e) => ({ id: e.options?.id ?? '', label: resolveLabel(e.options?.label) }))
            .filter((r) => r.id !== '')
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        } catch {
          return [];
        }
      }

      /* ---------------- DOM ---------------- */

      const findNavList = () => {
        try { return document.querySelector(NAV_SEL); } catch { return null; }
      };

      const buttonsOf = (navList) =>
        [...navList.children].filter((c) => c.tagName === 'BUTTON');

      const labelOf = (btn) => (btn.textContent ?? '').trim();

      /**
       * 把 DOM 按钮与台账 id 配对。
       *
       * 优先 label 文本匹配（导航按钮 = 图标 + 文本，textContent 即 label）。
       * 只有**一个都没匹配上**且数量恰好相等时，才退化为按位置一一对应——
       * 这样即使别家插件往导航里插了额外按钮，也不会整体错位。
       */
      function pairIds(navList) {
        const rows = ledgerRows();
        const buttons = buttonsOf(navList);
        if (rows.length === 0 || buttons.length === 0) return [];

        const used = new Set();
        const pairs = buttons.map((btn) => {
          const text = labelOf(btn);
          const hit = rows.find((r) => !used.has(r.id) && r.label === text);
          if (hit) { used.add(hit.id); return { btn, id: hit.id }; }
          return { btn, id: null };
        });

        const matched = pairs.filter((p) => p.id !== null).length;
        if (matched === 0 && buttons.length === rows.length) {
          return buttons.map((btn, i) => ({ btn, id: rows[i].id }));
        }
        return pairs;
      }

      /**
       * 按目标顺序重排按钮（只动「已知 id」的按钮，未知按钮留在原位）。
       *
       * 做法：算出每个子节点的目标排列，再逐位 insertBefore。
       * 这是同集合的置换，收敛且不会丢节点。
       */
      function reorder(navList, desiredIds) {
        const pairs = pairIds(navList);
        const known = pairs.filter((p) => p.id !== null);
        if (known.length < 2) return false;

        const byId = new Map(known.map((p) => [p.id, p.btn]));
        const ordered = [];
        for (const id of desiredIds) {
          const btn = byId.get(id);
          if (btn !== undefined && !ordered.includes(btn)) ordered.push(btn);
        }
        // 目标顺序里没提到的，按当前 DOM 顺序补在后面（保持稳定）。
        for (const p of known) if (!ordered.includes(p.btn)) ordered.push(p.btn);

        const children = [...navList.children];
        const positions = [];
        children.forEach((c, i) => { if (ordered.includes(c)) positions.push(i); });
        if (positions.length !== ordered.length) return false;

        const target = [...children];
        positions.forEach((pos, i) => { target[pos] = ordered[i]; });

        let changed = false;
        for (let i = 0; i < target.length; i++) {
          const want = target[i];
          const cur = navList.children[i];
          if (cur !== want) {
            navList.insertBefore(want, cur ?? null);
            changed = true;
          }
        }
        return changed;
      }

      /** 目标顺序：已保存的 id（过滤掉已消失的）→ 其余按台账原序。 */
      function desiredIds() {
        return savedOrder.filter((id) => id !== '');
      }

      /* ---------------- 同步 ---------------- */

      let syncScheduled = false;
      function scheduleSync() {
        if (syncScheduled) return;
        syncScheduled = true;
        queueMicrotask(() => {
          syncScheduled = false;
          sync();
        });
      }

      function sync() {
        if (!loaded) return; // 顺序还没读回来，先不动 DOM
        const navList = findNavList();
        if (navList === null) return;
        applying = true;
        try {
          reorder(navList, desiredIds());
        } catch (error) {
          warn('重排失败：', error);
        } finally {
          // 让本次搬动引发的 mutation 在观察器里被忽略。
          setTimeout(() => { applying = false; }, 0);
        }
      }

      /* ---------------- 持久化 ---------------- */

      async function loadOrder() {
        try {
          const res = await fetch(`${API}/order`, { method: 'GET', headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          savedOrder = Array.isArray(data?.order) ? data.order : [];
          loaded = true;
          log('已载入顺序记录：', savedOrder.length, '项');
          sync();
        } catch (error) {
          // Host 路由不可用（例如插件刚装、未重启）：退化为「仅本次会话有效」。
          loaded = true;
          warn('顺序记录读取失败，本次会话不恢复自定义顺序：', error?.message ?? error);
        }
      }

      async function saveOrder(ids) {
        try {
          const res = await fetch(`${API}/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: ids }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          savedOrder = Array.isArray(data?.order) ? data.order : ids;
          log('顺序已保存：', savedOrder.join(' → '));
        } catch (error) {
          warn('顺序保存失败：', error?.message ?? error);
        }
      }

      /** 读当前 DOM 顺序 → id 列表。 */
      function currentIds(navList) {
        const pairs = pairIds(navList);
        const ids = [];
        for (const c of [...navList.children]) {
          const hit = pairs.find((p) => p.btn === c);
          if (hit !== undefined && hit.id !== null) ids.push(hit.id);
        }
        return ids;
      }

      /* ---------------- 长按拖动 ---------------- */

      let dragState = null;
      let longPressTimer = null;

      const isKnownButton = (btn, navList) =>
        pairIds(navList).some((p) => p.btn === btn && p.id !== null);

      function clearLongPress() {
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
      }

      function endDrag(navList, persist) {
        if (dragState === null) return;
        const { btn } = dragState;
        clearLongPress();
        dragState = null;
        document.body.classList.remove('dsh-navorder-active');
        btn.classList.remove('dsh-navorder-dragging');
        btn.style.transform = '';
        try { btn.releasePointerCapture?.(btn.__dshPointerId); } catch { /* noop */ }
        delete btn.__dshPointerId;
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        if (persist) {
          const ids = currentIds(navList);
          if (ids.length > 0) void saveOrder(ids);
        }
      }

      function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return; // 只响应主键
        const navList = findNavList();
        if (navList === null) return;
        const btn = e.target?.closest?.('button');
        if (!btn || btn.parentNode !== navList) return;
        if (!isKnownButton(btn, navList)) return;

        clearLongPress();
        // 记录"抓取点"在按钮内的偏移：拖动时据此让按钮始终贴在光标下。
        const rect = btn.getBoundingClientRect();
        dragState = {
          btn,
          navList,
          startX: e.clientX,
          startY: e.clientY,
          grabOffsetY: e.clientY - rect.top,
          tx: 0, // 当前已施加的 translateY（用于反推未变换位置）
        };
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (dragState === null || dragState.btn !== btn) return;
          btn.classList.add('dsh-navorder-dragging');
          document.body.classList.add('dsh-navorder-active');
          try {
            btn.setPointerCapture?.(e.pointerId);
            btn.__dshPointerId = e.pointerId;
          } catch { /* noop */ }
        }, LONG_PRESS_MS);
      }

      function onPointerMove(e) {
        if (dragState === null) return;
        const { btn, navList } = dragState;

        // 长按尚未成立：位移过大即取消（用户其实想滚动或点击）。
        if (longPressTimer !== null) {
          if (Math.abs(e.clientY - dragState.startY) > MOVE_TOLERANCE
            || Math.abs(e.clientX - dragState.startX) > MOVE_TOLERANCE) {
            clearLongPress();
            dragState = null;
          }
          return;
        }

        // 长按已成立（拖动中）。
        if (!btn.classList.contains('dsh-navorder-dragging')) return;
        e.preventDefault();

        // ① 先在流式布局里换位（其它项的表现维持原样）。
        const known = pairIds(navList).filter((p) => p.id !== null).map((p) => p.btn);
        let ref = null;
        for (const b of known) {
          if (b === btn) continue;
          const r = b.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { ref = b; break; }
        }
        applying = true;
        try {
          if (ref === null) {
            if (navList.lastElementChild !== btn) navList.appendChild(btn);
          } else if (ref !== btn && btn.nextElementSibling !== ref) {
            navList.insertBefore(btn, ref);
          }
        } finally {
          setTimeout(() => { applying = false; }, 0);
        }

        // ② 换位之后再算位移，让被拖项视觉上始终贴在光标下。
        //
        // getBoundingClientRect() 是**含 transform** 的，直接用它反推会自我
        // 反馈导致抖动；故先减去当前已施加的 tx 还原出"流位置"，再求目标位移。
        const rectNow = btn.getBoundingClientRect();
        const flowTop = rectNow.top - (dragState.tx ?? 0);
        const desired = (e.clientY - dragState.grabOffsetY) - flowTop;
        dragState.tx = desired;
        btn.style.transform = `translateY(${desired}px)`;
      }

      function onPointerUp() {
        if (dragState === null) { clearLongPress(); return; }
        const dragging = dragState.btn.classList.contains('dsh-navorder-dragging');
        const navList = dragState.navList;
        if (!dragging) { clearLongPress(); dragState = null; return; }
        endDrag(navList, true);
      }

      function onPointerCancel() {
        if (dragState === null) { clearLongPress(); return; }
        const navList = dragState.navList;
        const dragging = dragState.btn.classList.contains('dsh-navorder-dragging');
        if (dragging) endDrag(navList, false); else { clearLongPress(); dragState = null; }
      }

      /** 拖动刚结束时吞掉那次 click，避免误切换设置页。 */
      function onClickCapture(e) {
        if (Date.now() < suppressClickUntil) {
          e.stopPropagation();
          e.preventDefault();
        }
      }

      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', onPointerCancel, true);
      document.addEventListener('click', onClickCapture, true);

      /* ---------------- 观察器（跟随 React 重渲染） ---------------- */

      let syncCount = 0;
      let stormBase = 0;
      let stormTimer = null;
      let suspended = false;

      const observer = new MutationObserver((mutations) => {
        if (suspended || applying) return;
        let need = false;
        for (const m of mutations) {
          if (m.type !== 'childList') continue;
          const t = m.target;
          if (!(t instanceof Element)) continue;
          // 判据：变化发生在**设置 dialog 内**（含 dialog 本身挂载/卸载）。
          //
          // 不能用 `t.closest(NAV_SEL)` 判断：React 重建导航时，把
          // `nav > div:last-child`（即 NAV_SEL 那个 div）插进 `nav`，
          // 此时 mutation 的 target 是 `nav` 本身，而 `nav.closest(NAV_SEL)`
          // 恒为 null（NAV_SEL 匹配的是 nav 的**子**元素）——这正是
          // 「关掉设置再打开、顺序被还原」的根因。
          const inDialog = t.closest?.('[role="dialog"][aria-modal="true"]') !== null;
          const isDialog = t.matches?.('[role="dialog"][aria-modal="true"]') === true;
          const added = [...(m.addedNodes ?? []), ...(m.removedNodes ?? [])];
          const touchesDialog = added.some(
            (n) => n instanceof Element
              && (n.matches?.('[role="dialog"][aria-modal="true"]') === true
                || n.querySelector?.('[role="dialog"][aria-modal="true"]') !== null),
          );
          if (inDialog || isDialog || touchesDialog) { need = true; break; }
        }
        if (!need) return;

        const now = Date.now();
        if (now - stormBase > 1000) { syncCount = 0; stormBase = now; }
        syncCount += 1;
        if (syncCount > STORM_LIMIT) {
          warn('mutation 风暴，挂起观察器 2 秒');
          suspended = true;
          observer.disconnect();
          stormTimer = setTimeout(() => {
            stormTimer = null;
            suspended = false;
            observer.observe(document.body, { childList: true, subtree: true });
            sync();
          }, STORM_COOLDOWN_MS);
          return;
        }
        scheduleSync();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      /* ---------------- 台账变化 → 重新施加顺序 ---------------- */

      let offSlots = null;
      if (slots !== undefined && typeof slots.subscribe === 'function') {
        try { offSlots = slots.subscribe('settings.section', () => scheduleSync()); } catch { /* noop */ }
      }

      /* ---------------- 清理：卸载即还原官方原序 ---------------- */

      ctx.effect(() => () => {
        try { observer.disconnect(); } catch { /* noop */ }
        if (stormTimer !== null) clearTimeout(stormTimer);
        clearLongPress();
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerCancel, true);
        document.removeEventListener('click', onClickCapture, true);
        document.body.classList.remove('dsh-navorder-active');
        document.querySelectorAll('.dsh-navorder-dragging').forEach((el) => {
          el.classList.remove('dsh-navorder-dragging');
          el.style.transform = '';
        });
        // 兜底：任何残留的内联 transform 都清掉（含拖动中途卸载的情形）。
        document.querySelectorAll(`${NAV_SEL} > button[style*="translateY"]`).forEach((el) => {
          el.style.transform = '';
        });
        if (typeof offSlots === 'function') { try { offSlots(); } catch { /* noop */ } }

        // 关键：显式把 DOM 还原成台账原序，不依赖 React 恰好重渲染。
        const navList = findNavList();
        if (navList !== null) {
          try {
            const natural = ledgerRows().map((r) => r.id);
            reorder(navList, natural);
          } catch { /* noop */ }
        }
        if (styleEl !== null && styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl);
      }, 'settings-nav-order: restore original order and clean up');

      void loadOrder();
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
