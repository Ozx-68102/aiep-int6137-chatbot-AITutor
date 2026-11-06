import {useEffect, useRef, useState} from 'react';
import {MarkdownText} from './MarkdownText.tsx';

// 周期间隔：决定要求每个周期至少 ~50ms，取 60ms 略高于下限、跟常见刷新率对得上。
// 按块显示＋节流，不做 rAF 级批处理（渲染批处理两条已搁置，见
// docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」的决定变更记录）。
const TICK_MS = 60;

// 已经开始播放过的消息 id（模块级）：保证「每条消息只播放一次」跨组件实例成立——
// 切会话会整棵重挂载 ChatMain，回来时不重播。只存内存，刷新页面即清空：
// 刷新恢复的回答本来就不播放。
const everStarted = new Set<string>();

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 总周期数：先按「目标总时长 = clamp(文本长度 × 15ms, 1s, 3s)」算——短文至少
 * 1 秒（别太快），长文封顶 3 秒（越长字显示得越快，速度自适应）；再按 60ms
 * 一个周期折算出周期数，夹在 [17, 50]。每个周期的字数 = ceil(全文长度 / 周期数)，每个周期按当下
 * 全文重算：上游分块到达、播放中文本变长时，剩余内容仍按原周期数显示完。
 *
 * 周期数封顶 50 就是 MarkdownText 重解析次数的上限（memo 随前缀增长必然失效，
 * 无法避免），累计解析量约等于 25 遍全文，远低于掉帧量级——这是块大小与
 * 节流值的取舍理由。
 */
function tickCount(length: number): number {
  const durationMs = Math.min(3000, Math.max(1000, length * 15));
  return Math.min(50, Math.max(17, Math.round(durationMs / TICK_MS)));
}

/**
 * 打字机播放：上游答案整块到达后，把「本轮刚收到」的回答渐进播放出来
 * （规则决定记录见 docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」）。
 *
 * 播放只是视觉层：message.text 状态自始是全文，复制按钮、错误边界的降级
 * 文本拿到的都是全文。读屏不逐字：渐进显示部分 aria-hidden，另配一个 sr-only
 * 全文节点，辅助技术一次拿到全文；播放结束两层撤掉，DOM 与现状一致。
 *
 * present 被父层撤下（用户点停止、轮次以断流/中止收场）时立刻全部显示——撤销
 * 直接从 props 派生，不走状态翻转；历史消息、刷新恢复、断线补回的回答根本
 * 不会进 presentIds，天然全部显示。
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
  /** 消息 id：「每条消息只播放一次」的判定依据。 */
  id: string;
  /** 全文。播放中它也可能变长（上游分块到达时的保底处理），每个周期按最新值算块大小。 */
  text: string;
  /** 父层标记：这条消息处在「该播放」期间（轮次引擎的 presentIds）。 */
  present: boolean;
  /** 播放结束（放完或取消）：父层据此把 id 移出登记。幂等，重复调用无害。 */
  onEnd: (id: string) => void;
  /** 每个周期长高后回调：滚动容器贴底时靠它持续跟随。 */
  onReveal: () => void;
  copyLabel: string;
  copiedLabel: string;
}) {
  // 只在首渲染判定一次：本轮刚收到、从没播放过、且没开减弱动态效果才开始播放。
  // 组件重渲染不重跑这个判定，滚动、切标签页回来都不会重播。
  // 引擎的播放标记和全文在同一批 setState 里生效，挂载时 present 一定已就位；
  // 万一晚到一帧，下面的移出登记效果会把它收敛成「不播放、直接全部显示」，不追赶落下的帧。
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

  // 播放中 = 自己还在跑 且 父层没撤销。撤销（停止/中止/断流）由 present 直接
  // 派生：present 变 false 的这一帧就全部显示，定时器随效果清理停掉。
  const presenting = running && present;

  function stopTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // 播放定时器：逐字显示的推进和收尾都在 interval 回调里做（事件驱动的 setState，
  // 不在效果体内同步 setState）。StrictMode 下效果「跑—清—再跑」：进度在
  // revealed 状态和 ref 里，重跑只是接着显示，不会从头重播。
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
        // 显示到当前全文末尾就收尾（全部显示、移出登记）。收尾之后文本再变长（上游
        // 分块、极罕见）直接全部显示，不二次播放——「每条消息只播放一次」优先。
        stopTimer();
        setRunning(false);
        onEndRef.current(id);
      }
    }, TICK_MS);
    return () => {
      stopTimer();
    };
  }, [presenting, id]);

  // 每个周期长高：通知滚动容器贴底跟随（消息数组不变，外面的滚动效果指望不上）。
  useEffect(() => {
    if (!presenting) {
      return;
    }
    onRevealRef.current();
  }, [revealed, presenting]);

  // 登记着却没在播放的几种情况统一移出登记，别让 id 留在引擎的集合里：
  // 播放过一半切走再回来（真重挂载）、减弱动态效果的用户、刚收尾还没等到
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
      {/* 读屏一次拿到全文，不逐字播报；播放结束后本节点撤掉，
          可访问结构与不打字机时一致。 */}
      <span className="sr-only">{text}</span>
    </>
  );
}
