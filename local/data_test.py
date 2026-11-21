"""Test the data where it is against the data contract, with the Data Contract CLI.

    python local/data_test.py <server> <contract.yaml> [<contract.yaml> ...]

`task data:test` (local/data.ts) writes one contract for each event that has
data, pointed at where that event's data is, and runs this once for them all
through uvx, at the CLI's pinned version. It is the CLI's own test, called
through its Python interface for one reason: its command line cannot be told
where AWS Emulator's certificate is, and a connection handed to it can.
"""

import importlib
import importlib.resources
import os
import pathlib
import sys

import click
import duckdb
from rich.console import Console

from datacontract.data_contract import DataContract
from datacontract.output.test_results_writer import write_test_result


def connection() -> "duckdb.DuckDBPyConnection":
    con = duckdb.connect()
    ca = os.environ.get("AWS_CA_BUNDLE")
    if os.environ.get("AWS_ENDPOINT_URL") and ca:
        # An emulator: DuckDB does not read AWS_CA_BUNDLE, so it is told. The
        # setting belongs to the extension that reads S3, which the CLI's s3
        # extra brings with it.
        version = con.sql("PRAGMA version").fetchone()[0]
        package = importlib.resources.files(importlib.import_module("duckdb_extension_httpfs"))
        extension = pathlib.Path(str(package)) / "extensions" / version / "httpfs.duckdb_extension"
        con.sql("LOAD '%s'" % str(extension).replace("'", "''"))
        con.sql("SET ca_cert_file='%s'" % ca.replace("'", "''"))
    return con


# The one thing the CLI says it cannot do yet: check a Parquet column's type.
# local/data.ts checks those itself, against the schema the contract gives, so
# a run whose only warnings are these has passed. Any other warning still fails.
UNSUPPORTED = "Checking types in parquet files is not supported yet"


def only_unsupported_parquet_types(run) -> bool:
    others = [check for check in run.checks if str(getattr(check.result, "value", check.result)) != "passed"]
    return bool(others) and all(
        str(getattr(check.result, "value", check.result)) == "warning" and UNSUPPORTED in (check.reason or "") for check in others
    )


def main() -> int:
    server, *contracts = sys.argv[1:]
    console = Console()
    failed = 0
    for contract in contracts:
        run = DataContract(data_contract_file=contract, server=server, duckdb_connection=connection()).test()
        try:
            write_test_result(run, console, None, None)
        except click.exceptions.Exit:
            pass
        if not (run.has_passed() or only_unsupported_parquet_types(run)):
            failed += 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
