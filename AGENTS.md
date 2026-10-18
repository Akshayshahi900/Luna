# Repository Rules & Workflow Constraints

## Mandatory Actions
- **Memory & Decisions**: Every time a structural or architectural decision is made, you must immediately update `DECISIONS.md`.
- **Architecture**: Ensure `ARCHITECTURE.md` is updated if system topology, data flows, or file structures change.
- **Testing**: Never mark a task complete without writing corresponding tests. Always run the test suite and verify they pass before finalizing.
- **Documentation**: Update code comments and technical docs in the `/docs` folder alongside code changes.
- **spec/**:  Update the spec file too according to the changes done.

## Guardrails
- Match existing code styles and patterns.
- Do not edit unrelated files.
- Dont run automatically the test cases as it consume free LLMs limits.