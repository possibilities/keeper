"""Generic CLI mechanics for planctl.

This module is the planctl-internal home for the small set of generic Click
mechanics planctl needs. Self-contained here so planctl carries no hard code
dependency on any arthack-internal shared utility package and can move to its
own top-level repo coupled to arthack only as a Claude plugin + CLI.

Public surface (used by planctl code):

- :func:`atomic_write` — atomic file write via temp + rename + fsync.
- :func:`format_output` — sole stdout emission path; reads the ambient
  ``--format`` from the active Click context.
- :func:`yaml_dump` / :func:`json_dumps` — serialisation helpers used by
  ``format_output``.
- :class:`FormattedGroup` — Click group subclass that injects
  ``--format {json,yaml,human}`` and ``--help-json`` onto every subcommand.
  ``planctl/cli.py`` subclasses this as ``InvocationTrackedGroup``.
- :func:`agent_help_option` — decorator that adds ``--agent-help`` /
  ``--agent-teaser`` to a Click command.
- :func:`run_cli` — Click runner wrapper with consistent error handling and
  SIGPIPE management. There is no per-invocation audit-log hook: planctl's
  invocation NDJSON envelope on stdout is the authoritative audit signal.

What is NOT vendored (intentionally):

- ``click`` itself — keeping it as a normal dep ensures one click module object
  in process. Two click copies break ``isinstance(x, click.Group)`` across the
  boundary, which is load-bearing for ``InvocationTrackedGroup.invoke``'s
  subgroup short-circuit.
- ``format_table`` / ``DescribedArgument`` / ``package_description`` /
  ``strip_trailing_emojis`` / ``format_time_since`` — unused by planctl.

The byte-identity contract for ``--format``/``--help-json`` output hinges on
copying every helper called by ``format_output`` and ``FormattedGroup`` —
including private ones (``_json_default``, ``_help_json_callback``,
``_build_command_schema``, ``_click_type_name``, ``_format_option_callback``,
``_FORMAT_OPTION``, ``_generate_subcommand_listing``) — so the rendered text
matches ``cli_common``'s behavior verbatim.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from collections.abc import Callable
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import click

# ---------------------------------------------------------------------------
# atomic_write — atomic file write via temp + rename + fsync
# ---------------------------------------------------------------------------


def atomic_write(path: Path, content: str) -> None:
    """Write file atomically via temp + rename.

    Uses mkstemp in the parent directory so the rename is always
    on the same filesystem (no cross-device move). Fsyncs the parent
    directory after rename so directory entries are durable.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        # fsync parent dir so the directory entry is durable
        parent_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


# ---------------------------------------------------------------------------
# yaml_dump / json_dumps / format_output and their private helpers
# ---------------------------------------------------------------------------


def yaml_dump(data: object) -> str:
    """Dump data to YAML with literal block scalars for multiline strings."""
    import yaml

    class _LiteralDumper(yaml.Dumper):
        pass

    def _str_representer(dumper, data):
        if "\n" in data:
            # Strip trailing whitespace per line so PyYAML can use block style
            cleaned = "\n".join(line.rstrip() for line in data.split("\n"))
            return dumper.represent_scalar("tag:yaml.org,2002:str", cleaned, style="|")
        return dumper.represent_scalar("tag:yaml.org,2002:str", data)

    _LiteralDumper.add_representer(str, _str_representer)

    return yaml.dump(
        data,
        Dumper=_LiteralDumper,
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
    )


