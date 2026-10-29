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
  return (
    <p
      className={bubbleClass('assistant', entering)}
      role="status"
      aria-label={label}
      onAnimationEnd={onAnimationEnd}
    >
      <span
        className="flex items-center gap-1"
        aria-hidden="true"
        onAnimationEnd={(event) => event.stopPropagation()}
      >
        <span className="size-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:0ms] motion-reduce:animate-none" />
        <span className="size-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:150ms] motion-reduce:animate-none" />
        <span className="size-1.5 animate-bounce rounded-full bg-stone-400 [animation-delay:300ms] motion-reduce:animate-none" />
      </span>
    </p>
  );
}
