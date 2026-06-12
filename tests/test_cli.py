from .conftest import run_cli


def test_cli_help():
    result = run_cli(["--help"])
    assert result.exit_code == 0
    assert "planctl" in result.output.lower()


def test_cli_help_no_scout_or_interview_subcommands():
    """Guard against re-introduction of removed CLI surfaces."""
    result = run_cli(["--help"])
    assert result.exit_code == 0
    # These subcommand groups are removed and must not come back.
    assert "scout" not in result.output.lower()
    assert "interview" not in result.output.lower()


def test_cli_help_no_config_subcommand():
    """Guard against re-introduction of the removed `config` subgroup.

    There is no watch config surface — keeper dispatch uses a single hardcoded
    shared in-flight slot.
    """
    result = run_cli(["--help"])
    assert result.exit_code == 0
    # `config` must not appear as its own subcommand. Scope the assertion to
    # the subcommand-listing region (everything from `Commands:` onward) so a
    # future `--config` flag or a docstring mention of "config" elsewhere in
    # the help text does not silently fail this test for the wrong reason.
    import re as _re

    commands_match = _re.search(
        r"^Commands:\n(?P<body>(?: .*\n?)+)", result.output, _re.MULTILINE
    )
    assert commands_match is not None, (
        f"Expected a `Commands:` section in --help output:\n{result.output}"
    )
    commands_body = commands_match.group("body")
    # Each command line starts with two-space indent followed by the name.
    assert _re.search(r"^  config\b", commands_body, _re.MULTILINE) is None, (
        f"`config` subgroup must not be registered; got commands section:\n{commands_body}"
    )


def test_cli_config_show_errors_as_unknown_command():
    """`planctl config show` must error — the subgroup is gone."""
    result = run_cli(["config", "show"])
    # click returns non-zero (typically 2) on unknown commands.
    assert result.exit_code != 0
