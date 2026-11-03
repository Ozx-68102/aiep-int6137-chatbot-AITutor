import {bubbleClass} from './message-class.ts';

export function ThinkingBubble({
  entering,
  label,
  onAnimationEnd,
}: {
  entering: boolean;
  label: string;
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
      </p>
    </div>
  );
}
