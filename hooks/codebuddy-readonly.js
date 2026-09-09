#!/usr/bin/env node
// CodeBuddy PreToolUse hook: read-only policy. Prints a permissionDecision on stdout.
// Input on stdin: { tool_name, tool_input } (claude-code hook protocol).
const SAFE_CMDS = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "egrep", "fgrep", "find", "pwd", "echo", "printf",
  "wc", "file", "stat", "tree", "jq", "which", "whereis", "env", "printenv", "date", "uname",
  "basename", "dirname", "realpath", "readlink", "sort", "uniq", "diff", "comm", "tr", "cut",
  "awk", "sed", "column", "less", "more", "man", "tldr", "du", "df", "ps", "whoami", "id",
  "git", "gh", "node", "python3", "python", "bun", "npm", "npx", "tsc",
]);
const GIT_SUBCMDS_WRITE = /^(push|commit|add|rm|mv|checkout|reset|rebase|merge|pull|fetch|clone|init|config|tag|branch -[dD]|stash|apply|cherry-pick|revert|clean)\b/;
const DANGEROUS = /(^|\s)(rm|rmdir|mv|cp|chmod|chown|sudo|dd|mkfs|mount|umount|kill|killall|pkill|curl|wget|nc|ncat|ssh|scp|rsync|crontab|launchctl|brew|pip|pip3|gem|cargo|make|docker|kubectl|helm|terraform|ansible|systemctl|service|apt|apt-get|yum|dnf|pacman|nohup|xargs|eval|exec|source|\.)\s/;
const REDIRECT = /(>>?|<<<?|&>)/;

function decideBash(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return "deny";
  if (REDIRECT.test(cmd)) return "deny";
  if (/\$\(|`/.test(cmd)) return "deny"; // 命令替换里藏任何东西都不放行
  // 按 shell 操作符拆成子命令，每条单独判定（与 codebuddy 复合命令规则一致）
  const subs = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  if (subs.length === 0) return "deny";
  for (const sub of subs) {
    const first = sub.split(/\s+/)[0]?.replace(/^.*\//, ""); // /bin/ls -> ls
    if (!first || !SAFE_CMDS.has(first)) return "deny";
    if (first === "git" && GIT_SUBCMDS_WRITE.test(sub.split(/\s+/)[1] === "-C" ? sub.split(/\s+/)[3] ?? "" : sub.split(/\s+/).slice(1).join(" "))) return "deny";
    if (["node", "python3", "python", "bun"].includes(first) && /(-e|--eval|-c)\s/.test(sub)) return "deny"; // 内联代码可写文件
    if (["sed"].includes(first) && /(^|\s)-i(\s|$)/.test(sub)) return "deny"; // sed -i 是写
    if (["awk"].includes(first) && /system\(/.test(sub)) return "deny";
    if (first === "find" && /(^|\s)(-delete|-exec|-execdir)(\s|$)/.test(sub)) return "deny";
    if (DANGEROUS.test(sub)) return "deny";
  }
  return "allow";
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "TodoWrite", "TaskOutput", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let decision = "deny";
  try {
    const p = JSON.parse(input);
    const tool = p.tool_name ?? p.toolName ?? "";
    const ti = p.tool_input ?? p.toolInput ?? {};
    if (READ_TOOLS.has(tool)) decision = "allow";
    else if (WRITE_TOOLS.has(tool)) decision = "deny";
    else if (tool === "Bash") decision = decideBash(ti.command);
    else if (tool === "WebFetch") decision = "allow"; // 只读网络抓取
  } catch { /* 解析失败保守 deny */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } }));
});
