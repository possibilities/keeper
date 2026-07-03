## Overview

The `lane_merged` observable (and therefore `keeper await landed`) false-fires on a
started epic whose lane branch exists but carries zero commits: a freshly-cut lane's tip
IS its fork point, so the present-lane arm's ancestor-of-default probe is vacuously true
and the epic reads "landed" while every task is still running. Witnessed live: an await
on a just-dispatched epic insta-met at arm time with all tasks running and no merge on
default. The daisy-chain orchestration pattern relies on `landed` being sound.

## Quick commands

- `keeper await landed <epic>` armed against a freshly-dispatched epic must HOLD, not insta-met

## Acceptance

- [ ] An armed `landed` await on a started epic with an empty (zero-commit) lane holds until real work merges
- [ ] A merged-then-torn-down lane and a merged-not-yet-torn-down lane still both read landed
