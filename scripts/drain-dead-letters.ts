#!/usr/bin/env bun
// One-off: drain every `waiting` dead-letter via the replay_dead_letter RPC.
// Each call recovers the oldest waiting row; null recovered_dl_id == empty.
import { sendReplayDeadLetterRpc, type ReplayDeadLetterRpcResult } from "../cli/board";
import { resolveSockPath } from "../src/db";

const sock = resolveSockPath();
let recovered = 0;
const MAX = 100000; // defensive backstop against a runaway loop
for (let i = 0; i < MAX; i++) {
  let res: ReplayDeadLetterRpcResult;
  try {
    res = await sendReplayDeadLetterRpc(sock);
  } catch (err) {
    console.error(`[drain] RPC error after ${recovered} recovered:`, (err as Error).message);
    process.exit(1);
  }
  if (res.recovered_dl_id === null) {
    console.log(`[drain] backlog empty after ${recovered} recovered`);
    break;
  }
  recovered++;
  if (recovered % 10 === 0) console.log(`[drain] recovered ${recovered} …`);
}
console.log(`[drain] done — ${recovered} dead-letters replayed`);
