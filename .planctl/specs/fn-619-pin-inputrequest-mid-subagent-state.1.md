## Description

Finding F6 from the fn-617-add-input-request-pill audit. The Stop arm at test/reducer.test.ts:524 has a dedicated test "Stop is a no-op on state while a sub-agent is running" that inserts a running subagent_invocations row and asserts jobs.state stays unchanged. The InputRequest arm has no equivalent — it intentionally omits the sub-agent guard (a question to a human blocks progress regardless), but that behavioral choice is untested. Mirror the existing Stop test's setup (insert a SubagentStart row so status='running', then emit InputRequest) and assert that state flips to 'stopped' AND (last_input_request_at, last_input_request_kind) are stamped — the opposite of Stop's assertion.

## Acceptance

- [ ] New test in test/reducer.test.ts: "InputRequest on a session with a running subagent_invocations row still flips state to 'stopped' and stamps the (at, kind) pair"
- [ ] bun test test/reducer.test.ts passes

## Done summary

## Evidence
