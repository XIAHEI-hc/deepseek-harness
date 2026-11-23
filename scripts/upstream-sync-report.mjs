#!/usr/bin/env node
/**
 * Report how far a fork's target branch trails its upstream, which upstream commits are
 * new, and where a trial merge would conflict — the entry point a scheduled check runs
 * before deciding whether to open a sync branch.
 *
 * The report never writes into the checked-out branch: the trial merge runs through
 * `git merge-tree`, so no worktree, index, or ref is touched.
 *
 * Usage:
 *   node scripts/upstream-sync-report.mjs [options]
 *
 * Options:
 *   --repo <path>     checkout to inspect; defaults to this script's repository
 *   --remote <name>   upstream remote name; defaults to `upstream`
 *   --branch <name>   upstream branch; defaults to `master`
 *   --target <ref>    local target ref; defaults to `HEAD`
 *   --no-fetch        skip `git fetch` and report from existing remote-tracking refs
 *   --out <path>      markdown report path; defaults to
 *                     `.artifacts/upstream-sync/latest.md`
 *   --json            print one JSON result on stdout instead of the text summary
 *
 * Exit codes: 0 target is current, 10 upstream commits await a clean merge, 11 upstream
 * commits await a merge with text conflicts, 2 the check could not run.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaults = { remote: 'upstream', branch: 'master', target: 'HEAD' }

/**
 * Run one git command in the inspected checkout.
 * @param {string} repo - absolute checkout root.
 * @param {string[]} args - git arguments without the program name.
 * @param {{ allowFailure?: boolean }} [options] - return stdout on a nonzero exit.
 * @returns {{ status: number, stdout: string, stderr: string }} command result.
 */
function git(repo, args, options = {}) {
  try {
    const stdout = execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const status = typeof error.status === 'number' ? error.status : 1
    if (!options.allowFailure) {
      const stderr = error.stderr?.toString().trim() ?? ''
      throw new Error(`git ${args.join(' ')} failed (${status}): ${stderr}`)
    }
    return { status, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' }
  }
}

/**
 * Parse command-line options.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string | boolean>} parsed options.
 */
function parseArguments(argv) {
  const options = { ...defaults, fetch: true, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') { options.json = true; continue }
    if (argument === '--no-fetch') { options.fetch = false; continue }
    if (argument.startsWith('--')) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`unexpected argument: ${argument}`)
  }
  return options
}

/**
 * Turn a git remote URL into the browsable repository base URL.
 * @param {string} url - `git@github.com:owner/repo.git` or an https URL.
 * @returns {string | undefined} `https://github.com/owner/repo` when the host is GitHub.
 */
function browsableBase(url) {
  const match = url.trim().match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    ?? url.trim().match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (match === null) return undefined
  const [, host, owner, repository] = match
  return host === 'github.com' ? `https://github.com/${owner}/${repository}` : undefined
}

/**
 * Split `git merge-tree --write-tree --name-only` output into its conflicted paths.
 * @param {string} stdout - merge-tree stdout; the first line is the merged tree id and a
 *   blank line separates conflicted paths from informational messages.
 * @returns {string[]} conflicted repository-relative paths.
 */
function conflictedPaths(stdout) {
  const lines = stdout.split('\n')
  const paths = []
  for (const line of lines.slice(1)) {
    if (line === '') break
    paths.push(line)
  }
  return paths
}

/**
 * Read the commits on one side that touched a path.
 * @param {string} repo - checkout root.
 * @param {string} range - `<base>..<side>`.
 * @param {string} path - repository-relative path.
 * @returns {string[]} up to three `short-sha subject` lines.
 */
function commitsFor(repo, range, path) {
  const output = git(repo, ['log', '--format=%h %s', '-n', '3', range, '--', path], { allowFailure: true }).stdout
  return output.split('\n').filter(line => line.trim() !== '')
}

/**
 * Count changed paths per side between the merge base and each tip.
 * @param {string} repo - checkout root.
 * @param {string} range - `<base>..<side>`.
 * @returns {string[]} changed repository-relative paths.
 */
function changedPaths(repo, range) {
  return git(repo, ['diff', '--name-only', '-M', range], { allowFailure: true }).stdout.split('\n').filter(line => line !== '')
}

/**
 * Render the markdown report.
 * @param {object} model - collected facts.
 * @returns {string} markdown document.
 */
