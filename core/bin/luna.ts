#!/usr/bin/env node
// `luna` — Luna in the terminal (src/cli/chat.ts). Node >= 22.18 runs this
// TypeScript file directly; `pnpm luna --resume` passes arguments.
import { main } from "../src/cli/chat.ts";

await main();
