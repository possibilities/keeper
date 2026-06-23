/**
 * Golden `git push` failure stderr strings CAPTURED FROM REAL GIT ONCE (never
 * hand-authored — see the epic spec's Pantera convention). The commit-work push
 * leg (`src/commit-work/push.ts`) and the docs-pusher hook
 * (`plugins/keeper/plugin/hooks/docs-pusher.ts`) each carry a `classifyPushError`
 * that keys autopilot dispatch retries / the skip-log class off these well-known
 * substrings; the de-git tests feed these goldens to a faked git runner so every
 * classifier branch stays covered with zero network and zero real push.
 *
 * Capture recipe (re-run against real git if a git version changes the wording):
 *   non_fast_forward  — push to a bare origin a second clone already advanced
 *   hook_rejected     — push to a bare origin whose pre-receive hook exits 1
 *   auth              — push to github https with bogus baduser:badtoken creds
 *   network           — push to https://example.invalid (Could not resolve host)
 *   no_upstream       — push with push.default=upstream and no tracking ref
 *
 * Each string is the verbatim combined stdout+stderr a failed push emits (the
 * classifier matches against `(stdout + stderr).trim()`), trailing whitespace
 * preserved as git emits it. DO NOT edit by hand — re-capture instead.
 */

/** `! [rejected] main -> main (fetch first)` + the failed-to-push error. */
export const PUSH_NON_FAST_FORWARD =
  "To /tmp/origin.git\n" +
  " ! [rejected]        main -> main (fetch first)\n" +
  "error: failed to push some refs to '/tmp/origin.git'\n" +
  "hint: Updates were rejected because the remote contains work that you do not\n" +
  "hint: have locally. This is usually caused by another repository pushing to\n" +
  "hint: the same ref. If you want to integrate the remote changes, use\n" +
  "hint: 'git pull' before pushing again.\n" +
  "hint: See the 'Note about fast-forwards' in 'git push --help' for details.";

/** `! [remote rejected] main -> main (pre-receive hook declined)`. */
export const PUSH_HOOK_REJECTED =
  "remote: remote rejecting on purpose        \n" +
  "To /tmp/origin.git\n" +
  " ! [remote rejected] main -> main (pre-receive hook declined)\n" +
  "error: failed to push some refs to '/tmp/origin.git'";

/** `fatal: Authentication failed for '<url>'`. */
export const PUSH_AUTH_FAILED =
  "remote: Invalid username or token. Password authentication is not supported for Git operations.\n" +
  "fatal: Authentication failed for 'https://github.com/torvalds/linux.git/'";

/** `Could not resolve host: <host>`. */
export const PUSH_NETWORK =
  "fatal: unable to access 'https://example.invalid/nope.git/': Could not resolve host: example.invalid";

/** `fatal: The current branch <b> has no upstream branch.` */
export const PUSH_NO_UPSTREAM =
  "fatal: The current branch main has no upstream branch.\n" +
  "To push the current branch and set the remote as upstream, use\n" +
  "\n" +
  "    git push --set-upstream origin main\n" +
  "\n" +
  "To have this happen automatically for branches without a tracking\n" +
  "upstream, see 'push.autoSetupRemote' in 'git help config'.";
