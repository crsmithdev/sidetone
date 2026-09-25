import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { ASK_RULES, gatedAction } from "../src/gated.ts";

const PROJECT = "/home/chris/project";
const bash = (command: string) => gatedAction("Bash", { command, description: "" }, PROJECT);

/**
 * 10.7 the four actions of the agent that need the agreement word. Every
 * other request is let through (6.3), so a miss here is an action that runs
 * without a word: the forms below are the ones measured on 24 September.
 */
describe("a force push (10.7.1)", () => {
  test.each([
    ["git push --force origin main", "The agent wants to force push to origin main."],
    ["git push origin main --force-with-lease", "The agent wants to force push to origin main."],
    ["git push -f origin main", "The agent wants to force push to origin main."],
    ["git push -uf origin main", "The agent wants to force push to origin main."],
    ["git push origin +main", "The agent wants to force push to origin main."],
    ["git push --force-with-lease=main:abc origin HEAD:main", "The agent wants to force push to origin main."],
    ["git push --force", "The agent wants to force push."],
    ["echo start && git push --force origin main", "The agent wants to force push to origin main."],
    ["git -C /tmp/x push -f origin main", "The agent wants to force push to origin main."],
  ])("%s", (command, readback) => {
    expect(bash(command)).toBe(readback);
  });
});

describe("a remote branch delete (10.7.2)", () => {
  test.each([
    ["git push origin --delete side", "The agent wants to delete the branch side on origin."],
    ["git push origin -d side other", "The agent wants to delete the branches side and other on origin."],
    ["git push origin :side", "The agent wants to delete the branch side on origin."],
    ["git push origin :refs/heads/side", "The agent wants to delete the branch side on origin."],
    ["git push --prune origin", "The agent wants to delete remote branches on origin."],
    ["git push --mirror backup", "The agent wants to delete remote branches on backup."],
  ])("%s", (command, readback) => {
    expect(bash(command)).toBe(readback);
  });
});

describe("rm -rf outside the project (10.7.3)", () => {
  test.each([
    ["rm -rf /tmp/junk", "The agent wants to delete /tmp/junk and everything in it."],
    ["rm -r -f ../other", "The agent wants to delete /home/chris/other and everything in it."],
    ["rm -fr /a /b", "The agent wants to delete /a and /b and everything in them."],
    ["rm --recursive --force /tmp/x", "The agent wants to delete /tmp/x and everything in it."],
    ["true; rm -rf /tmp/junk", "The agent wants to delete /tmp/junk and everything in it."],
    ["cd /tmp && rm -rf junk", "The agent wants to delete /tmp/junk and everything in it."],
    ["sudo rm -rf /var/x", "The agent wants to delete /var/x and everything in it."],
    ["rm -rf ~/notes", `The agent wants to delete ${homedir()}/notes and everything in it.`],
    ['rm -rf "$DIR"', "The agent wants to delete $DIR and everything in it."],
    ["rm -rf .", `The agent wants to delete ${PROJECT} and everything in it.`],
  ])("%s", (command, readback) => {
    expect(bash(command)).toBe(readback);
  });
});

describe("a drop or truncate of a database (10.7.4)", () => {
  test.each([
    [`psql prod -c "DROP DATABASE shop"`, "The agent wants to run DROP DATABASE shop."],
    [`sqlite3 prod.db "drop table if exists users"`, "The agent wants to run DROP TABLE IF EXISTS users."],
    [`psql -c 'TRUNCATE TABLE orders'`, "The agent wants to run TRUNCATE TABLE orders."],
    [`bun -e 'db.run("DROP TABLE users")'`, "The agent wants to run DROP TABLE users."],
    ["dropdb shop", "The agent wants to drop the database shop."],
  ])("%s", (command, readback) => {
    expect(bash(command)).toBe(readback);
  });
});

