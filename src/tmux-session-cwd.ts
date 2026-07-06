import { homedir } from "node:os";

/**
 * Directory keeper uses when it mints a tmux session. Plain `new-window` uses
 * tmux's session working directory, so keeper-created sessions start at the
 * user's home while each managed pane still sets its own project/worktree cwd.
 */
export function keeperTmuxSessionCwd(env: NodeJS.ProcessEnv): string {
  const home = (env.HOME ?? "").trim();
  return home !== "" ? home : homedir();
}