def _json_default(obj: object) -> object:
    """JSON encoder fallback for types not handled natively.

    Covers: datetime, date, UUID, Path, Decimal, set, frozenset, dataclasses,
    and Pydantic BaseModel instances.
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, (set, frozenset)):
        return sorted(str(x) for x in obj)
    # dataclass check — must come before Pydantic (Pydantic models are not dataclasses)
    import dataclasses

    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    # Pydantic BaseModel
    model_dump = getattr(obj, "model_dump", None)
    if callable(model_dump):
        return model_dump()
    raise TypeError(f"Object of type {type(obj).__name__!r} is not JSON serializable")


def json_dumps(data: object) -> str:
    """Serialize data to a JSON string.

    - ``sort_keys=False``: preserves insertion order (matches yaml_dump behaviour).
    - ``ensure_ascii=False``: preserves unicode / emoji without \\uXXXX escaping.
    - Trailing newline included so shell consumers see a clean line.
    """
    return json.dumps(data, ensure_ascii=False, indent=2, default=_json_default) + "\n"


def format_output(
    data: object,
    text_renderer: Callable[[object], str] | None = None,
) -> None:
    """Emit *data* to stdout in the ambient --format (json by default, yaml/human opt-in).

    Walks the Click context chain from the current context up to the root,
    returning the first ``obj["format"]`` value found.  Falls back to ``"json"``
    when no context is active or no format has been set.

    When ``format == "human"`` and *text_renderer* is callable, emits
    ``text_renderer(data)`` via ``click.echo``.  When *text_renderer* is None
    (or raises), falls back to JSON so the flag never produces empty output.

    Trailing newline: always present (``json_dumps`` appends one; ``yaml_dump``
    and ``text_renderer`` output are normalised to end with a single newline).

    BrokenPipeError is caught and handled gracefully so ``cli sub | head -1``
    exits 0 without a traceback.
    """
    fmt = "json"
    fmt_explicit = False
    try:
        ctx: click.Context | None = click.get_current_context()
        while ctx is not None:
            if isinstance(ctx.obj, dict) and "format" in ctx.obj:
                fmt = ctx.obj["format"]
                fmt_explicit = True
                break
            ctx = ctx.parent
    except RuntimeError:
        pass

    if not fmt_explicit and getattr(sys.stdout, "isatty", lambda: False)():
        fmt = "human"

    try:
        if fmt == "yaml":
            click.echo(yaml_dump(data).rstrip())
        elif fmt == "human" and callable(text_renderer):
            try:
                rendered = text_renderer(data)
            except Exception:
                rendered = None
            if rendered is not None:
                # Normalise: ensure exactly one trailing newline
                click.echo(rendered.rstrip("\n"))
            else:
                click.echo(json_dumps(data), nl=False)
        else:
            click.echo(json_dumps(data), nl=False)
    except BrokenPipeError:
        # Redirect stdout to /dev/null so subsequent writes don't raise again
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, 1)
        os.close(devnull)


# ---------------------------------------------------------------------------
# FormattedGroup transitive closure
# ---------------------------------------------------------------------------


def _click_type_name(param_type: click.ParamType) -> str:
    """Map a Click parameter type to a simple type name."""
    name = param_type.name.upper()
    return {
        "STRING": "text",
        "TEXT": "text",
        "INT": "int",
        "INTEGER": "int",
        "FLOAT": "float",
        "BOOL": "flag",
        "BOOLEAN": "flag",
    }.get(name, "text")


def _build_command_schema(cmd: click.Command) -> dict:
    """Build a structured schema dict from a Click command."""
    result: dict = {
        "name": cmd.name,
        "description": " ".join((cmd.help or "").split()),
        "arguments": [],
    }
    for param in cmd.params:
        if param.name in ("help", "help_json"):
            continue
        if getattr(param, "hidden", False):
            continue
        arg_info: dict = {}
        if isinstance(param, click.Argument):
            arg_info["name"] = param.name
            arg_info["type"] = _click_type_name(param.type)
            arg_info["required"] = param.required
            arg_info["positional"] = True
        else:
            long_opt = next(
                (o for o in param.opts if o.startswith("--")), param.opts[0]
            )
            arg_info["name"] = long_opt
            if getattr(param, "is_flag", False):
                arg_info["type"] = "flag"
            else:
                arg_info["type"] = _click_type_name(param.type)
            arg_info["required"] = param.required
        if isinstance(param.type, click.Choice):
            arg_info["type"] = "choice"
            arg_info["choices"] = list(param.type.choices)
        arg_info["description"] = getattr(param, "help", None) or ""
        result["arguments"].append(arg_info)
    return result


def _help_json_callback(
    ctx: click.Context, _param: click.Parameter, value: bool
) -> None:
    if not value:
        return
    schema = _build_command_schema(ctx.command)
    click.echo(json_dumps(schema), nl=False)
    ctx.exit(0)


class CleanGroup(click.Group):
    """Custom Group that suppresses the Options section in help output."""

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        """Add --help-json to subcommands automatically."""
        cmd = super().get_command(ctx, cmd_name)
        if cmd is not None and not any(p.name == "help_json" for p in cmd.params):
            cmd.params.append(
                click.Option(
                    ["--help-json"],
                    is_flag=True,
                    is_eager=True,
                    expose_value=False,
                    hidden=True,
                    callback=_help_json_callback,
                    help="Output command schema as JSON",
                )
            )
        return cmd

    def format_options(
        self, ctx: click.Context, formatter: click.HelpFormatter
    ) -> None:
        """Skip the Options section and only format commands."""
        self.format_commands(ctx, formatter)

    def format_commands(
        self, ctx: click.Context, formatter: click.HelpFormatter
    ) -> None:
        """Format commands with full descriptions (no truncation)."""
        commands = []
        for subcommand in self.list_commands(ctx):
            cmd = self.get_command(ctx, subcommand)
            if cmd is None or cmd.hidden:
                continue
            commands.append((subcommand, cmd))

        if commands:
            rows = []
            for subcommand, cmd in commands:
                help_text = cmd.help or ""
                # Take first paragraph, collapse whitespace
                first_para = help_text.split("\n\n")[0]
                help_line = " ".join(first_para.split())
                rows.append((subcommand, help_line))

            if rows:
                with formatter.section("Commands"):
                    formatter.write_dl(rows)


def _format_option_callback(
    ctx: click.Context, _param: click.Parameter, value: str | None
) -> None:
    """Store --format value on ctx.obj so format_output() can read it."""
    if value is None:
        return
    if ctx.obj is None:
        ctx.obj = {}
    if isinstance(ctx.obj, dict):
        ctx.obj["format"] = value


_FORMAT_OPTION = click.Option(
    ["--format"],
    type=click.Choice(["json", "yaml", "human"]),
    default=None,
    is_eager=False,
    expose_value=False,
    callback=_format_option_callback,
    help="Output format (default: json)",
    hidden=False,
)


class FormattedGroup(CleanGroup):
    """CleanGroup subclass that injects --format {json,yaml} onto every subcommand.

    Usage:

        @click.group(cls=FormattedGroup)
        def cli():
            pass

    Each subcommand automatically gains ``--format {json,yaml}`` (default: json).
    The selected format is stored on ``ctx.obj["format"]`` and read by
    ``format_output()``, which is the sole stdout emission path for all output.

    Both invocation positions are supported:
        cli --format yaml sub
        cli sub --format yaml

    Click propagates ``ctx.obj`` from parent to child by default, so a
    group-level ``--format yaml`` is visible to subcommand callbacks via
    ``format_output()``'s ctx-walk.
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # Inject --format on the group itself (cli --format yaml sub)
        if not any(p.name == "format" for p in self.params):
            self.params.append(_FORMAT_OPTION)

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        """Inject --format and --help-json onto subcommands automatically."""
        cmd = super().get_command(ctx, cmd_name)
        if cmd is not None and not any(p.name == "format" for p in cmd.params):
            cmd.params.append(_FORMAT_OPTION)
        return cmd

    def format_options(
        self, ctx: click.Context, formatter: click.HelpFormatter
    ) -> None:
        """Show --format option plus commands (overrides CleanGroup's option suppression)."""
        # Show --format since it's the primary user-facing option on the group
        opts = []
        for param in self.get_params(ctx):
            rv = param.get_help_record(ctx)
            if rv is not None:
                opts.append(rv)
        if opts:
            with formatter.section("Options"):
                formatter.write_dl(opts)
        self.format_commands(ctx, formatter)

    def invoke(self, ctx: click.Context) -> object:
        """Ensure ctx.obj is a dict before subcommand runs."""
        if ctx.obj is None:
            ctx.obj = {}
        return super().invoke(ctx)