describe("a gated action inside another command (10.7.5)", () => {
  test.each([
    [`bash -c "rm -rf /tmp/junk"`, "The agent wants to delete /tmp/junk and everything in it."],
    [`sh -c 'git push --force origin main'`, "The agent wants to force push to origin main."],
    [`bash -lc "cd /tmp && rm -rf junk"`, "The agent wants to delete /tmp/junk and everything in it."],
    [`eval "rm -rf /tmp/junk"`, "The agent wants to delete /tmp/junk and everything in it."],
    ["echo $(rm -rf /tmp/junk)", "The agent wants to delete /tmp/junk and everything in it."],
    ["echo `git push -f origin main`", "The agent wants to force push to origin main."],
    [`x="$(cd /tmp; rm -rf junk)"`, "The agent wants to delete /tmp/junk and everything in it."],
    [`bash -c "echo \\$(rm -rf /tmp/junk)"`, "The agent wants to delete /tmp/junk and everything in it."],
    ["echo /tmp/junk | xargs rm -rf", "The agent wants to run rm -rf on each path that xargs reads."],
    ["ls | xargs -n 1 -I{} rm -r -f {}", "The agent wants to run rm -rf on each path that xargs reads."],
    [`ls | xargs sh -c 'git push -f origin main'`, "The agent wants to force push to origin main."],
    ["find /tmp/junk -delete", "The agent wants to delete what find matches in /tmp/junk."],
    ["find /tmp/a ../b -name '*.log' -delete", "The agent wants to delete what find matches in /tmp/a and /home/chris/b."],
    ["find /tmp -name junk -exec rm -rf {} +", "The agent wants to delete what find matches in /tmp."],
    ["find -L /tmp -name junk -execdir rm -fr {} \;", "The agent wants to delete what find matches in /tmp."],
    [`find /tmp -exec sh -c 'rm -rf "$1"' _ {} \;`, "The agent wants to delete $1 and everything in it."],
    [`sqlite3 prod.db "Drop table users"`, "The agent wants to run DROP TABLE users."],
  ])("%s", (command, readback) => {
    expect(bash(command)).toBe(readback);
  });
});

describe("a command the bridge cannot read is gated (10.7.6)", () => {
  const unreadable = "The agent wants to run a command that the bridge cannot read.";
  test.each([
    `bash -c "$CMD"`,
    `eval "$(cat script)"`,
    "bash -c",
    `sh -c 'rm -rf /tmp/junk`,
    "echo $(rm -rf /tmp/junk",
    "echo `rm -rf /tmp/junk",
    "$(which rm) -rf /tmp/junk",
  ])("%s", (command) => {
    expect(bash(command)).toBe(unreadable);
  });
});

describe("everything else is not gated (6.3)", () => {
  test.each([
    "git push origin main",
    "git push -u origin feature/x",
    "git push --follow-tags origin main",
    "rm tmpfile",
    "rm -rf build",
    "rm -rf ./node_modules /home/chris/project/dist",
    "rm -f /tmp/one-file",
    "truncate -s 0 log.txt",
    "ls",
    "echo 'rm -rf is dangerous'",
    `bash -c "rm -rf build"`,
    "bash scripts/build.sh",
    `sh -c 'git push origin main'`,
    "echo '$(rm -rf /tmp/junk)'",
    "echo $(git rev-parse HEAD)",
    "find . -name '*.ts'",
    "find /tmp -name junk",
    "find build -delete",
    "find . -name '*.orig' -exec rm -f {} +",
    "find /tmp -name junk -exec ls {} +",
    "ls | xargs grep drop",
    "ls | xargs rm",
    `git commit -m "Drop the old flag"`,
  ])("%s", (command) => {
    expect(bash(command)).toBeNull();
  });

  test("a tool other than Bash", () => {
    expect(gatedAction("Write", { file_path: "/etc/passwd", content: "" }, PROJECT)).toBeNull();
    expect(gatedAction("Bash", {}, PROJECT)).toBeNull();
  });
});

/**
 * The ask rules decide what reaches the bridge at all. Measured 24 September
 * on 2.1.282: with the first rules, a force push, both remote deletes, both rm
 * forms, a DROP inside a quoted script, a compound command, `$(...)`, a
 * backtick and `xargs rm -rf` each sent can_use_tool, and `ls` did not.
 * `bash -c`, `sh -c`, `eval`, `find -delete`, `find -exec rm -rf` and a
 * `Drop table` did not: the rules match case, and they do not look inside a
 * shell string. The rules for those are below.
 */
test("the ask rules cover every command the four start with", () => {
  expect(ASK_RULES).toEqual(expect.arrayContaining([
    "Bash(git push *)", "Bash(rm *)", "Bash(*DROP *)", "Bash(dropdb *)",
    "Bash(bash *)", "Bash(sh *)", "Bash(eval *)", "Bash(xargs *)", "Bash(find *)", "Bash(*Drop *)", "Bash(*Truncate *)",
  ]));
});
