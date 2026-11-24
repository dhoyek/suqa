// The one thing the app uses from react-dom (the POS dialogs' portal). Declared here so the build does not need another package.
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react';
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal;
}