def _generate_subcommand_listing(ctx: click.Context) -> str:
    """Generate a subcommand listing from Click metadata."""
    group = ctx.command
    if not isinstance(group, click.Group):
        return ""
    lines = []
    for name in group.list_commands(ctx):
        cmd = group.get_command(ctx, name)
        if cmd is None or cmd.hidden:
            continue
        help_text = cmd.help or ""
        # Skip commands marked as human-only
        if help_text.startswith("(Human only)") or help_text.startswith("(Internal)"):
            continue
        # Extract argument signatures from Click params
        args = [
            p.human_readable_name.upper()
            for p in cmd.params
            if isinstance(p, click.Argument)
        ]
        label = " ".join([name] + args) if args else name
        first_para = help_text.split("\n\n")[0]
        help_line = " ".join(first_para.split())
        lines.append(f"  {label:<36}{help_line}")
    return "\n".join(lines)


_NO_TEASER = object()


def agent_help_option(agent_help: str, agent_teaser: str | object = _NO_TEASER):
    """Decorator that adds --agent-help and --agent-teaser options to a click command.

    Args:
        agent_help: The detailed help content for agents (workflows, tips, etc.)
        agent_teaser: Brief gotcha header (0-3 lines) for the tool-summaries partial.
            When not provided, --agent-teaser exits with code 1.

    Usage:
        @click.group()
        @agent_help_option(AGENT_HELP, AGENT_TEASER)
        def cli():
            pass
    """

    def print_agent_help(ctx: click.Context, _param: click.Parameter, value: bool):
        if value:
            click.echo(agent_help.strip())
            ctx.exit(0)

    def print_agent_teaser(ctx: click.Context, _param: click.Parameter, value: bool):
        if not value:
            return
        if agent_teaser is _NO_TEASER:
            ctx.exit(1)
        parts = []
        teaser_str = str(agent_teaser).strip()
        if teaser_str:
            parts.append(teaser_str)
        listing = _generate_subcommand_listing(ctx)
        if listing:
            parts.append(listing)
            parts.append(
                f"\nRun `{ctx.info_name} <subcommand> --help` for argument details."
            )
        click.echo("\n".join(parts))
        ctx.exit(0)

    def decorator(f):
        f = click.option(
            "--agent-help",
            is_flag=True,
            hidden=True,
            is_eager=True,
            expose_value=False,
            callback=print_agent_help,
            help="Show detailed help for AI agents",
        )(f)
        f = click.option(
            "--agent-teaser",
            is_flag=True,
            hidden=True,
            is_eager=True,
            expose_value=False,
            callback=print_agent_teaser,
            help="Show brief tool summary for AI agents",
        )(f)
        return f

    return decorator


