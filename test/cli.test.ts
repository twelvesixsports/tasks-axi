import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, TOP_HELP } from "../src/cli.js";
import { FIXTURE } from "./helpers.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

function capture() {
  let out = "";
  return {
    stdout: { write: (chunk: string) => void (out += chunk) },
    read: () => out,
  };
}

function quoteSuggestionValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function decodedHelp(out: string): string[] {
  const decoded = decode(out) as { help?: unknown };
  expect(Array.isArray(decoded.help)).toBe(true);
  return decoded.help as string[];
}

let dir: string;
let path: string;
const savedFile = process.env.TASKS_AXI_FILE;
const savedCwd = process.cwd();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-cli-"));
  path = join(dir, "backlog.md");
  writeFileSync(path, FIXTURE, "utf8");
  process.env.TASKS_AXI_FILE = path;
});

afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
  if (savedFile === undefined) delete process.env.TASKS_AXI_FILE;
  else process.env.TASKS_AXI_FILE = savedFile;
  process.exitCode = undefined;
});

describe("CLI entrypoint", () => {
  it("prints top-level help", async () => {
    const c = capture();
    await main({ argv: ["--help"], stdout: c.stdout });
    expect(c.read()).toBe(TOP_HELP);
  });

  it.each(["-v", "-V", "--version"])("prints version for %s", async (flag) => {
    const c = capture();
    await main({ argv: [flag], stdout: c.stdout });
    expect(c.read()).toBe(`${pkg.version}\n`);
  });

  it("runs a verb against the env-resolved backlog", async () => {
    const c = capture();
    await main({ argv: ["list", "--state", "queued"], stdout: c.stdout });
    const out = c.read();
    expect(out).toContain("count:");
    expect(out).toContain("cert-cleanup");
    expect(() => decode(out)).not.toThrow();
  });

  it("treats the `task` noun as optional sugar", async () => {
    const c = capture();
    await main({ argv: ["task", "show", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("id: cert-cleanup");
  });

  it("honors aliases (view = show)", async () => {
    const c = capture();
    await main({ argv: ["view", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("id: cert-cleanup");
    expect(c.read()).not.toContain("location:");
  });

  it("finds an active record with --include-archive and reports its location", async () => {
    const c = capture();
    await main({
      argv: ["show", "cert-cleanup", "--include-archive"],
      stdout: c.stdout,
    });
    expect(c.read()).toContain("id: cert-cleanup");
    expect(c.read()).toContain("location: active");
  });

  it("finds an archived record with --include-archive and reports its location", async () => {
    process.chdir(dir);
    writeFileSync(
      join(dir, ".tasks.toml"),
      '[markdown]\narchive = "completed.md"\n',
    );
    writeFileSync(
      join(dir, "completed.md"),
      "\n## Archived 2026-07-01\n- [x] shipped-q1 - shipped work (repo: demo) (done 2026-06-30)\n  archived detail\n",
    );
    const c = capture();
    await main({
      argv: ["show", "shipped-q1", "--include-archive", "--full"],
      stdout: c.stdout,
    });
    expect(c.read()).toContain("id: shipped-q1");
    expect(c.read()).toContain("repo: demo");
    expect(c.read()).toContain("body: archived detail");
    expect(c.read()).toContain("location: archive");
  });

  it("reports a missing record after searching the active backlog and archive", async () => {
    const c = capture();
    await main({
      argv: ["show", "missing-q1", "--include-archive"],
      stdout: c.stdout,
    });
    expect(decode(c.read())).toMatchObject({
      error: 'Task "missing-q1" not found in this backlog',
      code: "NOT_FOUND",
    });
    expect(process.exitCode).toBe(1);
  });

  it("refuses an ambiguous archived lookup", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-01\n- [x] duplicate-q1 - first copy\n\n## Archived 2026-07-02\n- [x] duplicate-q1 - second copy\n",
    );
    const c = capture();
    await main({
      argv: ["show", "duplicate-q1", "--include-archive"],
      stdout: c.stdout,
    });
    expect(decode(c.read())).toMatchObject({
      error:
        'Task "duplicate-q1" is ambiguous: found 2 records across the active backlog and archive',
      code: "CONFLICT",
    });
    expect(process.exitCode).toBe(1);
  });

  it("keeps archived records hidden when --include-archive is absent", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-01\n- [x] archived-only-q1 - old work\n",
    );
    const c = capture();
    await main({ argv: ["show", "archived-only-q1"], stdout: c.stdout });
    expect(decode(c.read())).toMatchObject({ code: "NOT_FOUND" });
    expect(process.exitCode).toBe(1);
  });

  it("atomically adds an id absent from the backlog and archive", async () => {
    const c = capture();
    await main({
      argv: [
        "add",
        "fresh-anywhere-q1",
        "fresh task",
        "--refuse-if-present-anywhere",
      ],
      stdout: c.stdout,
    });
    expect(c.read()).toContain("ok: added fresh-anywhere-q1 -> Queued");
    expect(readFileSync(path, "utf8")).toContain("fresh-anywhere-q1");
  });

  it("refuses to add an id that already exists in the Done archive", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-01\n- [x] shipped-q1 - original record\n",
    );
    const before = readFileSync(path, "utf8");
    const c = capture();
    await main({
      argv: [
        "add",
        "shipped-q1",
        "replacement",
        "--refuse-if-present-anywhere",
      ],
      stdout: c.stdout,
    });
    expect(decode(c.read())).toMatchObject({
      error: 'Task "shipped-q1" already exists in the archive',
      code: "CONFLICT",
    });
    expect(process.exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses to add an active id with --refuse-if-present-anywhere", async () => {
    const before = readFileSync(path, "utf8");
    const c = capture();
    await main({
      argv: [
        "add",
        "cert-cleanup",
        "replacement",
        "--refuse-if-present-anywhere",
      ],
      stdout: c.stdout,
    });
    expect(decode(c.read())).toMatchObject({
      error: 'Task "cert-cleanup" already exists in the active backlog',
      code: "CONFLICT",
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("keeps add archive-unaware when the refusal flag is absent", async () => {
    writeFileSync(
      join(dir, "done-archive.md"),
      "\n## Archived 2026-07-01\n- [x] reused-q1 - old record\n",
    );
    const c = capture();
    await main({ argv: ["add", "reused-q1", "new record"], stdout: c.stdout });
    expect(c.read()).toContain("ok: added reused-q1 -> Queued");
    expect(readFileSync(path, "utf8")).toContain("reused-q1 - new record");
  });

  it("reports malformed task ids as validation errors", async () => {
    const c = capture();
    await main({ argv: ["show", "bad:id"], stdout: c.stdout });
    expect(c.read()).toContain("Invalid id");
    expect(process.exitCode).toBe(2);
  });

  it("performs a mutation end to end", async () => {
    const c = capture();
    await main({ argv: ["start", "cert-cleanup"], stdout: c.stdout });
    expect(c.read()).toContain("ok: start cert-cleanup -> In flight");
    // In-flight items render in firstmate's `- [ ]` checkbox form, under the
    // In flight header (the section, not the bullet, carries the state).
    expect(readFileSync(path, "utf8")).toMatch(
      /## In flight[\s\S]*- \[ \] cert-cleanup/,
    );
  });

  it("emits machine-readable JSON for a mutation with --json", async () => {
    const c = capture();
    await main({ argv: ["start", "cert-cleanup", "--json"], stdout: c.stdout });
    const parsed = JSON.parse(c.read()) as {
      ok: boolean;
      action: string;
      task: { id: string; state: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("start");
    expect(parsed.task.id).toBe("cert-cleanup");
    expect(parsed.task.state).toBe("in_flight");
    expect(process.exitCode).toBeFalsy();
  });

  it("rejects unknown mutation flags instead of shifting positionals", async () => {
    const c = capture();
    await main({
      argv: ["add", "--repoo", "demo", "real-id", "title"],
      stdout: c.stdout,
    });
    expect(c.read()).toContain("Unknown flag: --repoo");
    expect(process.exitCode).toBe(2);
    expect(readFileSync(path, "utf8")).not.toContain("- [ ] demo - real-id");
  });

  it("accepts a global --file after the command", async () => {
    const other = join(dir, "other backlog.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({ argv: ["list", "--file", other], stdout: c.stdout });
    const out = c.read();
    expect(out).toContain("solo-q1");
    expect(out).not.toContain("cert-cleanup");
    expect(decodedHelp(out)).toContain(
      `Run \`tasks-axi show <id> --file=${quoteSuggestionValue(other)}\` for full notes on a task`,
    );
  });

  it("carries explicit global backend and file flags into suggestions", async () => {
    const other = join(dir, "other backlog.md");
    writeFileSync(other, "# Backlog\n\n## Queued\n- [ ] solo-q1 - just me\n");
    const c = capture();
    await main({
      argv: ["list", "--backend", "markdown", "--file", other],
      stdout: c.stdout,
    });
    expect(decodedHelp(c.read())).toContain(
      `Run \`tasks-axi show <id> --backend=markdown --file=${quoteSuggestionValue(other)}\` for full notes on a task`,
    );
  });

  it("rejects a missing global flag value", async () => {
    const c = capture();
    await main({ argv: ["list", "--file", "--state"], stdout: c.stdout });
    expect(c.read()).toContain("--file requires a value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects an empty global --file without falling back to env config", async () => {
    const c = capture();
    await main({ argv: ["done", "cert-cleanup", "--file="], stdout: c.stdout });
    expect(c.read()).toContain("--file requires a value");
    expect(process.exitCode).toBe(2);
    expect(readFileSync(path, "utf8")).toContain("- [ ] cert-cleanup");
    expect(readFileSync(path, "utf8")).not.toContain("- [x] cert-cleanup");
  });

  it("rejects a whitespace global --backend value", async () => {
    const c = capture();
    await main({ argv: ["list", "--backend", "   "], stdout: c.stdout });
    expect(c.read()).toContain("--backend requires a value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects multiline global flag values", async () => {
    const c = capture();
    await main({ argv: ["list", "--file", "one\ntwo"], stdout: c.stdout });
    expect(c.read()).toContain("--file must be a single line");
    expect(process.exitCode).toBe(2);
  });

  it("renders config validation errors without a stack trace", async () => {
    writeFileSync(join(dir, ".tasks.toml"), "[markdown]\ndone_keep = -1\n");
    process.chdir(dir);
    const c = capture();
    await main({ argv: ["list"], stdout: c.stdout });
    expect(c.read()).toContain("markdown.done_keep");
    expect(c.read()).not.toContain("AxiError");
    expect(process.exitCode).toBe(2);
  });

  it("renders the home dashboard with no args", async () => {
    const c = capture();
    await main({ argv: [], stdout: c.stdout });
    const out = c.read();
    expect(out).toContain("bin:");
    expect(out).toContain("description:");
    expect(out).toContain("queued[");
    expect(() => decode(out)).not.toThrow();
  });

  it("errors on an unknown command", async () => {
    const c = capture();
    await main({ argv: ["frobnicate"], stdout: c.stdout });
    expect(c.read()).toContain("Unknown command");
    expect(process.exitCode).toBe(2);
  });

  it("returns per-command help with --help", async () => {
    const c = capture();
    await main({ argv: ["done", "--help"], stdout: c.stdout });
    expect(c.read()).toContain("usage: tasks-axi done");
  });

  it("returns focused help for a public-followup subcommand", async () => {
    const c = capture();
    await main({
      argv: ["public-followup", "work-event", "--help"],
      stdout: c.stdout,
    });
    expect(c.read()).toBe(
      "usage: tasks-axi public-followup work-event <id> --event-file <file> [--json]",
    );
  });

  it("creates and reads a durable public-followup through the CLI namespace", async () => {
    const requestPath = join(dir, "request.json");
    const expectedPath = join(dir, "expected.json");
    writeFileSync(
      requestPath,
      JSON.stringify({
        request_id: "req-cli-demo",
        platform: "discord",
        context_binding: { version: "ctx1", value: "ctx1_cli_demo" },
        public_safe_summary: "Post the public-safe CLI result",
        received_at: "2026-07-13T12:00:00Z",
        followup_expires_at: "2026-08-13T12:00:00Z",
        reservation_expires_at: "2026-09-13T12:00:00Z",
      }),
    );
    writeFileSync(
      expectedPath,
      JSON.stringify({
        type: "report-ready",
        project: "tasks-axi",
        required_deliverables: ["report_path"],
        completion_policy: "all-required",
      }),
    );

    const created = capture();
    await main({
      argv: [
        "public-followup",
        "add",
        "public-cli-q1",
        "--request-context-file",
        requestPath,
        "--purpose",
        "investigation-result",
        "--expected-final-file",
        expectedPath,
        "--expires-at",
        "2026-10-01T00:00:00Z",
        "--json",
      ],
      stdout: created.stdout,
    });
    expect(JSON.parse(created.read())).toMatchObject({
      ok: true,
      action: "public-followup.add",
      task: {
        id: "public-cli-q1",
        kind: "public-followup",
        public_followup: { schema_version: 1 },
      },
    });
    expect(readFileSync(path, "utf8")).toContain(
      "tasks-axi:public-followup/v1:",
    );

    const listed = capture();
    await main({
      argv: ["public-followup", "list", "--json"],
      stdout: listed.stdout,
    });
    expect(JSON.parse(listed.read())).toMatchObject({
      ok: true,
      count: 1,
      public_followups: [{ id: "public-cli-q1" }],
    });
  });
});
