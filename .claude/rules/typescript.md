---
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

# TypeScript Code Style

- **TypeScript:** Strict mode enabled. Prefer explicit types for exported functions and API responses. Avoid `any`.
- **Imports:** Use absolute paths with aliases (e.g., `@/components/...`) where configured. Do not use deeply nested relative paths (`../../..`).
- **Formatting:** Handled via Prettier/ESLint. Run validation before committing code.
- **Error Handling:** Wrap async operations in try/catch blocks; use robust error boundaries and explicit logging via the internal logger.
