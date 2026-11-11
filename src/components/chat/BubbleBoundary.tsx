import {Component, type ErrorInfo, type ReactNode} from 'react';

type BubbleBoundaryState = {failed: boolean};

/**
 * 气泡级的错误边界：Markdown 渲染出错就把这一条降级成纯文本，
 * 不让一个坏气泡拖垮整个聊天页。
 *
 * failed 状态会一直保持：同一实例内不再自动重试。使用处给它一个随轮次有了最终结果
 * 而变化的 key（见 ChatMain）——重挂载时，流式期间的瞬时渲染错误能
 * 拿最终文本再试一次；最终文本仍坏才停留在纯文本降级。
 */
export class BubbleBoundary extends Component<
  {
    /** 降级时要显示的文字。给函数的话只在真出错时才调用——正常渲染不该为它花解析成本。 */
    fallbackText: string | (() => string);
    children: ReactNode;
  },
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
      const {fallbackText} = this.props;
      const text = typeof fallbackText === 'function' ? fallbackText() : fallbackText;
      return <p className="chat-bubble whitespace-pre-wrap">{text}</p>;
    }
    return this.props.children;
  }
}
