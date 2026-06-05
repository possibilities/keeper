"""Byte-identity smoke for the ``planctl._util`` CLI mechanics.

``planctl/_util.py`` owns planctl's formatting / atomic-write / error
helpers. The acceptance bar is that ``--format {json,yaml}`` and
``--help-json`` output is byte-stable: the tests pin the expected output
strings directly and invoke only the ``planctl._util`` helpers.
"""

from __future__ import annotations

import click
from click.testing import CliRunner
from planctl._util import (
    FormattedGroup,
    atomic_write,
    format_output,
    json_dumps,
    yaml_dump,
)


def test_atomic_write_byte_identical_pinned(tmp_path):
    """``atomic_write`` produces the pinned byte sequence."""
    payload = "alpha\nbeta\ngamma\n"
    target = tmp_path / "vendored.txt"
    atomic_write(target, payload)
    assert target.read_bytes() == b"alpha\nbeta\ngamma\n"


def test_json_dumps_byte_identical_pinned():
    """JSON serialisation matches the pinned encoder output byte-for-byte."""
    data = {
        "string": "héllo",  # exercises ensure_ascii=False
        "list": [1, 2, 3],
        "nested": {"k": "v", "n": None},
    }
    expected = (
        "{\n"
        '  "string": "héllo",\n'
        '  "list": [\n'
        "    1,\n"
        "    2,\n"
        "    3\n"
        "  ],\n"
        '  "nested": {\n'
        '    "k": "v",\n'
        '    "n": null\n'
        "  }\n"
        "}\n"
    )
    assert json_dumps(data) == expected


def test_yaml_dump_byte_identical_pinned():
    """YAML serialisation matches the pinned encoder output byte-for-byte."""
    data = {
        "title": "single line",
        "body": "multi\nline\nblock",  # exercises the literal-block representer
    }
    expected = "title: single line\nbody: |-\n  multi\n  line\n  block\n"
    assert yaml_dump(data) == expected


def _build_cli():
    """Build a trivial CLI with a single subcommand exercising FormattedGroup."""

    @click.group(cls=FormattedGroup)
    def cli():
        """Top-level group used by the byte-identity smoke."""

    @cli.command()
    @click.argument("name")
    @click.option("--shout", is_flag=True, help="UPPERCASE the greeting")
    def greet(name, shout):
        """Greet someone by name."""
        msg = f"hello {name}"
        click.echo(msg.upper() if shout else msg)

    return cli


def test_group_help_byte_identical_pinned():
    """``--help`` output on a FormattedGroup matches the pinned string."""
    cli = _build_cli()
    result = CliRunner().invoke(cli, ["--help"])
    expected = (
        "Usage: cli [OPTIONS] COMMAND [ARGS]...\n"
        "\n"
        "  Top-level group used by the byte-identity smoke.\n"
        "\n"
        "Options:\n"
        "  --format [json|yaml|human]  Output format (default: json)\n"
        "  --help                      Show this message and exit.\n"
        "\n"
        "Commands:\n"
        "  greet  Greet someone by name.\n"
    )
    assert result.exit_code == 0
    assert result.output == expected


def test_subcommand_help_json_byte_identical_pinned():
    """``--help-json`` on an auto-injected subcommand matches the pinned string."""
    cli = _build_cli()
    result = CliRunner().invoke(cli, ["greet", "--help-json"])
    expected = (
        "{\n"
        '  "name": "greet",\n'
        '  "description": "Greet someone by name.",\n'
        '  "arguments": [\n'
        "    {\n"
        '      "name": "name",\n'
        '      "type": "text",\n'
        '      "required": true,\n'
        '      "positional": true,\n'
        '      "description": ""\n'
        "    },\n"
        "    {\n"
        '      "name": "--shout",\n'
        '      "type": "flag",\n'
        '      "required": false,\n'
        '      "description": "UPPERCASE the greeting"\n'
        "    },\n"
        "    {\n"
        '      "name": "--format",\n'
        '      "type": "choice",\n'
        '      "required": false,\n'
        '      "choices": [\n'
        '        "json",\n'
        '        "yaml",\n'
        '        "human"\n'
        "      ],\n"
        '      "description": "Output format (default: json)"\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )
    assert result.exit_code == 0
    assert result.output == expected


def test_format_yaml_envelope_byte_identical_pinned():
    """A subcommand emitting via ``format_output(...)`` under ``--format
    {json,yaml}`` must produce the pinned byte sequences.
    """
    payload = {"success": True, "items": ["a", "b"], "note": "line one\nline two"}

    @click.group(cls=FormattedGroup)
    def cli():
        pass

    @cli.command()
    def echo():
        format_output(payload)

    expected_json = (
        "{\n"
        '  "success": true,\n'
        '  "items": [\n'
        '    "a",\n'
        '    "b"\n'
        "  ],\n"
        '  "note": "line one\\nline two"\n'
        "}\n"
    )
    expected_yaml = (
        "success: true\nitems:\n- a\n- b\nnote: |-\n  line one\n  line two\n"
    )
    expected = {"json": expected_json, "yaml": expected_yaml}

    for fmt in ("json", "yaml"):
        result = CliRunner().invoke(cli, ["echo", "--format", fmt])
        assert result.exit_code == 0, result.output
        assert result.output == expected[fmt], (
            f"--format {fmt} output diverged from pinned expected:\n"
            f"expected: {expected[fmt]!r}\nactual:   {result.output!r}"
        )
