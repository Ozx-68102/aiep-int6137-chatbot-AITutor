import {bubbleClass} from './message-class.ts';

export function ThinkingBubble({
  entering,
  label,
  progress,
  onAnimationEnd,
}: {
  entering: boolean;
  label: string;
  /** 上游工作流最新节点名，原样显示；不进读屏播报（下面的 aria-hidden）。 */
  progress?: string | undefined;
  onAnimationEnd: () => void;
}) {
  const classes = bubbleClass('assistant', entering);
  return (
    <div className={classes.wrap}>
      <p
        className={classes.bubble}
        role="status"
        aria-label={label}
        onAnimationEnd={onAnimationEnd}
      >
        <span
          className="flex items-center gap-1 text-stone-400"
          aria-hidden="true"
          onAnimationEnd={(event) => event.stopPropagation()}
        >
          <span className="loading loading-dots" />
        </span>
        {progress ? (
          // 进度只做视觉展示：气泡上的 role="status" 是活区域，aria-hidden
          // 让读屏维持只播报「正在思考」，不随节点名变化反复播报。
          <span className="mt-1 block text-sm text-stone-400" aria-hidden="true">
            {progress}
          </span>
        ) : null}
      </p>
    </div>
  );
}
