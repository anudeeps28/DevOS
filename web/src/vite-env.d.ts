/// <reference types="vite/client" />

// Side-effect CSS imports (e.g. `import './index.css'`) — ambient module so the
// TypeScript build (which emits to node_modules/.tmp for typecheck) resolves them.
declare module '*.css';
