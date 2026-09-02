# AGENTS.md — Regras de Validação

## Syntax Validation (MANDATORY)

Every generated code file MUST pass syntax validation before being declared complete:

- **Python (.py):** Run `python3 -c "import ast; ast.parse(open('FILE.py').read())"` — zero cost, catches all syntax errors instantly
- **TypeScript (.ts) / JavaScript (.js):** Run `npx tsc --noEmit` or equivalent syntax check
- **Never declare a code file ready without running the appropriate syntax check first**

This prevents common LLM errors like missing brackets, unclosed strings, wrong indentation, etc.

## Tool Call Format

Use the `TOOL: name | {json}` format for tool calls. The parser converts this to structured `tool_calls` in the response.

Example:
```
TOOL: write_file | {"path": "output.py", "content": "print('hello')"}
```
