import {useEffect, useRef, useState} from 'react';
import {MarkdownText} from './MarkdownText.tsx';

// 拍间隔：决定要求每拍至少 ~50ms，取 60ms 略高于下限、跟常见刷新率合拍。
// 按块吐＋节流，不做 rAF 级合批（渲染合批两条已搁置，见
// docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」的决定变更记录）。
const TICK_MS = 60;

// 已经开演过的消息 id（模块级）：保证「每条消息只放映一次」跨组件实例成立——
// 切会话会整棵重挂载 ChatMain，回来时不重播。只存内存，刷新页面即清空：
// 刷新恢复的回答本来就不放映。
const everStarted = new Set<string>();

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 总拍数：先按「目标总时长 = clamp(文本长度 × 15ms, 1s, 3s)」算——短文至少
 * 1 秒（别太快），长文封顶 3 秒（越长吐字越快，速度自适应）；再折成 60ms
 * 一拍的拍数，夹在 [17, 50]。每拍字数 = ceil(全文长度 / 拍数)，每拍按当下
 * 全文重算：上游分块到达、放映中文本变长时，剩余内容仍按原拍数吐完。
 *
 * 拍数封顶 50 就是 MarkdownText 重解析次数的上限（memo 随前缀增长必然失效，
 * 无法避免），累计解析量约等于 25 遍全文，远低于掉帧量级——这是块大小与
 * 节流值的取舍理由。
 */
function tickCount(length: number): number {
  const durationMs = Math.min(3000, Math.max(1000, length * 15));
  return Math.min(50, Math.max(17, Math.round(durationMs / TICK_MS)));
}

/**
 * 打字机放映：上游答案整块到达后，把「本轮刚收到」的回答渐进放映出来
 * （规则拍板记录见 docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」）。
 *
 * 放映只是视觉层：message.text 状态自始是全文，复制按钮、错误边界的降级
 * 文本拿到的都是全文。读屏不逐字：渐显部分 aria-hidden，另配一个 sr-only
 * 全文节点，辅助技术一次拿到全文；放映结束两层撤掉，DOM 与现状一致。
 *
 * present 被父层撤下（用户点停止、轮次以断流/中止收场）时立刻全显——撤销
 * 直接从 props 派生，不走状态翻转；历史消息、刷新恢复、断线补回的回答根本
 * 不会进 presentIds，天然全显。
 */
export function TypewriterText({
  id,
  text,
  present,
  onEnd,
  onReveal,
  copyLabel,
  copiedLabel,
}: {
  /** 消息 id：「每条消息只放映一次」的判定依据。 */
  id: string;
  /** 全文。放映中它也可能变长（上游分块到达的兜底），每拍按最新值算块大小。 */
  text: string;
  /** 父层标记：这条消息处在「该放映」期间（轮次引擎的 presentIds）。 */
  present: boolean;
  /** 放映结束（放完或取消）：父层据此把 id 移出登记。幂等，重复调用无害。 */
  onEnd: (id: string) => void;
  /** 每拍长高后回调：滚动容器贴底时靠它持续跟随。 */
  onReveal: () => void;
  copyLabel: string;
  copiedLabel: string;
}) {
  // 只在首渲染判定一次：本轮刚收到、从没放映过、且没开减弱动态效果才开演。
  // 组件重渲染不重跑这个判定，滚动、切标签页回来都不会重播。
  // 引擎的放映标记和全文在同一批 setState 里落地，挂载时 present 一定已就位；
  // 万一晚到一帧，下面的销号效果会把它收敛成「不放映、直接全显」，不追帧。
  const [running, setRunning] = useState(
    () => present && !everStarted.has(id) && !prefersReducedMotion(),
  );
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // 异步回调跨渲染拿最新值：统一走 ref 镜像（渲染期间写 ref 是被禁止的）。
  const textRef = useRef(text);
  const onEndRef = useRef(onEnd);
  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    textRef.current = text;
    onEndRef.current = onEnd;
    onRevealRef.current = onReveal;
  });

  // 放映中 = 自己还在跑 且 父层没撤销。撤销（停止/中止/断流）由 present 直接
  // 派生：present 变 false 的这一帧就全显，定时器随效果清理停掉。
  const presenting = running && present;

  function stopTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // 放映定时器：吐字推进和收尾都在 interval 回调里做（事件驱动的 setState，
  // 不在效果体内同步 setState）。StrictMode 下效果「跑—清—再跑」：进度在
  // revealed 状态和 ref 里，重跑只是接着吐，不会从头重播。
  useEffect(() => {
    if (!presenting) {
      return;
    }
    everStarted.add(id);
    timerRef.current = window.setInterval(() => {
      const full = textRef.current;
      const step = Math.max(1, Math.ceil(full.length / tickCount(full.length)));
      const next = Math.min(full.length, revealedRef.current + step);
      revealedRef.current = next;
      setRevealed(next);
      if (next >= full.length) {
        // 吐到当前全文末尾就收尾（全显、销号）。收尾之后文本再变长（上游
        // 分块、极罕见）直接全显，不二次放映——「每条消息只放映一次」优先。
        stopTimer();
        setRunning(false);
        onEndRef.current(id);
      }
    }, TICK_MS);
    return () => {
      stopTimer();
    };
  }, [presenting, id]);

  // 每拍长高：通知滚动容器贴底跟随（消息数组不变，外面的滚动效果指望不上）。
  useEffect(() => {
    if (!presenting) {
      return;
    }
    onRevealRef.current();
  }, [revealed, presenting]);

  // 挂着号却没在放映的几种情况统一销号，别让 id 留在引擎的集合里：
  // 放映过一半切走再回来（真重挂载）、减弱动态效果的用户、刚收尾还没等到
  // 父层更新的一帧。onEnd 幂等，重复调用无害。
  useEffect(() => {
    if (present && !presenting) {
      onEndRef.current(id);
    }
  }, [present, presenting, id]);

  if (!presenting) {
    return <MarkdownText text={text} copyLabel={copyLabel} copiedLabel={copiedLabel} />;
  }
  return (
    <>
      {/* 视觉层：渐进显示的 Markdown，不进读屏；辅助技术的内容在下面。 */}
      <div aria-hidden="true">
        <MarkdownText
          text={text.slice(0, revealed)}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
        />
      </div>
      {/* 读屏一次拿到全文，不逐字播报；放映结束后本节点撤掉，
          可访问结构与不打字机时一致。 */}
      <span className="sr-only">{text}</span>
    </>
  );
}
