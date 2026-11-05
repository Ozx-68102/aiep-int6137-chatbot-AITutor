import {Component, type ErrorInfo, type ReactNode} from 'react';
import {translations} from '../../i18n/index.ts';
import {readCachedProfile} from '../../session/profile-cache.ts';
import {localeFromSystem} from '../../type/locale.ts';

type PageBoundaryState = {failed: boolean};

/**
 * 整页的错误边界：渲染真崩了也要给一句话加一个刷新按钮，不白屏。
 * 语言用本地记着的那份；读不到就按系统语言来。
 */
export class PageBoundary extends Component<{children: ReactNode}, PageBoundaryState> {
  state: PageBoundaryState = {failed: false};

  static getDerivedStateFromError(): PageBoundaryState {
    return {failed: true};
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('page render failed', error, errorInfo);
  }

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    const locale = readCachedProfile()?.locale ?? localeFromSystem();
    const text = translations[locale];
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-stone-100 p-6">
        <p className="m-0 text-base">{text.pageError}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          {text.refreshPage}
        </button>
      </div>
    );
  }
}