function renderReport(model) {
  const { target, upstream, mergeBase, ahead, behind, conflicts, overlapping, commits, base, generatedAt } = model
  const lines = [
    '# Upstream sync report',
    '',
    `Generated ${generatedAt} from \`${model.repo}\`.`,
    '',
    '| Fact | Value |',
    '|---|---|',
    `| Target ref | \`${target.ref}\` at \`${target.sha}\` |`,
    `| Upstream ref | \`${upstream.ref}\` at \`${upstream.sha}\` |`,
    `| Merge base | \`${mergeBase}\` |`,
    `| Fork-only commits | ${ahead} |`,
    `| New upstream commits | ${behind} |`,
    `| Trial merge | ${conflicts.length === 0 ? 'clean' : `${conflicts.length} text conflict(s)`} |`,
    '',
  ]
  if (behind === 0) {
    lines.push('The target branch already contains every upstream commit; nothing to sync.', '')
    return lines.join('\n')
  }
  lines.push(`## New upstream commits (${behind})`, '')
  for (const commit of commits) {
    const link = base === undefined ? commit.sha : `[${commit.sha}](${base}/commit/${commit.fullSha})`
    lines.push(`- ${link} ${commit.subject}`)
  }
  if (behind > commits.length) lines.push(`- … ${behind - commits.length} more; run \`git log ${target.ref}..${upstream.ref}\` for the rest`)
  lines.push('')
  if (conflicts.length > 0) {
    lines.push(`## Text conflicts (${conflicts.length})`, '', '| Path | Fork commits | Upstream commits |', '|---|---|---|')
    for (const path of conflicts) {
      const forkSide = commitsFor(model.repo, `${mergeBase}..${target.ref}`, path).join('<br>') || '—'
      const upstreamSide = commitsFor(model.repo, `${mergeBase}..${upstream.ref}`, path).join('<br>') || '—'
      lines.push(`| \`${path}\` | ${forkSide} | ${upstreamSide} |`)
    }
    lines.push('')
  }
  if (overlapping.length > 0) {
    lines.push(`## Both sides changed (${overlapping.length}, semantic risk)`, '')
    for (const path of overlapping) lines.push(`- \`${path}\``)
    lines.push('')
  }
  lines.push('## Next steps', '',
    '```sh',
    `git worktree add ../dsh-sync-<date> -b sync/dsh-upstream-<date> ${target.ref}`,
    `cd ../dsh-sync-<date> && git merge --no-commit --no-ff ${upstream.ref}`,
    'git diff --name-only --diff-filter=U',
    '```', '')
  return lines.join('\n')
}

/**
 * Collect the facts for one report.
 * @param {Record<string, string | boolean>} options - parsed options.
 * @returns {object} report model.
 */
function collect(options) {
  const repo = resolve(String(options.repo ?? fileURLToPath(new URL('..', import.meta.url))))
  const remote = String(options.remote)
  const branch = String(options.branch)
  const targetRef = String(options.target)
  const targetSha = git(repo, ['rev-parse', targetRef]).stdout.trim()
  const remoteUrl = git(repo, ['remote', 'get-url', remote], { allowFailure: true }).stdout.trim()
  if (remoteUrl === '') throw new Error(`remote '${remote}' is not configured; add the upstream repository first`)
  if (options.fetch !== false) git(repo, ['fetch', '--prune', remote, branch])
  const upstreamRef = `${remote}/${branch}`
  const upstreamSha = git(repo, ['rev-parse', upstreamRef]).stdout.trim()
  const mergeBase = git(repo, ['merge-base', targetRef, upstreamRef]).stdout.trim()
  const ahead = Number(git(repo, ['rev-list', '--count', `${upstreamRef}..${targetRef}`]).stdout.trim())
  const behind = Number(git(repo, ['rev-list', '--count', `${targetRef}..${upstreamRef}`]).stdout.trim())
  const commits = behind === 0 ? [] : git(repo, ['log', '--format=%h\t%H\t%s', '-n', '200', `${targetRef}..${upstreamRef}`])
    .stdout.split('\n').filter(line => line !== '')
    .map(line => { const [sha, fullSha, ...subject] = line.split('\t'); return { sha, fullSha, subject: subject.join('\t') } })
  const tree = git(repo, ['merge-tree', '--write-tree', '--name-only', targetRef, upstreamRef], { allowFailure: true })
  const conflicts = behind === 0 ? [] : conflictedPaths(tree.stdout)
  const overlapping = behind === 0 ? [] : changedPaths(repo, `${mergeBase}..${targetRef}`)
    .filter(path => new Set(changedPaths(repo, `${mergeBase}..${upstreamRef}`)).has(path))
  return {
    repo, generatedAt: new Date().toISOString(), base: browsableBase(remoteUrl),
    target: { ref: targetRef, sha: targetSha }, upstream: { ref: upstreamRef, sha: upstreamSha },
    mergeBase, ahead, behind, conflicts, overlapping, commits,
  }
}

try {
  const options = parseArguments(process.argv.slice(2))
  const model = collect(options)
  const report = renderReport(model)
  const out = resolve(model.repo, String(options.out ?? '.artifacts/upstream-sync/latest.md'))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, report)
  const exitCode = model.behind === 0 ? 0 : model.conflicts.length === 0 ? 10 : 11
  if (options.json) {
    console.log(JSON.stringify({
      repo: model.repo, target: model.target, upstream: model.upstream, mergeBase: model.mergeBase,
      ahead: model.ahead, behind: model.behind, conflicts: model.conflicts,
      overlapping: model.overlapping, report: out, exitCode,
    }))
  } else {
    console.log(`upstream-sync: ${model.behind} new commit(s), ${model.conflicts.length} conflict(s), ${model.overlapping.length} overlapping path(s); report ${out}`)
  }
  process.exitCode = exitCode
} catch (error) {
  console.error(`upstream-sync: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