# ---------------------------------------------------------------------------
# run_cli — Click runner wrapper
# ---------------------------------------------------------------------------


def run_cli(cli_func, *, standalone_mode=False) -> int:
    """Run a Click CLI with consistent error handling.

    Handles KeyboardInterrupt, ClickException, SystemExit, and unexpected
    exceptions. With --debug or CLI_DEBUG=1, shows full tracebacks inline.
    Otherwise, writes tracebacks to a temp file and shows a one-line error.

    Installs a SIGPIPE handler so ``cli | jq | head`` doesn't produce a
    traceback when the downstream consumer closes the pipe early.

    There is no per-invocation audit-log hook: planctl emits an authoritative
    ``planctl_invocation`` NDJSON envelope on stdout for every verb (read-only
    verbs via the ``InvocationTrackedGroup`` decorator, mutating verbs via
    ``output.emit``), so no separate local audit log is written.
    """
    import signal

    # Restore SIGPIPE default so broken pipes (e.g. cli | head) exit cleanly.
    # signal.SIGPIPE is not available on Windows; guard accordingly.
    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    debug = _pop_debug_flag()

    # NOTE: There is no per-process audit-log hook in the success/failure
    # finally clauses below. planctl emits an authoritative
    # ``planctl_invocation`` NDJSON envelope on stdout for every verb
    # (read-only verbs via ``InvocationTrackedGroup``, mutating verbs via
    # ``output.emit``), so no separate local audit row is written.

    try:
        result = cli_func(standalone_mode=standalone_mode)
        return result if isinstance(result, int) else 0
    except KeyboardInterrupt:
        click.echo("Interrupted", err=True)
        return 130
    except click.ClickException as e:
        e.show()
        return e.exit_code
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 0
    except Exception as e:
        if debug:
            import traceback

            traceback.print_exc()
        else:
            _show_error(e)
        return 1


def _pop_debug_flag() -> bool:
    """Check for --debug flag or CLI_DEBUG env var."""
    if os.environ.get("CLI_DEBUG") == "1":
        return True
    if "--debug" in sys.argv:
        sys.argv.remove("--debug")
        return True
    return False


def _show_error(exc: Exception) -> None:
    """Print one-line error and write full traceback to temp file."""
    import traceback

    cli_name = Path(sys.argv[0]).name if sys.argv else "cli"
    click.echo(f"Error: {exc}", err=True)

    try:
        tb = traceback.format_exc()
        suffix = os.urandom(4).hex()
        path = Path(tempfile.gettempdir()) / f"{cli_name}-error-{suffix}.txt"
        path.write_text(tb)
        click.echo(f"Full error: {path}", err=True)
    except Exception:
        pass


__all__ = [
    "CleanGroup",
    "FormattedGroup",
    "agent_help_option",
    "atomic_write",
    "format_output",
    "json_dumps",
    "run_cli",
    "yaml_dump",
]
