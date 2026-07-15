# Runtime-generated c<A><M><E> alias matrix for Keeper tmux shells.
#   A ∈ 0..3  → zero-based cswap account inventory position
#   M ∈ s|o|f → sonnet | opus | fable
#   E ∈ low | med | high | xhigh | max
# Tiers (each independent): c{A}  c{M}  c{A}{M}  c{M}{E}  c{A}{M}{E}  — 94 total.
# Account selectors match Keeper's cN statusline labels; bare `claude` keeps
# automatic account routing.

_keeper_define_claude_matrix() {
  local -A accounts=(
    0  c0
    1  c1
    2  c2
    3  c3
  )
  local -A models=(
    s  sonnet
    o  opus
    f  fable
  )
  local -A efforts=(
    low    low
    med    medium
    high   high
    xhigh  xhigh
    max    max
  )
  local account_key account_value model_key model_value effort_key effort_value

  for account_key account_value in "${(@kv)accounts}"; do
    alias "c${account_key}=keeper agent claude --x-account ${account_value}"
    for model_key model_value in "${(@kv)models}"; do
      alias "c${account_key}${model_key}=keeper agent claude --x-account ${account_value} --model ${model_value}"
      for effort_key effort_value in "${(@kv)efforts}"; do
        alias "c${account_key}${model_key}${effort_key}=keeper agent claude --x-account ${account_value} --model ${model_value} --effort ${effort_value}"
      done
    done
  done

  for model_key model_value in "${(@kv)models}"; do
    alias "c${model_key}=keeper agent claude --model ${model_value}"
    for effort_key effort_value in "${(@kv)efforts}"; do
      alias "c${model_key}${effort_key}=keeper agent claude --model ${model_value} --effort ${effort_value}"
    done
  done
}

_keeper_define_claude_matrix
unfunction _keeper_define_claude_matrix
