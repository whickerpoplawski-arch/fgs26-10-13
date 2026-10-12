/**
 * fgs-deepseek — DSH 原生插件（Client 半）。
 *
 * 只读黑板条：挂在 composer 上方（conversation.input.dock），
 * 轮询 Host 的 `/fgs/state` 快照展示角色 / open step / fact 进度。
 * 不 import 任何 Harness Client 包；只用主题 token 与自己的样式。
 */
window.__ModuleLoader__.load({
  id: '@local/fgs-deepseek-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PLUGIN_ID = '@local/fgs-deepseek-dsh';
    const CSS_TAG = `${PLUGIN_ID}/board.css`;
    const CSS = `
.FGS_root{box-sizing:border-box;width:100%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.FGS_bar{display:flex;align-items:center;gap:8px;padding:4px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1);}
.FGS_dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
.FGS_dotOn{background:var(--dsw-alias-state-success-primary,#3fb950);}
.FGS_dotBad{background:var(--dsw-alias-state-error-primary);}
.FGS_role{color:var(--dsw-alias-label-primary);font-weight:600;}
.FGS_meta{font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-tertiary);}
.FGS_meta b{color:var(--dsw-alias-label-primary);font-weight:600;}
.FGS_spacer{flex:1;min-width:0;}
.FGS_toggle{border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;padding:0 2px;}
.FGS_toggle:hover{color:var(--dsw-alias-label-primary);}
.FGS_panel{margin:4px 0 0;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l2);max-height:220px;overflow:auto;}
.FGS_section{margin:4px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.02em;}
.FGS_row{display:flex;align-items:baseline;gap:6px;padding:1px 0;}
.FGS_id{font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-secondary);flex:none;}
.FGS_title{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.FGS_tag{flex:none;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-tertiary);padding:0 5px;font-size:10px;}
.FGS_err{color:var(--dsw-alias-state-error-primary);}
`.trim();

    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) !== null) {
        return () => {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    function useSnapshot(intervalMs, sessionId) {
      const [snap, setSnap] = React.useState(null);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const query = typeof sessionId === 'string' && sessionId !== ''
          ? `?sessionId=${encodeURIComponent(sessionId)}`
          : '';
        const tick = async () => {
          try {
            const response = await fetch(`/fgs/state${query}`, { headers: { accept: 'application/json' } });
            const data = await response.json();
            if (!alive) return;
            setSnap(data);
            setError(null);
          } catch (err) {
            if (!alive) return;
            setError(err && err.message ? err.message : String(err));
          }
        };
        tick();
        timer = setInterval(tick, intervalMs);
        return () => {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, [intervalMs, sessionId]);
      return [snap, error];
    }

    function Row(props) {
      return h('div', { className: 'FGS_row' },
        h('span', { className: 'FGS_id' }, props.id),
        props.tag ? h('span', { className: 'FGS_tag' }, props.tag) : null,
        h('span', { className: 'FGS_title', title: props.title || '' }, props.title || ''));
    }

    function Board(props) {
      // 面板只显示当前会话自己的黑板（Host 侧按 sessionId 取图）
      const [snap, error] = useSnapshot(2500, props && props.sessionId);
      const [open, setOpen] = React.useState(false);

      if (error !== null && snap === null) {
        return h('div', { className: 'FGS_root' },
          h('div', { className: 'FGS_bar' },
            h('span', { className: 'FGS_dot FGS_dotBad' }),
            h('span', { className: 'FGS_role' }, 'FGS'),
            h('span', { className: 'FGS_meta FGS_err' }, `/fgs/state 不可达：${error}`)));
      }

      if (snap === null) return null;

      if (snap.active !== true) {
        return h('div', { className: 'FGS_root' },
          h('div', { className: 'FGS_bar' },
            h('span', { className: 'FGS_dot' }),
            h('span', { className: 'FGS_role' }, 'FGS'),
            h('span', { className: 'FGS_meta' }, '未启动 · /fgs new <problemId> [brief]')));
      }

      const counts = snap.counts || {};
      const steps = Array.isArray(snap.steps) ? snap.steps : [];
      const facts = Array.isArray(snap.facts) ? snap.facts : [];
      const goal = Array.isArray(snap.goals) ? snap.goals.find((g) => g.id === 'goal_final') : null;
      const openSteps = steps.filter((s) => s.state === 'open');

      return h('div', { className: 'FGS_root' },
        h('div', { className: 'FGS_bar' },
          h('span', { className: `FGS_dot ${snap.satisfied ? 'FGS_dotOn' : ''}` }),
          h('span', { className: 'FGS_role' }, `FGS · ${snap.role || '?'}`),
          h('span', { className: 'FGS_meta' },
            h('b', null, String(counts.facts ?? 0)), ' facts · ',
            h('b', null, String(counts.open ?? 0)), ' open · ',
            h('b', null, String(counts.steps ?? 0)), ' steps'),
          h('span', { className: 'FGS_meta' }, snap.satisfied ? 'goal ✓' : 'goal ✗'),
          h('span', { className: 'FGS_spacer' }),
          h('button', {
            type: 'button',
            className: 'FGS_toggle',
            onClick: () => setOpen((v) => !v),
            'aria-expanded': open,
          }, open ? '收起' : '展开')),

        open ? h('div', { className: 'FGS_panel' },
          h('div', { className: 'FGS_section' }, `open steps (${openSteps.length})`),
          openSteps.length === 0
            ? h('div', { className: 'FGS_row' }, h('span', { className: 'FGS_title' }, '—'))
            : openSteps.map((s) => h(Row, { key: s.id, id: s.id, tag: s.priority, title: s.action })),
          h('div', { className: 'FGS_section' }, `steps (${steps.length})`),
          steps.map((s) => h(Row, { key: s.id, id: s.id, tag: s.state, title: s.to ? `${s.action} → ${s.to}` : s.action })),
          h('div', { className: 'FGS_section' }, `facts (${facts.length})`),
          facts.map((f) => h(Row, { key: f.id, id: f.id, title: f.title })),
          goal && goal.satisfiedReason
            ? h('div', { className: 'FGS_section' }, `satisfied: ${goal.satisfiedReason}`)
            : null)
          : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const removeStyles = installStyles();
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => removeStyles);
        }
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'fgs-deepseek',
          order: 21,
        }, Board));
      },
    };
  },
});
