import {Component, type ErrorInfo, type ReactNode} from 'react';

type BubbleBoundaryState = {failed: boolean};

/**
 * 气泡级的错误边界：Markdown 渲染坏了就把这一条降级成纯文本，
 * 不让一个坏气泡拖垮整个聊天页。
 */
export class BubbleBoundary extends Component<
  {fallbackText: string; children: ReactNode},
  BubbleBoundaryState
> {
  state: BubbleBoundaryState = {failed: false};

  static getDerivedStateFromError(): BubbleBoundaryState {
    return {failed: true};
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('bubble render failed', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <p className="chat-bubble whitespace-pre-wrap">{this.props.fallbackText}</p>;
    }
    return this.props.children;
  }
}
