/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module '*?raw' {
  const source: string;
  export default source;
}
